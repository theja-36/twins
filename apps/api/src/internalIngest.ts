import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  channelIdentifierOf,
  normalizeUserCaptureMessage,
  USER_CAPTURE_PROVIDER_NAME,
  type TelegramIntakePolicy,
} from "@twins/adapter-telegram";
import { constantTimeCompare, newCorrelationId, type StructuredLogger } from "@twins/shared";
import { validateIngestBody, type ValidatedIngest } from "./internalIngestValidation.js";

/**
 * POST /internal/ingest/telegram-user - the ONLY way the read-only User API capture service hands messages to TWINS.
 *
 * Exists only when TWINS_CAPTURE_INGEST_TOKEN is configured (otherwise the route is absent: 404). Never given a reverse-proxy
 * route; as a second line of defence any request that carries proxy headers is refused. The API stays write-free: it
 * validates, applies the approved-chat gate and enqueues; the worker stores. Options-only and parsing stay in the worker.
 */
export const INTERNAL_INGEST_PATH = "/internal/ingest/telegram-user";
export const INTERNAL_INGEST_BODY_LIMIT = 2 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const TOKEN_CHARS = /^[A-Za-z0-9_\-+=.~]+$/;
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "via"];

export interface CaptureCaps {
  /** Requests per minute (counted after authentication). */
  requestsPerMinute: number;
  /** api_live messages (and deletion ids) per hour. */
  liveMessagesPerHour: number;
  /** api_history messages per day. */
  historyMessagesPerDay: number;
}
export const DEFAULT_CAPTURE_CAPS: CaptureCaps = { requestsPerMinute: 60, liveMessagesPerHour: 600, historyMessagesPerDay: 2000 };

/** Returns the token, or undefined when the endpoint is disabled (unset/empty). Throws (fail-closed) when it is unusable. */
export function resolveCaptureIngestToken(option: string | undefined, env: string | undefined, others: { apiKey: string; webhookSecret: string }): string | undefined {
  const raw = option ?? env;
  if (raw === undefined || raw === "") return undefined;
  if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH || !TOKEN_CHARS.test(raw)) {
    throw new Error(`TWINS_CAPTURE_INGEST_TOKEN must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters of A-Z a-z 0-9 _ - + = . ~ (no spaces)`);
  }
  if (raw === others.apiKey || raw === others.webhookSecret) {
    throw new Error("TWINS_CAPTURE_INGEST_TOKEN must differ from TWINS_API_KEY and TELEGRAM_WEBHOOK_SECRET");
  }
  return raw;
}

