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
 * - The shared live-trading guard (@twins/config) runs first; the process exits if live trading is configured.
 * - All database writes go through Drizzle (PostgreSQL is the source of
 *   record; Redis is ephemeral queue transport only, spec section 47).
 * - A failed job is recorded in the `jobs` table (via runIngestionJob) and
 *   moved to the BullMQ dead-letter queue; errors are never silently swallowed.
 * - Idempotency: duplicate Telegram updates carry the same BullMQ job ID
 *   (set by the API) and are rejected at the queue level before reaching
 *   this handler. Storage-level deduplication (telegram_messages unique
 *   index) is the backstop.
 */

import { UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createStructuredLogger, describeErrorSafely, type StructuredLogger } from "@twins/shared";
import { buildJobLogContext } from "./correlationLog.js";
import { InvalidJobInputError, ReconciliationRequiredError } from "./jobErrors.js";
import { parseJobTimestamp } from "./jobTimestamp.js";
import { parseCapture, processTelegramEventsJob, type CapturePayload, type TelegramEventsJobPayload } from "./telegramEvents.js";
import { randomUUID } from "node:crypto";
import { enforceLiveTradingGuard, loadConfig } from "@twins/config";
import { createBoundedDb, type Db } from "@twins/database";
import {
  getRevisionStates,
  ingestMarketBars,
  ingestTelegramMessages,
  recordCaptureEvent,
  resolveTelegramSource,
  runIngestionJob,
} from "@twins/ingestion";
import { analyzeTelegramText, assessOptionsClaim, createManualReferenceContractMaster, createProviderSnapshotContractMaster, parseProviderSnapshotFile, createSignalFromTelegramMessage, parseManualReferenceFile, recordOptionsIntake, unconfiguredContractMaster, unavailablePremiumProvider, TELEGRAM_PARSER_VERSION, type OptionsContractMaster } from "@twins/signals";
import { readFileSync } from "node:fs";
import { findValidationByKey, validateSignal } from "@twins/decision-intelligence";
import {
  marketDataProviders,
  YahooFinanceAdapter,
  YAHOO_PROVIDER_NAME,
} from "@twins/adapter-market";
import {
  telegramProviders,
  TelegramBotWebhookAdapter,
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  chatIdOfQueuedMessage,
  textSha256Hex,
  USER_CAPTURE_PROVIDER_NAME,
  loadTelegramIntakePolicy,
  type NormalizedTelegramMessage,
  type TelegramIntakePolicy,
} from "@twins/adapter-telegram";
import type { MarketBarRequest } from "@twins/types";

// ─── Config & safety gate ──────────────────────────────────────────────────

enforceLiveTradingGuard("worker");
const config = loadConfig();

