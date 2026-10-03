/**
 * TWINS API server (spec section 7/49/50).
 *
 * Current routes:
 *   GET  /health                            — liveness check, no auth
 *   POST /webhooks/telegram                 — Telegram Bot API webhook receiver
 *   GET  /signals/:id/validation            — retrieve persisted validation result
 *
 * Auth model (spec section 41 - single-operator internal tool for now):
 * A static bearer token / API key in the `Authorization` header is required
 * for operator-facing routes. The secret is read from `TWINS_API_KEY` in the
 * environment. The webhook endpoint uses a separate shared-secret header
 * (`X-Telegram-Secret`) to verify the request genuinely came from Telegram
 * (configured when registering the webhook with setWebhook).
 *
 * Enqueue-and-return pattern: the webhook handler enqueues a BullMQ job and
 * returns 202 immediately. Full validation runs in the worker process,
 * ensuring the HTTP response is not blocked by database operations (spec
 * section 46 - queue architecture).
 */

import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { loadConfig } from "@twins/config";
import { getDb, schema } from "@twins/database";
import { normalizeRawUpdate } from "@twins/adapter-telegram";
import { ProviderDataError } from "@twins/types";

const config = loadConfig();

// ─── BullMQ queue (publish-only from the API process) ─────────────────────
const telegramQueue = new Queue("signal_queue", {
  connection: { url: config.redisUrl },
});

// ─── Auth helpers ──────────────────────────────────────────────────────────

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function getApiKey(): string {
  const key = readEnv("TWINS_API_KEY");
  if (!key) throw new Error("TWINS_API_KEY environment variable is required.");
  return key;
}

function getTelegramWebhookSecret(): string | undefined {
  return readEnv("TELEGRAM_WEBHOOK_SECRET");
}

function checkBearerToken(authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader) return false;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return false;
  return token === getApiKey();
}

// ─── Server ────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true });

await app.register(sensible);

// ── Health check (no auth) ──────────────────────────────────────────────────
app.get("/health", async () => ({
  status: "ok",
  service: "api",
  appEnv: config.appEnv,
  tradingMode: config.tradingMode,
  liveTradingEnabled: config.liveTradingEnabled,
}));

// ── Telegram Bot API webhook receiver ──────────────────────────────────────
/**
 * POST /webhooks/telegram
 *
 * Expects the Telegram Bot API to POST JSON Update objects to this endpoint.
 * Validates the shared secret (set when calling Telegram's setWebhook with
 * `secret_token`), enqueues a `telegram_messages` job, and returns 202.
 *
 * Security (spec section 27): the raw `body` is treated as untrusted Tier E
 * input. It is validated for structure by `normalizeRawUpdate()` but its
 * text content is never interpreted as a system instruction.
 */
app.post("/webhooks/telegram", async (request, reply) => {
  // Verify the shared secret header before touching the body.
  const webhookSecret = getTelegramWebhookSecret();
  if (webhookSecret) {
    const sentSecret = request.headers["x-telegram-bot-api-secret-token"];
    if (sentSecret !== webhookSecret) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  }

  // Exchange for which the signal's symbols are interpreted.
  // Configurable via env; defaults to NSE (India equities, spec section 12).
  const exchange = readEnv("TELEGRAM_SIGNAL_EXCHANGE") ?? "NSE";
  const instrumentType =
    readEnv("TELEGRAM_SIGNAL_INSTRUMENT_TYPE") ?? "equity";

  let normalized;
  try {
    normalized = normalizeRawUpdate(request.body);
  } catch (err) {
    if (err instanceof ProviderDataError) {
      return reply.code(400).send({ error: err.message });
    }
    throw err;
  }

  // Non-text updates (stickers, polls, etc.) are silently accepted with 200;
  // there is nothing to enqueue.
  if (normalized === null) {
    return reply.code(200).send({ status: "ignored", reason: "no text content" });
  }

  // Enqueue the ingestion job. The worker process will:
  //   1. ingestTelegramMessages() → deduplicate → persist telegram_messages row
  //   2. createSignalFromTelegramMessage() → extract + persist signals row
  //   3. ingestMarketBars() → refresh market context
  //   4. assembleSignalIntelligence() + validateSignal() → persist signal_validations row
  await telegramQueue.add(
    "telegram_messages",
    {
      jobType: "telegram_messages",
      providerName: "telegram-bot-webhook",
      telegram: {
        params: {
          channelIdentifier: normalized.channelIdentifier,
          sinceExternalMessageId: undefined,
        },
        // Pass the already-normalized message so the worker doesn't re-fetch.
        normalizedMessage: normalized,
        exchange,
        instrumentType,
      },
    },
    {
      // Idempotency: Telegram may redeliver the same update_id. Use a
      // deterministic job ID so BullMQ deduplicates at the queue level.
      jobId: `tg-${normalized.channelIdentifier}-${normalized.externalMessageId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    },
  );

  return reply.code(202).send({ status: "accepted" });
});

// ── Operator: get signal validation result ──────────────────────────────────
/**
 * GET /signals/:id/validation
 *
 * Returns the most recent persisted signal_validations row for the given
 * signal ID, including outcome, theses, and evidence references.
 *
 * Protected by bearer token auth (TWINS_API_KEY).
 */
app.get<{ Params: { id: string } }>(
  "/signals/:id/validation",
  async (request, reply) => {
    if (!checkBearerToken(request.headers.authorization)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { id: signalId } = request.params;
    const db = getDb();

    // Confirm the signal exists first to return 404 vs 200-with-empty.
    const [signal] = await db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.id, signalId));

    if (!signal) {
      return reply.code(404).send({ error: `Signal not found: ${signalId}` });
    }

    // Return the most recent validation row (multiple may exist; each is immutable).
    const validations = await db
      .select()
      .from(schema.signalValidations)
      .where(eq(schema.signalValidations.signalId, signalId));

    if (validations.length === 0) {
      return reply.code(202).send({
        status: "pending",
        signalId,
        message: "Signal has not yet been validated. Check back shortly.",
      });
    }

    // Most recent first.
    const sorted = [...validations].sort(
      (a, b) =>
        new Date(b.validatedAt).getTime() - new Date(a.validatedAt).getTime(),
    );

    const latest = sorted[0]!;

    return reply.code(200).send({
      signalId,
      validationId: latest.id,
      outcome: latest.outcome,
      decisionConfidence: Number(latest.decisionConfidence),
      confidenceLabel: latest.confidenceLabel,
      rationale: latest.rationale,
      sourceReliability: {
        level: latest.sourceReliability,
        reason: latest.sourceReliabilityReason,
      },
      bullThesis: latest.bullThesis,
      bearThesis: latest.bearThesis,
      counterThesis: latest.counterThesis,
      counterThesisSeverity: latest.counterThesisSeverity,
      validatedAt: latest.validatedAt,
      signalStatus: signal.status,
      allValidations: sorted.map((v) => ({
        id: v.id,
        outcome: v.outcome,
        validatedAt: v.validatedAt,
      })),
    });
  },
);

// ── Start ────────────────────────────────────────────────────────────────────
const port = Number(readEnv("PORT") ?? "4000");
await app.listen({ port, host: "0.0.0.0" });
