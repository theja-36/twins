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
 * environment. The webhook endpoint requires a shared secret token
 * (`X-Telegram-Bot-Api-Secret-Token`) to verify the request genuinely came from
 * Telegram (configured when registering the webhook with setWebhook).
 *
 * Security & failsafe enforcement (R0A / SEC-01 / SEC-02 / SEC-03):
 * - Fail-closed: TELEGRAM_WEBHOOK_SECRET and TWINS_API_KEY are mandatory.
 * - The webhook secret is verified in an `onRequest` hook, i.e. BEFORE Fastify reads or
 *   parses the body (Fastify v4 order: onRequest -> preParsing -> parsing -> validation ->
 *   handler). Missing or incorrect secrets are rejected with 403 without parsing the body,
 *   enqueueing jobs or modifying storage. Authenticated requests are then body-limited (1 MB),
 *   parsed and schema-validated.
 * - Body content never reaches logs: the JSON parser is wrapped so parse errors carry a fixed
 *   message (the stock message embeds a fragment of the body), and a custom error handler logs
 *   only status/code/class name, never `error.message`.
 * - String comparisons use constant-time byte comparisons (constantTimeCompare).
 *
 * Enqueue-and-return pattern: the webhook handler enqueues a BullMQ job and
 * returns 202 immediately. Full validation runs in the worker process,
 * ensuring the HTTP response is not blocked by database operations (spec
 * section 46 - queue architecture).
 */

import { STATUS_CODES } from "node:http";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { loadConfig } from "@twins/config";
import { getDb, schema, type Db } from "@twins/database";
import { normalizeRawUpdate } from "@twins/adapter-telegram";
import { ProviderDataError } from "@twins/types";
import {
  acceptCorrelationId,
  constantTimeCompare,
  createStructuredLogger,
  describeErrorSafely,
  newCorrelationId,
  newRequestId,
  type StructuredLogger,
} from "@twins/shared";

function readEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Producer-side bound for ONE webhook enqueue (HTTP request path only; the worker's BullMQ retry policy is a
 * different mechanism and is untouched). Default 3000 ms: a healthy local/staging enqueue takes milliseconds,
 * so 3 s leaves large headroom for a slow-but-working Redis while staying far below typical reverse-proxy and
 * Telegram delivery timeouts (tens of seconds), so a dependency problem becomes a prompt 503 that Telegram
 * retries instead of a hung connection. Override with TWINS_ENQUEUE_TIMEOUT_MS (or the `enqueueTimeoutMs`
 * option); allowed range 250-30000 ms, anything else fails startup (fail-closed configuration).
 */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 3000;
export const MIN_ENQUEUE_TIMEOUT_MS = 250;
export const MAX_ENQUEUE_TIMEOUT_MS = 30_000;

export function resolveEnqueueTimeoutMs(option: number | undefined, env: string | undefined): number {
  const raw = option ?? (env !== undefined && env.trim() !== "" ? Number(env) : undefined);
  if (raw === undefined) return DEFAULT_ENQUEUE_TIMEOUT_MS;
  if (!Number.isFinite(raw) || raw < MIN_ENQUEUE_TIMEOUT_MS || raw > MAX_ENQUEUE_TIMEOUT_MS) {
    throw new Error(`TWINS_ENQUEUE_TIMEOUT_MS must be a number between ${MIN_ENQUEUE_TIMEOUT_MS} and ${MAX_ENQUEUE_TIMEOUT_MS}.`);
  }
  return Math.floor(raw);
}

/**
 * What is known about a webhook submission that did NOT return success:
 *  - not_attempted         : nothing was sent to the queue (Redis not ready within the bound) - confirmed.
 *  - failed_unconfirmed    : the queue call rejected with a connectivity-class error; the job may or may not exist.
 *  - timed_out_unconfirmed : the bound elapsed while the call was still pending; the call is NOT cancelled and
 *                            may still complete later, so the job may or may not exist.
 * The deterministic job id makes a retry of the same update safe in all three cases.
 */
export type SubmissionKnowledge = "not_attempted" | "failed_unconfirmed" | "timed_out_unconfirmed";

export class QueueUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "QUEUE_UNAVAILABLE";
  constructor(readonly submission: SubmissionKnowledge) {
    super("Service Unavailable"); // generic on purpose; never carries the underlying error text
    this.name = "QueueUnavailableError";
  }
}

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN", "NR_CLOSED"]);
/** Connectivity-class failures of the Redis/BullMQ producer (matched on name/code, with a closed-connection message fallback). */
export function isDependencyUnavailable(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; errors?: unknown[] } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "MaxRetriesPerRequestError") return true;
  if (typeof e.code === "string" && UNAVAILABLE_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDependencyUnavailable(x))) return true; // AggregateError (dual-stack connect)
  return typeof e.message === "string" && /Connection is closed|Stream isn't writeable/.test(e.message);
}