function capFrom(option: number | undefined, env: string | undefined, fallback: number, name: string): number {
  const raw = option !== undefined ? String(option) : env;
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,7}$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer (1-9999999)`);
  return Number(raw);
}

export function resolveCaptureCaps(option: Partial<CaptureCaps> | undefined, env: Record<string, string | undefined>): CaptureCaps {
  return {
    requestsPerMinute: capFrom(option?.requestsPerMinute, env["TWINS_CAPTURE_MAX_REQUESTS_PER_MINUTE"], DEFAULT_CAPTURE_CAPS.requestsPerMinute, "TWINS_CAPTURE_MAX_REQUESTS_PER_MINUTE"),
    liveMessagesPerHour: capFrom(option?.liveMessagesPerHour, env["TWINS_CAPTURE_MAX_LIVE_PER_HOUR"], DEFAULT_CAPTURE_CAPS.liveMessagesPerHour, "TWINS_CAPTURE_MAX_LIVE_PER_HOUR"),
    historyMessagesPerDay: capFrom(option?.historyMessagesPerDay, env["TWINS_CAPTURE_MAX_HISTORY_PER_DAY"], DEFAULT_CAPTURE_CAPS.historyMessagesPerDay, "TWINS_CAPTURE_MAX_HISTORY_PER_DAY"),
  };
}

/** Fixed-window counter (in memory, single API instance; resets on restart). */
export class WindowCounter {
  private windowId = -1;
  private used = 0;
  constructor(private readonly windowMs: number, private readonly limit: number) {}
  /** Consumes `n` if it fits; otherwise returns the seconds until the window ends. */
  tryConsume(n: number, nowMs: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const id = Math.floor(nowMs / this.windowMs);
    if (id !== this.windowId) {
      this.windowId = id;
      this.used = 0;
    }
    if (this.used + n > this.limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((id + 1) * this.windowMs - nowMs) / 1000)) };
    this.used += n;
    return { ok: true };
  }
}

export interface AddCaptureJob {
  name: "telegram_messages" | "telegram_events";
  jobId: string;
  data: unknown;
  /** Absolute deadline (epoch ms) for the whole request's queue work. */
  deadlineMs: number;
}
export type AddCaptureJobResult = "added" | "duplicate";

export interface InternalIngestDeps {
  token: string;
  policy: Pick<TelegramIntakePolicy, "isChatApproved">;
  log: StructuredLogger;
  /** Bounded enqueue provided by the API (throws the API's generic 503 error when the queue is unavailable). */
  addJob: (job: AddCaptureJob) => Promise<AddCaptureJobResult>;
  exchange: string;
  instrumentType: string;
  caps: CaptureCaps;
  /** Overall queue-work budget per request. */
  requestBudgetMs: number;
  now?: () => Date;
}

function hasProxyHeader(headers: FastifyRequest["headers"]): boolean {
  return PROXY_HEADERS.some((name) => headers[name] !== undefined);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const [scheme, value, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value || rest.length > 0) return false;
  return constantTimeCompare(value, token);
}

const sha12 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

export function registerInternalIngest(app: FastifyInstance, deps: InternalIngestDeps): void {
  const now = deps.now ?? (() => new Date());
  const perMinute = new WindowCounter(60_000, deps.caps.requestsPerMinute);
  const liveHour = new WindowCounter(3_600_000, deps.caps.liveMessagesPerHour);
  const historyDay = new WindowCounter(86_400_000, deps.caps.historyMessagesPerDay);

  app.post(
    INTERNAL_INGEST_PATH,
    {
      bodyLimit: INTERNAL_INGEST_BODY_LIMIT,
      // Runs BEFORE the body is read or parsed: unauthenticated or proxied callers never get their payload looked at.
      onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
        if (hasProxyHeader(request.headers)) {
          deps.log.warn("capture.ingest.rejected", { requestId: request.id, reason: "proxy_header", statusCode: 404 });
          return reply.code(404).send({ error: "Not Found" });
        }
        if (!bearerMatches(request.headers.authorization, deps.token)) {
          deps.log.warn("capture.ingest.rejected", { requestId: request.id, reason: "unauthorized", statusCode: 401 });
          return reply.code(401).send({ error: "Unauthorized" });
        }
        const rate = perMinute.tryConsume(1, now().getTime());
        if (!rate.ok) {
          deps.log.warn("capture.ingest.rejected", { requestId: request.id, reason: "request_rate", statusCode: 429 });
          return reply.code(429).header("Retry-After", String(rate.retryAfterSeconds)).send({ error: "Too Many Requests" });
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const received = now();
      const correlationId = newCorrelationId();
      const log = deps.log.child({ requestId: request.id, correlationId });

      const validation = validateIngestBody(request.body, received.getTime());
      if (!validation.ok) {
        log.warn("capture.ingest.rejected", { reason: "invalid_payload", problems: validation.problems.length, statusCode: 400 });
        return reply.code(400).send({ error: "Invalid payload", problems: validation.problems });
      }
      const input = validation.value;

      // Approved-chat gate (same policy object as the webhook and the worker). Nothing is enqueued for any other chat.
      if (!deps.policy.isChatApproved(input.chat.id)) {
        log.warn("capture.ingest.rejected", { reason: "chat_not_approved", chatId: String(input.chat.id), count: input.event === "delete" ? input.deletedMessageIds.length : input.messages.length, statusCode: 403 });
        return reply.code(403).send({ error: "chat_not_approved" });
      }

      const count = input.event === "delete" ? input.deletedMessageIds.length : input.messages.length;
      const counter = input.captureMethod === "api_history" ? historyDay : liveHour;
      const cap = counter.tryConsume(count, received.getTime());
      if (!cap.ok) {
        log.warn("capture.ingest.rejected", { reason: "volume_cap", captureMethod: input.captureMethod, count, statusCode: 429 });
        return reply.code(429).header("Retry-After", String(cap.retryAfterSeconds)).send({ error: "Too Many Requests", reason: "volume_cap" });
      }

      const deadlineMs = Date.now() + deps.requestBudgetMs;
      const result = input.event === "delete" ? await enqueueDeletion(input, received, deadlineMs) : await enqueueMessages(input, received, deadlineMs);
      log.info("capture.ingest.accepted", { captureMethod: input.captureMethod, ingestEvent: input.event, chatId: String(input.chat.id), ...result, statusCode: 200 });
      return reply.code(200).send({ ...result, rejected: [] });

      function captureMeta(observedAt: Date) {
        return {
          captureMethod: input.captureMethod,
          observedAt: observedAt.toISOString(),
          ...(input.captureMethod === "api_history" ? { importedAt: observedAt.toISOString() } : {}),
          ...(input.importBatch ? { importBatchId: input.importBatch.batchId } : {}),
          ...(input.clientObservedAt ? { clientObservedAt: input.clientObservedAt } : {}),
        };
      }

      async function enqueueMessages(v: ValidatedIngest, observedAt: Date, deadline: number) {
        let accepted = 0;
        let duplicates = 0;
        let ignored = 0;
        const correlation = { correlationId, requestId: request.id, receivedAt: observedAt.toISOString() };
        for (const message of v.messages) {
          const normalized = normalizeUserCaptureMessage(v.chat, message);
          if (normalized === null) {
            ignored += 1; // no text/caption: nothing to store (same as the Bot API path)
            continue;
          }
          const outcome = await deps.addJob({
            name: "telegram_messages",
            // Same deterministic job id as the Bot API path, so live and history captures of one message collapse.
            jobId: `tg-${normalized.channelIdentifier}-${normalized.externalMessageId}`,
            deadlineMs: deadline,
            data: {
              jobType: "telegram_messages",
              providerName: USER_CAPTURE_PROVIDER_NAME,
              correlation,
              telegram: {
                params: { channelIdentifier: normalized.channelIdentifier },
                normalizedMessage: normalized,
                exchange: deps.exchange,
                instrumentType: deps.instrumentType,
                capture: captureMeta(observedAt),
              },
            },
          });
          if (outcome === "added") accepted += 1;
          else duplicates += 1;
        }
        return { accepted, duplicates, ignored };
      }

      async function enqueueDeletion(v: ValidatedIngest, observedAt: Date, deadline: number) {
        const ids = [...new Set(v.deletedMessageIds)].sort((a, b) => a - b).map(String);
        const channelIdentifier = channelIdentifierOf(v.chat.id);
        const outcome = await deps.addJob({
          name: "telegram_events",
          jobId: `tg-events-del-${channelIdentifier}-${sha12(ids.join(","))}`,
          deadlineMs: deadline,
          data: {
            jobType: "telegram_events",
            providerName: USER_CAPTURE_PROVIDER_NAME,
            correlation: { correlationId, requestId: request.id, receivedAt: observedAt.toISOString() },
            events: { kind: "delete", channelIdentifier, chatId: String(v.chat.id), messageIds: ids, capture: captureMeta(observedAt) },
          },
        });
        return { accepted: outcome === "added" ? ids.length : 0, duplicates: outcome === "duplicate" ? ids.length : 0, ignored: 0 };
      }
    },
  );
}