console.log(
  `[worker] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
);

// ─── Process-owned bounded database lifecycle (audit REL-01 / CORE-01) ─────
// Bounded connection pool sized for worker concurrency (2 signal + 4 market + headroom).
// Dedicated close() drains the pool gracefully on shutdown.
export const workerDb = createBoundedDb({
  max: 10,
  idleTimeoutMillis: 30000,
});

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
  /**
   * End-to-end correlation LOG metadata minted at intake. Optional: jobs queued before this field
   * existed have none and are processed normally (a worker-generated id is used and flagged).
   * Never a deduplication key.
   */
  correlation?: { correlationId: string; requestId: string; receivedAt: string };
  telegram: {
    params: { channelIdentifier: string; sinceExternalMessageId?: string };
    /** Already-normalized message passed from the webhook handler to avoid a
     *  second Telegram API call. If absent the worker would call fetchMessages()
     *  but since we use a webhook-driven adapter that throws on fetchMessages(),
     *  this field is always required for telegram jobs. */
    normalizedMessage: NormalizedTelegramMessage;
    exchange: string;
    instrumentType: string;
    /**
     * Provenance of a read-only User API capture (live or history). ABSENT on the original Bot API webhook jobs, which
     * follow their existing path unchanged.
     */
    capture?: CapturePayload;
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

/** Everything the signal queue can carry: message jobs (Bot API or User API capture) and observed-deletion event jobs. */
export type SignalQueueJobPayload = TelegramJobPayload | TelegramEventsJobPayload;
export type WorkerJobPayload = SignalQueueJobPayload | MarketBarsJobPayload;

// ─── Queue boundary ────────────────────────────────────────────────────────

/**
 * Queue-processing boundary for telegram jobs. Only permanent invalid input
 * (InvalidJobInputError) is translated into BullMQ's UnrecoverableError, which
 * fails the job immediately without consuming remaining attempts. Every other
 * error propagates unchanged so normal attempts/backoff apply. The message
 * carries only the job id and external message id - no payload or secrets.
 */
export interface TelegramJobOptions {
  /** Contract master for options assessments (tests inject one). Default: the explicitly configured one, else NONE. */
  optionsMaster?: OptionsContractMaster;
  /** Structured logger (tests inject a capture sink). Defaults to JSON lines on the console. */
  logger?: StructuredLogger;
  /**
   * Which chats may be ingested and whether only options messages may proceed. Default: the policy read from
   * TWINS_TELEGRAM_ALLOWED_CHAT_IDS / TWINS_TELEGRAM_OPTIONS_ONLY at startup (missing/empty = NO chat approved).
   * Tests inject an explicit policy.
   */
  intakePolicy?: Pick<TelegramIntakePolicy, "isChatApproved" | "optionsOnly">;
  /**
   * Which market bars the validation analyses. Default (and the only production behaviour): the Yahoo daily bars this worker just
   * refreshed - never synthetic rows. Tests that run the pipeline on SYNTHETIC bars name that source and context explicitly,
   * so they do not depend on whatever real bars happen to be in the database (which age out of the freshness window).
   */
  analysisMarket?: { source: string; timeframe: string; context?: "analysis" | "synthetic" };
}

export type TelegramJobOutcomeKind =
  | "validation_created"
  | "validation_already_existed"
  | "no_signal"
  | "ambiguous_message_no_signal"
  | "options_claim_not_ingested"
  | "rejected_data_quality"
  | "message_row_missing"
  /** The queued message's chat is not on the approved list: nothing was written or started. */
  | "chat_not_approved"
  /** Options-only mode: the message is not an options message: nothing was written or started. */
  | "non_options_blocked";

export interface TelegramJobOutcome {
  outcome: TelegramJobOutcomeKind;
  signalId?: string;
  validationId?: string;
  /** Reason codes of an unsupported/unverified options intake (codes only; the raw message stays in telegram_messages). */
  reasonCodes?: string[];
  /** The options_claims row recorded (or found, on a retry) for this message and parser version. */
  optionsClaimId?: string;
}

/**
 * Options assessments use NO contract master (and no premium provider) unless one is explicitly configured:
 * TWINS_OPTIONS_MANUAL_REFERENCE=<path to a manual-format reference file>. A configured but malformed file fails at
 * startup (fail-closed). The CLI's sample/manual reference files are never attached implicitly.
 */
const optionsReferencePath = process.env["TWINS_OPTIONS_MANUAL_REFERENCE"];
const optionsProviderSnapshotPath = process.env["TWINS_OPTIONS_PROVIDER_SNAPSHOT"];
if (optionsReferencePath && optionsProviderSnapshotPath) {
  throw new Error("TWINS_OPTIONS_MANUAL_REFERENCE and TWINS_OPTIONS_PROVIDER_SNAPSHOT are both set; configure exactly one (references are never merged or silently chosen)");
}
// An imported provider snapshot (provider-listed only) is enabled ONLY by TWINS_OPTIONS_PROVIDER_SNAPSHOT; never by default.
export const configuredOptionsMaster: OptionsContractMaster | null = optionsReferencePath
  ? createManualReferenceContractMaster(parseManualReferenceFile(JSON.parse(readFileSync(optionsReferencePath, "utf8"))))
  : optionsProviderSnapshotPath
    ? createProviderSnapshotContractMaster(parseProviderSnapshotFile(JSON.parse(readFileSync(optionsProviderSnapshotPath, "utf8"))))
    : null;

const defaultWorkerLogger = createStructuredLogger(undefined, { service: "worker" });

/**
 * Fail-closed intake policy for this process: TWINS_TELEGRAM_ALLOWED_CHAT_IDS (missing/empty approves NO chat; malformed
 * throws here, so the worker does not start) and TWINS_TELEGRAM_OPTIONS_ONLY ("true"/"false"; anything else throws).
 */
const defaultIntakePolicy: Pick<TelegramIntakePolicy, "isChatApproved" | "optionsOnly"> = loadTelegramIntakePolicy();

export async function processTelegramQueueJob(
  job: Job<TelegramJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  const log = (options.logger ?? defaultWorkerLogger).child(buildJobLogContext(job, correlationId));
  const startedAt = Date.now();
  log.info("worker.job.started");
  try {
    const result = await processTelegramJob(job, correlationId, db, {
      logger: log,
      ...(options.intakePolicy ? { intakePolicy: options.intakePolicy } : {}),
      ...(options.analysisMarket ? { analysisMarket: options.analysisMarket } : {}),
    });
    log.info("worker.job.completed", { ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    const permanent = err instanceof ReconciliationRequiredError || err instanceof InvalidJobInputError;
    // Safe diagnostics only (code + class name); the error message is never logged.
    log.error("worker.job.failed", { ...describeErrorSafely(err), retryable: !permanent, durationMs: Date.now() - startedAt });
    if (err instanceof ReconciliationRequiredError) {
      throw new UnrecoverableError(
        `${err.message} (reconciliation required; jobId=${job.id ?? "unknown"})`,
      );
    }
    if (err instanceof InvalidJobInputError) {
      const messageId = job.data?.telegram?.normalizedMessage?.externalMessageId ?? "unknown";
      throw new UnrecoverableError(
        `${err.message} (permanent invalid input; jobId=${job.id ?? "unknown"} externalMessageId=${messageId})`,
      );
    }
    throw err;
  }
}

/**
 * Queue boundary for observed-deletion event jobs (User API capture). Same log context and error mapping as message jobs:
 * only permanent invalid input becomes an UnrecoverableError; everything else propagates for the normal attempts/backoff.
 */
export async function processTelegramEventsQueueJob(
  job: Job<TelegramEventsJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  const log = (options.logger ?? defaultWorkerLogger).child(buildJobLogContext(job, correlationId));
  const startedAt = Date.now();
  log.info("worker.job.started");
  try {
    const result = await processTelegramEventsJob(job.data, db, { logger: log, intakePolicy: options.intakePolicy ?? defaultIntakePolicy });
    log.info("worker.job.completed", { ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    const permanent = err instanceof InvalidJobInputError;
    log.error("worker.job.failed", { ...describeErrorSafely(err), retryable: !permanent, durationMs: Date.now() - startedAt });
    if (err instanceof InvalidJobInputError) {
      throw new UnrecoverableError(`${err.message} (permanent invalid input; jobId=${job.id ?? "unknown"})`);
    }
    throw err;
  }
}

/**
 * The signal queue handler: ONLY `jobType: "telegram_events"` goes to the events handler; every other payload (all existing
 * jobs, including legacy ones) takes the unchanged message path.
 */
export async function processSignalQueueJob(
  job: Job<SignalQueueJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  const data = job.data as { jobType?: unknown } | undefined;
  if (data?.jobType === "telegram_events") {
    return processTelegramEventsQueueJob(job as Job<TelegramEventsJobPayload>, correlationId, db, options);
  }
  return processTelegramQueueJob(job as Job<TelegramJobPayload>, correlationId, db, options);
}

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
export async function processTelegramJob(
  job: Job<TelegramJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<TelegramJobOutcome> {
  // When called through processTelegramQueueJob the logger already carries the job context.
  const log = options.logger ?? defaultWorkerLogger.child(buildJobLogContext(job, correlationId));
  const policy = options.intakePolicy ?? defaultIntakePolicy;

  // Gate 1 - approved chat. Runs before ANY write or downstream work: no jobs row, source, message, signal, instrument,
  // market request or validation exists for a chat that is not approved. The job completes (it is not retried).
  const queuedMessage = job.data?.telegram?.normalizedMessage;
  const queuedChatId = queuedMessage ? chatIdOfQueuedMessage(queuedMessage) : null;
  if (!policy.isChatApproved(queuedChatId)) { // a null (unusable) id is never approved by a real policy
    log.warn("worker.intake.chat_rejected", { reason: queuedChatId === null ? "chat_id_unusable" : "chat_not_approved", chatId: queuedChatId });
    return { outcome: "chat_not_approved", reasonCodes: [queuedChatId === null ? "chat.id_unusable" : "chat.not_approved"] };
  }

  // Gate 2 - explicit options-only mode (fail closed). Only a message the options path will handle may proceed; an
  // equity-style directive, an equity-ambiguous message, a message with no directive or an unusable text is blocked here,
  // before ingestion, so it can never reach the equity signal / instrument / market-data pipeline. This is a parser
  // classification only: it verifies nothing about an options contract or premium.
  if (policy.optionsOnly) {
    const text = queuedMessage?.rawText;
    const analysis = typeof text === "string" ? analyzeTelegramText(text) : undefined;
    const optionsFlow = analysis !== undefined && (analysis.kind === "options_claim" || analysis.kind === "options_unsupported" || (analysis.kind === "ambiguous" && analysis.optionsRelated === true));
    if (!optionsFlow) {
      log.warn("worker.intake.non_options_blocked", { analysisKind: analysis?.kind ?? "unreadable" });
      return { outcome: "non_options_blocked", reasonCodes: ["options_only.not_an_options_message"] };
    }
  }

  const { telegram } = job.data;
  const { exchange, instrumentType } = telegram;
  // BullMQ serialises job data as JSON, so Date fields arrive as ISO strings.
  const normalizedMessage = {
    ...telegram.normalizedMessage,
    messageTimestamp: parseJobTimestamp(telegram.normalizedMessage.messageTimestamp),
    ...(telegram.normalizedMessage.editDate !== undefined && telegram.normalizedMessage.editDate !== null
      ? { editDate: parseJobTimestamp(telegram.normalizedMessage.editDate, "editDate") }
      : {}),
  };


  // User API captures carry their provenance (validated strictly); Bot API webhook jobs have none and stay on the original path.
  const capture = telegram.capture !== undefined ? parseCapture(telegram.capture) : undefined;
  const ingestProviderName = capture ? USER_CAPTURE_PROVIDER_NAME : TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME;

  // Step 1 — Ingest the telegram message (idempotent).
  // We wrap the single already-normalized message in a synthetic provider so
  // runIngestionJob's bookkeeping still fires (jobs + provider_health rows).
  const summary = await runIngestionJob(db, {
    jobType: "telegram_messages",
    queueName: "signal_queue",
    providerName: ingestProviderName,
    providerType: "telegram",
    payload: job.data,
    execute: async () => {
      return ingestTelegramMessages(
        db,
        {
          providerName: ingestProviderName,
          async fetchMessages() {
            return [normalizedMessage];
          },
          async getHealth() {
            return {
              providerName: ingestProviderName,
              providerType: "telegram",
              status: "healthy",
              checkedAt: new Date(),
            };
          },
        },
        telegram.params,
        capture
          ? { captureMethod: capture.captureMethod, observedAt: capture.observedAt, ...(capture.importedAt ? { importedAt: capture.importedAt } : {}) }
          : undefined,
      );
    },
  });

  if (summary.status === "failed") {
    // Throw so BullMQ attempts/backoff apply; returning would report success and lose the message.
    // The underlying error text stays in the `jobs` table; it is not copied into logs or the queue.
    throw Object.assign(new Error("telegram ingestion failed"), { code: "INGESTION_FAILED" });
  }

  const ingestResult = summary.result;
  if (!ingestResult) return { outcome: "message_row_missing" };

  log.info("worker.message.ingested", {
    inserted: ingestResult.inserted,
    duplicates: ingestResult.duplicates,
    rejectedInvalid: ingestResult.rejectedInvalid,
  });
  if (ingestResult.rejectedInvalid > 0) {
    log.warn("worker.message.rejected", { reason: "data_quality" });
    return { outcome: "rejected_data_quality" };
  }

  // Step 2 — Extract signal from the just-ingested message.
  // We need the DB-assigned telegram_messages.id to pass to createSignalFromTelegramMessage.
  const { schema } = await import("@twins/database");
  const { and, eq, isNull } = await import("drizzle-orm");

  // Source-scoped lookup: external message ids are only unique per channel. The source is
  // resolved by chat.id when known (stable across renames), exactly as ingestion did.
  const sourceId = await resolveTelegramSource(db, {
    channelIdentifier: normalizedMessage.channelIdentifier,
    chatId: normalizedMessage.chatId,
    displayName: normalizedMessage.channelDisplayName,
  });
  const [telegramRow] = await db
    .select({ id: schema.telegramMessages.id, originMessageId: schema.telegramMessages.originMessageId, firstSeenEdited: schema.telegramMessages.firstSeenEdited })
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramSourceId, sourceId),
        eq(schema.telegramMessages.externalMessageId, normalizedMessage.externalMessageId),
      ),
    );

  if (!telegramRow) {
    log.warn("worker.message.row_missing");
    return { outcome: "message_row_missing" };
  }

  // Observation record for User API captures: ONE append-only event per message ("seen") or per observed edit
  // ("edited_observed"); the text itself is never copied (SHA-256 only). Idempotent by key, so a redelivery adds nothing.
  if (capture) {
    await recordCaptureEvent(db, {
      telegramSourceId: sourceId,
      telegramMessageId: telegramRow.id,
      externalMessageId: normalizedMessage.originMessageId ?? normalizedMessage.externalMessageId,
      eventType: normalizedMessage.editDate !== undefined ? "edited_observed" : "seen",
      captureMethod: capture.captureMethod,
      observedAt: capture.observedAt,
      sourceEditDate: normalizedMessage.editDate ?? null,
      contentSha256: textSha256Hex(normalizedMessage.rawText),
      meta: {
        ...(capture.importBatchId ? { importBatchId: capture.importBatchId } : {}),
        ...(capture.clientObservedAt ? { clientObservedAt: capture.clientObservedAt } : {}),
        firstSeenEdited: telegramRow.firstSeenEdited,
      },
    });
  }

  // Informational: where this revision stands. Currentness is derived from edit_date,
  // never from arrival order; it is NOT approval invalidation (not implemented).
  const revisionStates = await getRevisionStates(
    db,
    sourceId,
    normalizedMessage.originMessageId ?? normalizedMessage.externalMessageId,
  );
  const ownState = revisionStates.find((r) => r.id === telegramRow.id);
  log.info("worker.revision.state", { state: ownState?.state ?? "unknown", reason: ownState?.reason ?? "n/a" });

  // Step 2 — Canonical signal for (message, parser version). The unique index is
  // the correctness boundary: concurrent or repeated callers all receive the same
  // signal id (created: false / reused: true for the losers). Re-running after a
  // partial failure therefore resumes instead of skipping or duplicating.
  const signalOutcome = await createSignalFromTelegramMessage(db, telegramRow.id, {
    exchange,
    instrumentType,
  });

  if (signalOutcome.reconciliationRequired) {
    throw new ReconciliationRequiredError(signalOutcome.reason ?? "reconciliation required");
  }
  if (policy.optionsOnly && signalOutcome.signalId) {
    // Defence in depth: gate 2 let an options message through, yet an equity signal exists for this message (e.g. created
    // by an older parser version). Options-only mode never continues into validation or market data for it.
    log.warn("worker.intake.non_options_blocked", { analysisKind: "existing_equity_signal" });
    return { outcome: "non_options_blocked", reasonCodes: ["options_only.equity_signal_present"] };
  }
  if (signalOutcome.optionsIntake) {
    // Options-style message: stored raw (telegram_messages) and recorded as an UNVERIFIED options claim row. Never an
    // equity signal, instrument, approval or order. Only a master that was explicitly configured is used (and recorded).
    const intake = signalOutcome.optionsIntake;
    const master = options.optionsMaster ?? configuredOptionsMaster;
    const assessment = intake.kind === "claim" ? await assessOptionsClaim(intake.claim, master ?? unconfiguredContractMaster, unavailablePremiumProvider) : undefined;
    const record = await recordOptionsIntake(db, {
      telegramMessageId: telegramRow.id,
      parserVersion: signalOutcome.parserVersion ?? TELEGRAM_PARSER_VERSION,
      intake,
      assessment,
      master,
      premium: null,
    });
    const reasonCodes = assessment
      ? assessment.reasons.map((x) => x.code)
      : [intake.kind === "ambiguous" ? "directives.ambiguous" : "underlying.unsupported_options_shape"];
    log.warn("worker.options.claim_not_ingested", {
      resultKind: intake.kind,
      assessment: assessment?.outcome,
      ...(intake.kind === "claim"
        ? { underlying: intake.claim.underlying, optionType: intake.claim.optionType, strike: intake.claim.strike, action: intake.claim.action, expiryStatus: intake.claim.expiry.status, levelBasis: intake.claim.levelBasis }
        : {}),
      reasonCodes,
      optionsClaimId: record.id,
      recordCreated: record.created,
      differsFromStored: record.differsFromStored,
    });
    return { outcome: "options_claim_not_ingested", reasonCodes, optionsClaimId: record.id };
  }
  if (signalOutcome.unsupported) {
    const reasonCodes = signalOutcome.unsupportedCodes ?? ["unsupported"];
    log.warn("worker.signal.unsupported", { reasonCodes });
    return { outcome: "options_claim_not_ingested", reasonCodes };
  }
  if (!signalOutcome.signalId) {
    log.info("worker.signal.none", { reason: signalOutcome.ambiguous ? "ambiguous_message" : "no_directive" });
    return { outcome: signalOutcome.ambiguous ? "ambiguous_message_no_signal" : "no_signal" };
  }
  const signalId = signalOutcome.signalId;
  log.info("worker.signal.resolved", { signalId, signalCreated: signalOutcome.created, parserVersion: signalOutcome.parserVersion });

  // Validation provenance. Only a row carrying one of this signal's ingestion keys is
  // DEMONSTRABLY an ingestion validation, so only such a row lets us stand down. Keyless
  // validations (legacy or manual) have unknown provenance: they are preserved untouched
  // and are not proof. In that case ONE newly computed snapshot is appended under the
  // distinct key `telegram-ingest-recompute:<signalId>` so it is identifiable as a
  // recomputation made at retry time (its validated_at is the computation time) and is
  // never mistaken for evidence available at the original signal time. Further retries
  // find the key and create nothing.
  const primaryKey = `telegram-ingest:${signalId}`;
  const recomputeKey = `telegram-ingest-recompute:${signalId}`;
  if ((await findValidationByKey(db, primaryKey)) || (await findValidationByKey(db, recomputeKey))) {
    log.info("worker.validation.skipped_existing", { signalId });
    return { outcome: "validation_already_existed", signalId };
  }
  const [unknownProvenance] = await db
    .select({ id: schema.signalValidations.id })
    .from(schema.signalValidations)
    .where(and(eq(schema.signalValidations.signalId, signalId), isNull(schema.signalValidations.idempotencyKey)));
  const validationKey = unknownProvenance ? recomputeKey : primaryKey;
  if (unknownProvenance) {
    log.warn("worker.validation.unknown_provenance", { signalId, resumePolicy: "append_one_recompute_snapshot" });
  }

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

        log.info("worker.market_context.refreshed", { symbol: instrument.symbol });
      }
    }
  } catch (err) {
    log.warn("worker.market_context.refresh_failed", { blocking: false, ...describeErrorSafely(err) });
  }

  // Step 4 — Run the deterministic validation pipeline (Phases 5–9).
  // validateSignal() calls assembleSignalIntelligence() internally and
  // persists an immutable signal_validations row.
  const validation = await validateSignal(db, signalId, {
    idempotencyKey: validationKey,
    // Explicit analysis inputs: the Yahoo daily bars this worker just refreshed (never synthetic rows), cut at now.
    // No macro relevance rule exists yet, so no macro row is used as evidence.
    asOf: new Date(),
    intelligence: { market: options.analysisMarket ?? { source: YAHOO_PROVIDER_NAME, timeframe: "1d" } },
  });

  log.info("worker.validation.recorded", {
    signalId,
    validationId: validation.validationId,
    validationReused: validation.reused,
    decision: validation.result?.outcome,
  });
  return {
    outcome: validation.reused ? "validation_already_existed" : "validation_created",
    signalId,
    validationId: validation.validationId,
  };
}

// ─── Market bars pipeline (scheduler-driven) ───────────────────────────────

export async function processMarketBarsJob(
  job: Job<MarketBarsJobPayload>,
  correlationId: string,
  db: Db = workerDb.db,
): Promise<void> {
  const { market } = job.data;

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

// BullMQ Workers require maxRetriesPerRequest: null. Each worker gets its own
// explicit ioredis client (native ESM cannot lazy-load ioredis from options).
const workerRedisClients: Redis[] = [];
const createWorkerRedis = (): Redis => {
  const client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  workerRedisClients.push(client);
  return client;
};

// In test environment, do not start active BullMQ worker event loops unless explicitly triggered
export const signalWorker =
  process.env["NODE_ENV"] === "test"
    ? (null as unknown as Worker<SignalQueueJobPayload>)
    : new Worker<SignalQueueJobPayload>(
        "signal_queue",
        async (job: Job<SignalQueueJobPayload>) => {
          await processSignalQueueJob(job);
        },
        {
          connection: createWorkerRedis(),
          concurrency: 2,
        },
      );

export const marketWorker =
  process.env["NODE_ENV"] === "test"
    ? (null as unknown as Worker<MarketBarsJobPayload>)
    : new Worker<MarketBarsJobPayload>(
        "market_queue",
        async (job: Job<MarketBarsJobPayload>) => {
          const correlationId = randomUUID().slice(0, 8);
          await processMarketBarsJob(job, correlationId);
        },
        {
          connection: createWorkerRedis(),
          concurrency: 4,
        },
      );

if (signalWorker) {
  // Per-attempt detail is logged by processTelegramQueueJob; this reports the queue-level result
  // without the error message (which may embed row values).
  signalWorker.on("failed", (job, err) => {
    defaultWorkerLogger.warn("worker.queue.job_failed", {
      queue: "signal_queue",
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
      ...describeErrorSafely(err),
    });
  });
}

if (marketWorker) {
  marketWorker.on("completed", (job) => {
    console.log(`[worker] market_queue job ${job.id} completed`);
  });
  marketWorker.on("failed", (job, err) => {
    console.error(`[worker] market_queue job ${job?.id} failed: ${err.message}`);
  });
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

export async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] received ${signal}, shutting down gracefully`);
  const closers: Array<Promise<unknown>> = [];
  if (signalWorker) closers.push(signalWorker.close());
  if (marketWorker) closers.push(marketWorker.close());
  for (const r of await Promise.allSettled(closers)) {
    if (r.status === "rejected") console.error(`[worker] close failed: ${String(r.reason)}`);
  }
  await Promise.allSettled(workerRedisClients.map((c) => c.quit().catch(() => c.disconnect())));
  await workerDb.close();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

if (process.env["NODE_ENV"] !== "test") {
  console.log("[worker] listening on signal_queue and market_queue");
}

// Keep the process alive (the BullMQ workers run their event loops internally).
export { dispatchIngestionJob } from "./ingestionDispatch.js";