type Settled<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };
/** Resolves with whichever comes first: the promise's outcome or the deadline. Does NOT cancel the promise. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ kind: "timeout" }), ms);
    p.then(
      (value) => { clearTimeout(t); resolve({ kind: "ok", value }); },
      (error: unknown) => { clearTimeout(t); resolve({ kind: "error", error }); },
    );
  });
}

export interface ApiOptions {
  apiKey?: string;
  telegramWebhookSecret?: string;
  /**
   * The queue the webhook enqueues into. When omitted the API creates and owns a REAL BullMQ queue
   * from REDIS_URL. There is no environment-based fake: tests must inject a clearly test-owned fake
   * (unit) or a real test queue (integration). `getJob` (optional) lets the webhook link a duplicate
   * request to the job it deduplicated onto.
   */
  telegramQueue?: Pick<Queue, "add"> & Partial<Pick<Queue, "getJob">>;
  db?: Db;
  logger?: boolean | object;
  /** Producer-side bound for one webhook enqueue in ms (default 3000, range 250-30000); see DEFAULT_ENQUEUE_TIMEOUT_MS. */
  enqueueTimeoutMs?: number;
  /** Structured end-to-end correlation log sink; defaults to JSON lines on the console. */
  structuredLogger?: StructuredLogger;
}

export interface BuildAppResult {
  app: FastifyInstance;
  telegramQueue?: Pick<Queue, "add">;
}

/**
 * Validates configuration and constructs the Fastify API instance.
 * Exported for test isolation (app.inject) and process execution.
 */
