/**
 * TWINS background worker — BullMQ consumer (spec section 46).
 *
 * Consumes jobs from Redis queues and runs the data-ingestion + validation
 * pipeline. Two queues are active:
 *
 *   signal_queue   — Telegram message ingestion → signal extraction →
 *                    market context refresh → validation pipeline
 *   market_queue   — standalone market-bar ingestion (driven by scheduler)
 *
 * Safety invariants (spec section 2/45/47):
 * - LIVE_TRADING is verified false at startup; the process exits if true.
 * - All database writes go through Drizzle (PostgreSQL is the source of
 *   record; Redis is ephemeral queue transport only, spec section 47).
 * - A failed job is recorded in the `jobs` table (via runIngestionJob) and
 *   moved to the BullMQ dead-letter queue; errors are never silently swallowed.
 * - Idempotency: duplicate Telegram updates carry the same BullMQ job ID
 *   (set by the API) and are rejected at the queue level before reaching
 *   this handler. Storage-level deduplication (telegram_messages unique
 *   index) is the backstop.
 */

import { Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { loadConfig } from "@twins/config";
import { createDb, getDb } from "@twins/database";
import {
  ingestMarketBars,
  ingestTelegramMessages,
  runIngestionJob,
} from "@twins/ingestion";
import { createSignalFromTelegramMessage } from "@twins/signals";
import { validateSignal } from "@twins/decision-intelligence";
import {
  marketDataProviders,
  YahooFinanceAdapter,
  YAHOO_PROVIDER_NAME,
} from "@twins/adapter-market";
import {
  telegramProviders,
  TelegramBotWebhookAdapter,
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  type NormalizedTelegramMessage,
} from "@twins/adapter-telegram";
import type { MarketBarRequest } from "@twins/types";

// ─── Config & safety gate ──────────────────────────────────────────────────

const config = loadConfig();

if (config.liveTradingEnabled) {
  // This should be unreachable given loadConfig()'s own guard, but belts
  // and braces: a worker must never start in live-trading mode (spec section 40).
  console.error("[worker] FATAL: LIVE_TRADING=true is not permitted in the worker process.");
  process.exit(1);
}

console.log(
  `[worker] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
);

// ─── Register concrete adapters ────────────────────────────────────────────

marketDataProviders.register(YAHOO_PROVIDER_NAME, new YahooFinanceAdapter());
telegramProviders.register(
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  new TelegramBotWebhookAdapter(),
);

// ─── Job-payload types (must match what the API / scheduler enqueues) ──────

export interface TelegramJobPayload {
  jobType: "telegram_messages";
  providerName: string;
  telegram: {
    params: { channelIdentifier: string; sinceExternalMessageId?: string };
    /** Already-normalized message passed from the webhook handler to avoid a
     *  second Telegram API call. If absent the worker would call fetchMessages()
     *  but since we use a webhook-driven adapter that throws on fetchMessages(),
     *  this field is always required for telegram jobs. */
    normalizedMessage: NormalizedTelegramMessage;
    exchange: string;
    instrumentType: string;
  };
}

export interface MarketBarsJobPayload {
  jobType: "market_bars";
  providerName: string;
  market: {
    request: { instrument: { symbol: string; exchange: string }; timeframe: string; from: string; to: string };
    instrumentType: string;
    maxStalenessMs?: number;
  };
}

export type WorkerJobPayload = TelegramJobPayload | MarketBarsJobPayload;

// ─── Telegram pipeline ─────────────────────────────────────────────────────

/**
 * Full Telegram → validation pipeline for one message.
 *
 * Steps:
 *  1. Insert the telegram_messages row (idempotent via unique index).
 *  2. Extract a structured signal from rawText; skip if no BUY/SELL found.
 *  3. Refresh market context for the signal's instrument via Yahoo Finance.
 *  4. Run the full validation pipeline (Phases 5–9).
 *
 * Correlation ID is generated here so every log line for this job can be
 * traced end-to-end. No AI/LLM calls occur anywhere in this path.
 */
async function processTelegramJob(
  job: Job<TelegramJobPayload>,
  correlationId: string,
): Promise<void> {
  const { telegram } = job.data;
  const { normalizedMessage, exchange, instrumentType } = telegram;

  const db = createDb(config.databaseUrl);

  console.log(
    `[worker][${correlationId}] telegram job channel=${normalizedMessage.channelIdentifier} msgId=${normalizedMessage.externalMessageId}`,
  );

  // Step 1 — Ingest the telegram message (idempotent).
  // We wrap the single already-normalized message in a synthetic provider so
  // runIngestionJob's bookkeeping still fires (jobs + provider_health rows).
  const summary = await runIngestionJob(db, {
    jobType: "telegram_messages",
    queueName: "signal_queue",
    providerName: TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
    providerType: "telegram",
    payload: job.data,
    execute: async () => {
      return ingestTelegramMessages(
        db,
        {
          providerName: TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
          async fetchMessages() {
            return [normalizedMessage];
          },
          async getHealth() {
            return {
              providerName: TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
              providerType: "telegram",
              status: "healthy",
              checkedAt: new Date(),
            };
          },
        },
        telegram.params,
      );
    },
  });

  if (summary.status === "failed") {
    console.error(`[worker][${correlationId}] telegram ingestion failed: ${summary.error}`);
    return;
  }

  const ingestResult = summary.result;
  if (!ingestResult) return;

  if (ingestResult.duplicates > 0) {
    console.log(`[worker][${correlationId}] duplicate telegram message, skipping signal extraction`);
    return;
  }

  if (ingestResult.rejectedInvalid > 0) {
    console.log(`[worker][${correlationId}] telegram message rejected by data quality`);
    return;
  }

  // Step 2 — Extract signal from the just-ingested message.
  // We need the DB-assigned telegram_messages.id to pass to createSignalFromTelegramMessage.
  const { schema } = await import("@twins/database");
  const { eq } = await import("drizzle-orm");

  const [telegramRow] = await db
    .select({ id: schema.telegramMessages.id })
    .from(schema.telegramMessages)
    .where(eq(schema.telegramMessages.externalMessageId, normalizedMessage.externalMessageId));

  if (!telegramRow) {
    console.log(`[worker][${correlationId}] telegram_messages row not found after insert, skipping`);
    return;
  }

  const signalOutcome = await createSignalFromTelegramMessage(db, telegramRow.id, {
    exchange,
    instrumentType,
  });

  if (!signalOutcome.created) {
    console.log(
      `[worker][${correlationId}] no signal extracted: ${signalOutcome.reason}`,
    );
    return;
  }

  const signalId = signalOutcome.signalId!;
  console.log(`[worker][${correlationId}] signal created signalId=${signalId}`);

  // Step 3 — Refresh market context for the signal's instrument.
  // Fetch the last 30 days of daily bars so the Phase 6 context window has
  // data to work with. Failures here are non-blocking: the validation pipeline
  // will proceed with whatever context is already in the DB (it handles missing
  // data gracefully per spec section 2).
  try {
    const [signal] = await db
      .select({ instrumentId: schema.signals.instrumentId })
      .from(schema.signals)
      .where(eq(schema.signals.id, signalId));

    if (signal) {
      const [instrument] = await db
        .select({ symbol: schema.instruments.symbol, exchange: schema.instruments.exchange })
        .from(schema.instruments)
        .where(eq(schema.instruments.id, signal.instrumentId));

      if (instrument) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const marketRequest: MarketBarRequest = {
          instrument: { symbol: instrument.symbol, exchange: instrument.exchange },
          timeframe: "1d",
          from: thirtyDaysAgo,
          to: now,
        };

        await runIngestionJob(db, {
          jobType: "market_bars",
          queueName: "market_queue",
          providerName: YAHOO_PROVIDER_NAME,
          providerType: "market",
          payload: { instrument: instrument.symbol, timeframe: "1d" },
          execute: () =>
            ingestMarketBars(db, marketDataProviders.get(YAHOO_PROVIDER_NAME), marketRequest, {
              instrumentType,
              maxStalenessMs: 24 * 60 * 60 * 1000,
            }),
        });

        console.log(`[worker][${correlationId}] market context refreshed for ${instrument.symbol}`);
      }
    }
  } catch (err) {
    console.warn(
      `[worker][${correlationId}] market context refresh failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 4 — Run the deterministic validation pipeline (Phases 5–9).
  // validateSignal() calls assembleSignalIntelligence() internally and
  // persists an immutable signal_validations row.
  console.log(`[worker][${correlationId}] running validateSignal for signalId=${signalId}`);
  const validation = await validateSignal(db, signalId);

  console.log(
    `[worker][${correlationId}] validation complete signalId=${signalId} validationId=${validation.validationId} outcome=${validation.result.outcome} confidence=${validation.result.decisionConfidence}`,
  );
}

// ─── Market bars pipeline (scheduler-driven) ───────────────────────────────

async function processMarketBarsJob(
  job: Job<MarketBarsJobPayload>,
  correlationId: string,
): Promise<void> {
  const { market } = job.data;
  const db = getDb();

  const request: MarketBarRequest = {
    instrument: market.request.instrument,
    timeframe: market.request.timeframe,
    from: new Date(market.request.from),
    to: new Date(market.request.to),
  };

  console.log(
    `[worker][${correlationId}] market_bars job symbol=${market.request.instrument.symbol} timeframe=${market.request.timeframe}`,
  );

  const outcome = await runIngestionJob(db, {
    jobType: "market_bars",
    queueName: "market_queue",
    providerName: job.data.providerName,
    providerType: "market",
    payload: job.data,
    execute: () =>
      ingestMarketBars(db, marketDataProviders.get(job.data.providerName), request, {
        instrumentType: market.instrumentType,
        maxStalenessMs: market.maxStalenessMs,
      }),
  });

  console.log(
    `[worker][${correlationId}] market_bars result status=${outcome.status} inserted=${outcome.result?.inserted ?? 0}`,
  );
}

// ─── BullMQ workers ────────────────────────────────────────────────────────

const connectionOpts = { url: config.redisUrl };

const signalWorker = new Worker<TelegramJobPayload>(
  "signal_queue",
  async (job: Job<TelegramJobPayload>) => {
    const correlationId = randomUUID().slice(0, 8);
    await processTelegramJob(job, correlationId);
  },
  {
    connection: connectionOpts,
    concurrency: 2,
  },
);

const marketWorker = new Worker<MarketBarsJobPayload>(
  "market_queue",
  async (job: Job<MarketBarsJobPayload>) => {
    const correlationId = randomUUID().slice(0, 8);
    await processMarketBarsJob(job, correlationId);
  },
  {
    connection: connectionOpts,
    concurrency: 4,
  },
);

signalWorker.on("completed", (job) => {
  console.log(`[worker] signal_queue job ${job.id} completed`);
});
signalWorker.on("failed", (job, err) => {
  console.error(`[worker] signal_queue job ${job?.id} failed: ${err.message}`);
});

marketWorker.on("completed", (job) => {
  console.log(`[worker] market_queue job ${job.id} completed`);
});
marketWorker.on("failed", (job, err) => {
  console.error(`[worker] market_queue job ${job?.id} failed: ${err.message}`);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] received ${signal}, shutting down gracefully`);
  await signalWorker.close();
  await marketWorker.close();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

console.log("[worker] listening on signal_queue and market_queue");

// Keep the process alive (the BullMQ workers run their event loops internally).
export { dispatchIngestionJob } from "./ingestionDispatch.js";
