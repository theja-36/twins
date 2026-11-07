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
import { eq, sql } from "drizzle-orm";
import { enforceLiveTradingGuard, loadConfig } from "@twins/config";
import { getDb, getPool, schema, type Db } from "@twins/database";
import { runResearchProbe } from "@twins/risk";
import { configureRuntimeState, evaluateSafety, pgStateSource, type SafetyRefusalError } from "@twins/runtime-state";
import { enforceRuntimeRoleSeparation } from "@twins/audit-chain";
import { getValidationEligibility } from "@twins/signals";
import { describeUpdateChat, loadTelegramIntakePolicy, normalizeRawUpdate, type TelegramIntakePolicy } from "@twins/adapter-telegram";
import { registerInternalIngest, resolveCaptureCaps, resolveCaptureIngestToken, type CaptureCaps } from "./internalIngest.js";
import { ProviderDataError } from "@twins/types";
import { buildMessageOutboxInput, OUTBOX_JOB_ID, OUTBOX_QUEUE_JOB_NAME, PgIntakeOutbox, type IntakeOutbox } from "@twins/ingestion";
import { observe, recordProcessStart } from "@twins/alerting";
import { currentRuntimeState } from "@twins/runtime-state";
import { buildStatus } from "./statusSurface.js";
import { registerRiskRoutes } from "./riskApi.js";
import { registerIntelligenceRoutes } from "./intelligenceApi.js";
import { registerPaperRoutes } from "./paperApi.js";
import { registerAgentsRoutes } from "./agentsApi.js";
import { registerNotificationsRoutes } from "./notificationsApi.js";
import { registerSystemRoutes } from "./systemApi.js";
import { registerAdminRoutes } from "./adminApi.js";
import { registerOpenApiRoute } from "./openapi.js";
import { registerLiveRoutes } from "./liveApi.js";
import { createIntakeService, type IntakeEnqueue } from "./intakeService.js";
import {
  acceptCorrelationId,
  constantTimeCompare,
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

/** 503 for a paused intake. The body names the reason code only; Retry-After tells a well-behaved client when to retry. */
export function replyIntakePaused(reply: FastifyReply, log: StructuredLogger, refusal: SafetyRefusalError): FastifyReply {
  log.warn("api.intake.paused", { operation: refusal.operation, reason: refusal.reason, statusCode: 503 });
  return reply.code(503).header("Retry-After", "30").send({ error: "intake_paused", reason: refusal.reason });
}

/** Counts this process start for crash/restart-loop detection (best effort; needs Redis). */
async function recordApiStart(logger: ReturnType<typeof observe>["logger"]): Promise<void> {
  const redis = new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await recordProcessStart({ incr: async (key, ttl) => { const n = await redis.incr(key); if (n === 1) await redis.expire(key, ttl); return n; } }, "api", logger);
  } catch { /* not counted */ } finally {
    redis.disconnect();
  }
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
  /** The durable intake outbox. Defaults to the PostgreSQL implementation over `db`; tests may inject a clearly test-owned in-memory one. */
  intakeOutbox?: IntakeOutbox;
  logger?: boolean | object;
  /** Producer-side bound for one webhook enqueue in ms (default 3000, range 250-30000); see DEFAULT_ENQUEUE_TIMEOUT_MS. */
  enqueueTimeoutMs?: number;
  /** Structured end-to-end correlation log sink; defaults to JSON lines on the console. */
  structuredLogger?: StructuredLogger;
  /**
   * Which Telegram chats may be ingested. Default: read from TWINS_TELEGRAM_ALLOWED_CHAT_IDS (missing/empty = NO chat is
   * approved; a malformed value makes buildApp throw, i.e. the API does not start). Tests inject an explicit policy.
   */
  telegramIntakePolicy?: Pick<TelegramIntakePolicy, "isChatApproved" | "approvedChatCount">;
  /**
   * Token of the INTERNAL User API capture endpoint (POST /internal/ingest/telegram-user). Default: TWINS_CAPTURE_INGEST_TOKEN.
   * Unset or empty = the endpoint does not exist. A set token must be 32+ safe characters and differ from the API key and the
   * webhook secret, otherwise the API refuses to start.
   */
  captureIngestToken?: string;
  /** Volume caps of the internal capture endpoint (defaults 60 requests/min, 600 live messages/hour, 2000 history messages/day). */
  captureCaps?: Partial<CaptureCaps>;
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
  enforceLiveTradingGuard("api");
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
  // Fail-closed intake policy: throws on a malformed allowlist (the API then refuses to start).
  const intakePolicy = options.telegramIntakePolicy ?? loadTelegramIntakePolicy();
  const enqueueTimeoutMs = resolveEnqueueTimeoutMs(options.enqueueTimeoutMs, readEnv("TWINS_ENQUEUE_TIMEOUT_MS"));
  // Internal capture endpoint configuration: fail closed (throws) when set but unusable; absent when unset.
  const captureToken = resolveCaptureIngestToken(options.captureIngestToken, readEnv("TWINS_CAPTURE_INGEST_TOKEN"), { apiKey, webhookSecret });
  const captureCaps = resolveCaptureCaps(options.captureCaps, process.env);

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
  const structuredLog = (options.structuredLogger ?? observe("api").logger).child({ service: "api" });

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

  /**
   * Durable intake (Stage 2 / Task 2): every accepted Telegram entry is written to the PostgreSQL outbox first; only then is a Redis job that carries
   * just the outbox row id enqueued, under the same bound as before. A Redis failure after the durable write is not a request failure: the worker's
   * reconciler re-enqueues the row. The job id embeds the attempt count, so duplicate enqueues of one attempt collapse while a later retry is a new job.
   */
  const intakeOutbox = options.intakeOutbox ?? new PgIntakeOutbox(db);
  const enqueueOutboxJob: IntakeEnqueue = async (outboxId, attemptCount, deadlineMs) => {
    const remaining = () => Math.max(0, deadlineMs - Date.now());
    if (waitForQueueReady && !(await waitForQueueReady(remaining()))) throw new QueueUnavailableError("not_attempted");
    const outcome = await settleWithin(
      Promise.resolve().then(() =>
        telegramQueue.add(OUTBOX_QUEUE_JOB_NAME, { jobType: OUTBOX_QUEUE_JOB_NAME, outboxId }, { jobId: OUTBOX_JOB_ID(outboxId, attemptCount), attempts: 3, backoff: { type: "exponential", delay: 1000 } }),
      ),
      remaining(),
    );
    if (outcome.kind === "timeout") throw new QueueUnavailableError("timed_out_unconfirmed");
    if (outcome.kind === "error") throw outcome.error;
  };
  const intakeService = createIntakeService({ outbox: intakeOutbox, enqueue: enqueueOutboxJob });

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
  registerRiskRoutes(app, { db, authorized: checkBearerToken }); // Stage 3 / Task 6: bearer-protected internal risk approval API
  registerAgentsRoutes(app, { db, authorized: checkBearerToken }); // read-only agent status
  registerNotificationsRoutes(app, { db, authorized: checkBearerToken }); // read-only merged system-event feed
  registerSystemRoutes(app, { db, authorized: checkBearerToken, readSafety: () => currentRuntimeState().snapshot() }); // read-only safe configuration snapshot
  registerOpenApiRoute(app, { authorized: checkBearerToken });
  const adminToken = process.env["TWINS_ADMIN_API_KEY"];
  registerLiveRoutes(app, { db, authorized: checkBearerToken, isChatApproved: (chatId: string) => intakePolicy.isChatApproved(chatId), snapshotDir: process.env["TWINS_AGENT_SNAPSHOT_DIR"] || "/var/lib/twins-snapshots", providersDir: process.env["TWINS_PROVIDERS_DIR"] || "/var/lib/twins-providers", adminConfigured: adminToken !== undefined && adminToken.length >= 32 && adminToken !== apiKey, readSafety: () => currentRuntimeState().snapshot() }); // read-only intake / market / provider files / paper readiness
  // The admin route exists ONLY when a separate, long admin token is configured (it can only flip the audited paper-trading switch).
  const adminKey = process.env["TWINS_ADMIN_API_KEY"];
  if (adminKey !== undefined && adminKey !== "" && adminKey.length >= 32 && adminKey !== apiKey) {
    registerAdminRoutes(app, { db, adminAuthorized: (header) => { if (!header) return false; const [scheme, token] = header.split(" "); return scheme?.toLowerCase() === "bearer" && !!token && constantTimeCompare(token, adminKey); } });
  }
  registerPaperRoutes(app, { db, authorized: checkBearerToken }); // paper trading: bearer-protected, READ-ONLY (simulation; no order route exists)
  registerIntelligenceRoutes(app, { db, authorized: checkBearerToken }); // Stage 4 / Task 5: bearer-protected, read-only source intelligence API

  app.get("/health", async () => ({
    status: "ok",
    service: "api",
    appEnv: config.appEnv,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
  }));

  // ── Operational status (authenticated: the unauthenticated /health above stays minimal) ──
  const startedAt = new Date();
  app.get("/health/status", async (request, reply) => {
    if (!checkBearerToken(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
    const statusDir = readEnv("TWINS_STATUS_DIR");
    return buildStatus({
      now: () => new Date(),
      startedAt,
      statusDir,
      pingDatabase: async () => { await db.execute(sql`select 1`); },
      pingRedis: ownedRedis ? async () => { await ownedRedis.ping(); } : undefined,
      readSafety: () => currentRuntimeState().snapshot(),
      outboxCounts: async () => {
        const rows = await db.select({ status: schema.telegramIntakeOutbox.status, n: sql<number>`count(*)::int` }).from(schema.telegramIntakeOutbox).groupBy(schema.telegramIntakeOutbox.status);
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      },
    });
  });

  // ── Internal User API capture endpoint (absent unless TWINS_CAPTURE_INGEST_TOKEN is set; never routed publicly) ──
  if (captureToken !== undefined) {
    registerInternalIngest(app, {
      token: captureToken,
      policy: intakePolicy,
      log: structuredLog,
      intake: intakeService,
      exchange: readEnv("TELEGRAM_SIGNAL_EXCHANGE") ?? "NSE",
      instrumentType: readEnv("TELEGRAM_SIGNAL_INSTRUMENT_TYPE") ?? "equity",
      caps: captureCaps,
      requestBudgetMs: Math.min(30_000, enqueueTimeoutMs * 5),
    });
  }

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

      // Runtime safety boundary (Stage 1 / Task 2): while intake is disabled, the kill switch is active or the state is unreadable nothing is
      // enqueued. 503 + Retry-After makes Telegram redeliver the update later, so nothing is lost by pausing.
      const intakeRefusal = await evaluateSafety("intake", "api.webhook.telegram");
      if (intakeRefusal) return replyIntakePaused(reply, structuredLog, intakeRefusal);

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
      // Approved-chat gate: runs after the secret check and BEFORE normalization or any enqueue. The chat is taken from
      // the very message the normalizer would ingest (selectUpdateMessage), so approval and ingestion cannot diverge.
      // An update with no ingestible message passes through (it is acknowledged as ignored and enqueues nothing).
      const chat = describeUpdateChat(request.body);
      if (chat !== null && !intakePolicy.isChatApproved(chat.chatId)) {
        // Minimal metadata only: never the text, the sender, the secret or the raw update. The chat id (a number) is
        // logged so the owner can discover which id to approve. 200 so Telegram does not retry; the body is generic.
        log.warn("webhook.intake.chat_rejected", {
          reason: chat.chatId === null ? "chat_id_unusable" : "chat_not_approved",
          updateKind: chat.kind,
          chatType: chat.chatType,
          chatId: chat.chatId,
          approvedChats: intakePolicy.approvedChatCount,
          statusCode: 200,
        });
        return reply.code(200).send({ status: "ignored", reason: "not accepted" });
      }

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

      // Business deduplication key (NOT the correlation id): one outbox row per message revision (channel + revision identity + type).
      const jobId = `tg-${normalized.channelIdentifier}-${normalized.externalMessageId}`;
      const receivedAt = new Date();
      const correlation = { correlationId, requestId, receivedAt: receivedAt.toISOString() };
      log.info("webhook.intake.accepted", {
        jobId,
        updateId: normalized.updateId,
        channelIdentifier: normalized.channelIdentifier,
        externalMessageId: normalized.externalMessageId,
        originMessageId: normalized.originMessageId,
      });

      // Durable acceptance: 202 is returned ONLY after the outbox row is committed in PostgreSQL. A database failure is a generic 503
      // (Telegram redelivers the update; nothing was accepted). A Redis failure after the durable write is NOT an error: the worker's
      // reconciler enqueues the row, so the update is acknowledged. The identity makes a redelivery an idempotent duplicate.
      const submitted = await intakeService.submit(
        buildMessageOutboxInput({
          intakeSource: "bot_webhook",
          normalized,
          correlationId,
          receivedAt,
          payload: {
            jobType: "telegram_messages",
            providerName: "telegram-bot-webhook",
            correlation,
            telegram: {
              params: { channelIdentifier: normalized.channelIdentifier },
              normalizedMessage: normalized,
              exchange,
              instrumentType,
            },
          },
        }),
        Date.now() + enqueueTimeoutMs,
        log,
      );
      log.info(submitted.outcome === "duplicate" ? "webhook.enqueue.deduplicated" : "webhook.enqueue.succeeded", { jobId, outboxId: submitted.outboxId, enqueued: submitted.enqueued, statusCode: 202 });

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

      const latest = sorted[0];
      if (!latest) return reply.code(202).send({ status: "pending", signalId, message: "Signal has not yet been validated. Check back shortly." });

      // Mandatory stop-loss (Stage 1 / Task 4): whether this verdict is approval-eligible comes from the stop-loss evidence, never from the outcome alone.
      const eligibility = await getValidationEligibility(db, latest.id);

      return reply.code(200).send({
        signalId,
        validationId: latest.id,
        outcome: latest.outcome,
        approvalEligible: eligibility.approvalEligible,
        stopLoss: { result: eligibility.stopLossResult, reasonCode: eligibility.stopLossReasonCode, note: eligibility.note },
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
  enforceLiveTradingGuard("api"); // before any configuration or connection (buildApp enforces it again)
  // Runtime safety state for this process (Stage 1 / Task 2). The API reads it through the shared pool; unreadable state fails closed.
  const observedApi = observe("api");
  configureRuntimeState({ source: pgStateSource(getPool()), logger: observedApi.logger });
  void recordApiStart(observedApi.logger);
  // Role separation (Stage 1 / Task 3): outside local development the API must run as the least-privilege role (cannot update, delete or truncate
  // the audit tables, cannot alter them); otherwise it refuses to start (exit 82).
  if (loadConfig().appEnv !== "development") await enforceRuntimeRoleSeparation("api", getPool());
  // P0 hardening (HB-03 / HB-04): same research-eligibility probe as the worker; fatal only when the check applies
  await runResearchProbe(getDb(), observedApi.logger);
  const port = Number(readEnv("PORT") ?? "4000");
  const server = await buildApp();
  // HOST defaults to 0.0.0.0 (previous behaviour); set HOST=127.0.0.1 for loopback-only local runs.
  const host = readEnv("HOST") ?? "0.0.0.0";
  await server.listen({ port, host });
}