export async function buildApp(options: ApiOptions = {}): Promise<FastifyInstance> {
  const apiKey = options.apiKey ?? readEnv("TWINS_API_KEY");
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("TWINS_API_KEY environment variable is required to start the API.");
  }

  const webhookSecret =
    options.telegramWebhookSecret ?? readEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!webhookSecret || webhookSecret.trim().length === 0) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET environment variable is required to start the API with webhook receiver enabled.",
    );
  }

  const config = loadConfig();
  const enqueueTimeoutMs = resolveEnqueueTimeoutMs(options.enqueueTimeoutMs, readEnv("TWINS_ENQUEUE_TIMEOUT_MS"));

  // Resources created here are owned by the app and closed in onClose below.
  // BullMQ's native-ESM path cannot lazily require ioredis from connection
  // options, so the client is constructed explicitly (REDIS_URL honoured).
  let ownedRedis: Redis | undefined;
  let ownedQueue: Queue | undefined;
  let telegramQueue: Pick<Queue, "add"> & Partial<Pick<Queue, "getJob">>;
  if (options.telegramQueue) {
    telegramQueue = options.telegramQueue;
  } else {
    // No NODE_ENV-based stub exists: a missing/unreachable real queue makes enqueue fail (5xx), never a
    // false acceptance. Producer: bounded per-request retries so enqueue failures surface as errors.
    ownedRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    ownedQueue = new Queue("signal_queue", { connection: ownedRedis });
    telegramQueue = ownedQueue;
  }

  const db = options.db ?? getDb();

  const app = Fastify({
    logger: options.logger ?? (process.env["NODE_ENV"] === "test" ? false : true),
    // The HTTP request id is server-generated and unique per request. Fastify v4 would otherwise
    // trust a client-supplied `request-id` header as the request id.
    requestIdHeader: false,
    genReqId: () => newRequestId(),
  });
  const structuredLog = (options.structuredLogger ?? createStructuredLogger()).child({ service: "api" });

  // Owned Redis/Queue diagnostics. ioredis emits an `error` on every reconnect attempt and BullMQ re-emits it;
  // record a safe code (never the message) at most once per 10 s so an outage cannot flood the logs. Logging is
  // all this does: it does not hide failed requests or mark anything healthy.
  if (ownedRedis && ownedQueue) {
    let lastLoggedAt = 0;
    let suppressed = 0;
    const onRedisError = (err: unknown) => {
      const now = Date.now();
      if (now - lastLoggedAt < 10_000) { suppressed += 1; return; }
      structuredLog.warn("api.redis.error", { ...describeErrorSafely(err), suppressedSinceLast: suppressed });
      lastLoggedAt = now;
      suppressed = 0;
    };
    ownedRedis.on("error", onRedisError);
    ownedQueue.on("error", onRedisError);
  }
  /** Waits (within the bound) for the owned Redis client to be ready; true if ready. Injected queues skip this. */
  const waitForQueueReady = ownedRedis
    ? (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
          const redis = ownedRedis;
          if (redis.status === "ready") return resolve(true);
          const done = (ok: boolean) => { clearTimeout(timer); redis.off("ready", onReady); resolve(ok); };
          const onReady = () => done(true);
          const timer = setTimeout(() => done(false), ms);
          redis.once("ready", onReady);
        })
    : undefined;

  // Keep the stock JSON parser's protections (prototype/constructor poisoning -> error) but replace its
  // error: the stock SyntaxError message embeds a fragment of the request body, which Fastify would log.
  const stockJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    void stockJsonParser(request, body as string, (err, parsed) => {
      if (err) {
        done(Object.assign(new Error("Malformed or unsupported JSON body"), { statusCode: 400, code: "TWINS_MALFORMED_BODY" }), undefined);
      } else {
        done(null, parsed);
      }
    });
  });

  // One error boundary for the whole API. Logs status, code and error CLASS only (never `error.message`,
  // which can embed row values or body fragments); 5xx responses are generic; 4xx keep their message
  // (validation messages name properties but not values; the parser message above is fixed).
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const raw = typeof error.statusCode === "number" ? error.statusCode : 500;
    const statusCode = raw >= 400 && raw < 600 ? raw : 500;
    const safe = describeErrorSafely(error);
    const code = typeof error.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : safe.errorCode;
    request.log[statusCode >= 500 ? "error" : "warn"]({ statusCode, errorCode: code, errorName: safe.errorName }, "request failed");
    void reply.code(statusCode).send(
      statusCode >= 500
        ? { statusCode, error: STATUS_CODES[statusCode] ?? STATUS_CODES[500], message: STATUS_CODES[statusCode] ?? STATUS_CODES[500] }
        : { statusCode, code, error: STATUS_CODES[statusCode] ?? "Error", message: error.message },
    );
  });

  function checkBearerToken(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader) return false;
    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return false;
    return constantTimeCompare(token, apiKey);
  }

  // ── Health check (no auth) ──────────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    service: "api",
    appEnv: config.appEnv,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
  }));

  // ── Telegram Bot API webhook receiver ──────────────────────────────────────
  const isWebhookAuthorized = (request: FastifyRequest): boolean => {
    const sentSecret = request.headers["x-telegram-bot-api-secret-token"];
    return typeof sentSecret === "string" && constantTimeCompare(sentSecret, webhookSecret);
  };
  const rejectWebhook = (request: FastifyRequest, reply: FastifyReply) => {
    // Unauthenticated callers never influence correlation: nothing from the request is trusted here.
    structuredLog.warn("webhook.intake.rejected", {
      requestId: request.id,
      correlationId: newCorrelationId(),
      reason: "invalid_secret",
      statusCode: 403,
    });
    return reply.code(403).send({ error: "Forbidden" });
  };

  /**
   * POST /webhooks/telegram
   *
   * Expects the Telegram Bot API to POST JSON Update objects to this endpoint.
   * Validates the shared secret header using constant-time comparison, enqueues
   * a `telegram_messages` job, and returns 202.
   *
   * Security (spec section 27, audit SEC-01 & SEC-02):
   * - Fail-closed secret verification in an `onRequest` hook: it runs BEFORE the body is read or
   *   parsed, so unauthenticated requests get 403 whatever their body contains (and are not
   *   body-parsed, size-checked or logged). The handler repeats the check as defence in depth.
   * - Authenticated request bodies are limited to 1MB.
   */
  app.post(
    "/webhooks/telegram",
    {
      bodyLimit: 1024 * 1024,
      onRequest: async (request, reply) => {
        if (!isWebhookAuthorized(request)) return rejectWebhook(request, reply);
        return undefined;
      },
      schema: {
        body: {
          type: "object",
          required: ["update_id"],
          properties: {
            update_id: { type: "number" },
          },
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      // Defence in depth: the onRequest hook above already rejected unauthenticated requests.
      if (!isWebhookAuthorized(request)) return rejectWebhook(request, reply);

      // Authenticated. An externally supplied correlation id is UNTRUSTED: it is used only if it
      // is a short token of safe characters; otherwise an internal id is generated.
      const supplied = acceptCorrelationId(request.headers["x-correlation-id"]);
      const correlationId = supplied ?? newCorrelationId();
      const log = structuredLog.child({
        requestId,
        correlationId,
        correlationSource: supplied ? "client-supplied" : "generated",
      });

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
          log.warn("webhook.intake.invalid", { ...describeErrorSafely(err), statusCode: 400 });
          return reply.code(400).send({ error: err.message });
        }
        log.error("webhook.intake.failed", { ...describeErrorSafely(err) });
        throw err;
      }

      // Non-text updates (stickers, polls, etc.) are accepted with 200; nothing to enqueue.
      if (normalized === null) {
        log.info("webhook.intake.ignored", { reason: "no_text_content", statusCode: 200 });
        return reply.code(200).send({ status: "ignored", reason: "no text content" });
      }

      // Business deduplication key (NOT the correlation id): one job per message revision.
      const jobId = `tg-${normalized.channelIdentifier}-${normalized.externalMessageId}`;
      const correlation = { correlationId, requestId, receivedAt: new Date().toISOString() };
      log.info("webhook.intake.accepted", {
        jobId,
        updateId: normalized.updateId,
        channelIdentifier: normalized.channelIdentifier,
        externalMessageId: normalized.externalMessageId,
        originMessageId: normalized.originMessageId,
      });

      // Enqueue the ingestion job under a producer-side bound (HTTP path only). 202 is returned ONLY after the
      // queue confirmed the submission; every other outcome is a generic 503 (connectivity/timeout) or 500.
      const startedAt = Date.now();
      const remaining = () => Math.max(0, enqueueTimeoutMs - (Date.now() - startedAt));
      if (waitForQueueReady && !(await waitForQueueReady(remaining()))) {
        log.warn("webhook.enqueue.unavailable", { jobId, submission: "not_attempted" satisfies SubmissionKnowledge, boundMs: enqueueTimeoutMs, statusCode: 503 });
        throw new QueueUnavailableError("not_attempted");
      }
      const submission = Promise.resolve().then(() =>
        telegramQueue.add(
          "telegram_messages",
          {
            jobType: "telegram_messages",
            providerName: "telegram-bot-webhook",
            correlation,
            telegram: {
              params: {
                channelIdentifier: normalized.channelIdentifier,
                sinceExternalMessageId: undefined,
              },
              normalizedMessage: normalized,
              exchange,
              instrumentType,
            },
          },
          {
            jobId,
            attempts: 3,
            backoff: { type: "exponential", delay: 1000 },
          },
        ),
      );
      const outcome = await settleWithin(submission, remaining());
      if (outcome.kind === "timeout") {
        // The call is NOT cancelled and may still complete: the outcome is UNKNOWN, not "no job". The same
        // deterministic job id means a retry of this update cannot create a second job. Record the late result.
        log.warn("webhook.enqueue.outcome_unknown", { jobId, submission: "timed_out_unconfirmed" satisfies SubmissionKnowledge, boundMs: enqueueTimeoutMs, statusCode: 503 });
        submission.then(
          () => log.info("webhook.enqueue.late_completion", { jobId, outcome: "succeeded", completedAfterMs: Date.now() - startedAt }),
          (err: unknown) => log.warn("webhook.enqueue.late_completion", { jobId, outcome: "failed", ...describeErrorSafely(err) }),
        );
        throw new QueueUnavailableError("timed_out_unconfirmed");
      }
      if (outcome.kind === "error") {
        if (isDependencyUnavailable(outcome.error)) {
          log.warn("webhook.enqueue.unavailable", { jobId, submission: "failed_unconfirmed" satisfies SubmissionKnowledge, ...describeErrorSafely(outcome.error), statusCode: 503 });
          throw new QueueUnavailableError("failed_unconfirmed");
        }
        log.error("webhook.enqueue.failed", { jobId, ...describeErrorSafely(outcome.error), statusCode: 500 });
        throw outcome.error;
      }

      // BullMQ keeps the FIRST job for a jobId. If the stored job carries a different correlation
      // id, this request deduplicated onto an existing job: link to it instead of implying that
      // this request's ids became the job's context. (Best effort; needs getJob.)
      let existing: { jobId: string; correlationId?: string; requestId?: string } | undefined;
      try {
        // Bounded too: a successful submission must not turn into a hang because the best-effort lookup stalls.
        const lookup = await settleWithin(Promise.resolve(telegramQueue.getJob?.(jobId)), Math.min(1000, remaining()));
        if (lookup.kind === "timeout") throw Object.assign(new Error("lookup timed out"), { code: "LOOKUP_TIMEOUT" });
        if (lookup.kind === "error") throw lookup.error;
        const stored = lookup.value;
        const storedCorrelation = (stored?.data as { correlation?: { correlationId?: unknown; requestId?: unknown } } | undefined)?.correlation;
        const storedId = acceptCorrelationId(storedCorrelation?.correlationId);
        if (stored && storedId !== correlationId) {
          existing = {
            jobId,
            ...(storedId ? { correlationId: storedId } : {}),
            ...(typeof storedCorrelation?.requestId === "string" ? { requestId: storedCorrelation.requestId.slice(0, 80) } : {}),
          };
        }
      } catch (err) {
        log.warn("webhook.enqueue.link_lookup_failed", { jobId, ...describeErrorSafely(err) });
      }
      if (existing) {
        log.info("webhook.enqueue.deduplicated", {
          jobId,
          existingJobCorrelationId: existing.correlationId,
          existingJobRequestId: existing.requestId,
          statusCode: 202,
        });
      } else {
        log.info("webhook.enqueue.succeeded", { jobId, statusCode: 202 });
      }

      return reply.code(202).send({ status: "accepted" });
    },
  );

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

  // ── Operator: unverified options claims recorded for a Telegram message ────────
  /**
   * GET /options-claims/:messageId[?parserVersion=...]
   *
   * `messageId` is the internal telegram_messages id. Returns EVERY recorded parser version for the message, each
   * explicitly labelled (never one chosen silently); `parserVersion` narrows to a single labelled version.
   * Records are UNVERIFIED options claims: not signals, not approvals, never an order (approvalPossible is false and
   * database-constrained). Protected by bearer token auth (TWINS_API_KEY).
   */
  app.get<{ Params: { messageId: string }; Querystring: { parserVersion?: string } }>(
    "/options-claims/:messageId",
    async (request, reply) => {
      if (!checkBearerToken(request.headers.authorization)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const { messageId } = request.params;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
        return reply.code(400).send({ error: "messageId must be a UUID" });
      }
      const wanted = request.query.parserVersion;
      const rows = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, messageId));
      const claims = rows
        .filter((r) => wanted === undefined || r.parserVersion === wanted)
        .sort((a, b) => a.parserVersion.localeCompare(b.parserVersion))
        .map((r) => ({
          id: r.id,
          parserVersion: r.parserVersion,
          resultKind: r.resultKind,
          claim: r.claim,
          detail: r.detail,
          assessmentOutcome: r.assessmentOutcome,
          reasons: r.reasons,
          verification: r.verification,
          premium: r.premium,
          provenance: r.provenance,
          approvalPossible: false as const,
          createdAt: r.createdAt,
        }));
      if (claims.length === 0) return reply.code(404).send({ error: "No options claim recorded for this message" });
      return reply.code(200).send({
        messageId,
        versionCount: claims.length,
        selectedParserVersion: wanted ?? null,
        notice: "Unverified options claim records: not signals, not approvals. No order was or can be submitted from this record.",
        claims,
      });
    },
  );

  app.addHook("onClose", async () => {
    const errors: unknown[] = [];
    // Bounded: closing a queue/client whose Redis never became ready can wait forever, so give each close a
    // short grace period and then force the connection down (the API owns both and is shutting down).
    const grace = <T>(p: Promise<T>) => settleWithin(p, 2000);
    if (ownedQueue) {
      const r = await grace(ownedQueue.close());
      if (r.kind === "error") errors.push(r.error);
    }
    if (ownedRedis) {
      const r = await grace(ownedRedis.quit());
      if (r.kind !== "ok" || ownedRedis.status !== "end") ownedRedis.disconnect();
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "API resource cleanup failed");
    }
  });

  return app;
}

// ── Start if executed directly as entrypoint ─────────────────────────────────
const argv1 = process.argv[1];
const isDirectRun =
  process.env["NODE_ENV"] !== "test" &&
  !process.env["VITEST"] &&
  argv1 !== undefined &&
  import.meta.url === `file://${argv1}`;

if (isDirectRun) {
  const port = Number(readEnv("PORT") ?? "4000");
  const server = await buildApp();
  // HOST defaults to 0.0.0.0 (previous behaviour); set HOST=127.0.0.1 for loopback-only local runs.
  const host = readEnv("HOST") ?? "0.0.0.0";
  await server.listen({ port, host });
}
