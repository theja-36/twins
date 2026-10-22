import { randomUUID } from "node:crypto";

/**
 * End-to-end correlation LOGGING (not distributed tracing: there are no spans, no
 * trace/span ids and no collector). Identifier layers, all distinct:
 *  - requestId      : one HTTP request/delivery attempt (server-generated, per request).
 *  - correlationId  : follows one accepted intake through queue -> worker -> outcome and
 *                     across retries of that job. A LOG-JOIN key only.
 *  - jobId          : the queue job; for telegram it is the deterministic business
 *                     deduplication key `tg-<channel>-<message revision>`.
 *  - message identity: channelIdentifier + externalMessageId (+ originMessageId).
 *  - attempt        : which processing attempt of the job (BullMQ attemptsStarted).
 * A correlationId or requestId must NEVER be used to deduplicate business records, and
 * carrying one does not make delivery exactly-once.
 */
export interface CorrelationContext {
  correlationId: string;
  /** HTTP request id of the request that created the job (a later duplicate request has its own). */
  requestId: string;
  /** ISO time the intake was accepted. */
  receivedAt: string;
}

/** Bounded, log-safe shape accepted from outside. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

/** Server-generated HTTP request id. */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Validates an UNTRUSTED externally supplied correlation id. Returns it only if it is a single
 * short token of safe characters; otherwise undefined (callers then generate an internal id).
 */
export function acceptCorrelationId(raw: unknown): string | undefined {
  return typeof raw === "string" && CORRELATION_ID_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Reads correlation metadata from a queue job payload. Jobs queued before this feature (or
 * with malformed metadata) simply yield undefined; they must still be processed.
 */
export function parseCorrelationContext(raw: unknown): CorrelationContext | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const correlationId = acceptCorrelationId(r["correlationId"]);
  if (!correlationId) return undefined;
  const requestId = typeof r["requestId"] === "string" && r["requestId"].length <= 80 ? r["requestId"] : "unknown";
  const receivedAt = typeof r["receivedAt"] === "string" && r["receivedAt"].length <= 40 ? r["receivedAt"] : "unknown";
  return { correlationId, requestId, receivedAt };
}

/**
 * Safe, bounded error classification for logs: a stable code and the error class name only.
 * The error MESSAGE is deliberately never returned (database/provider messages can embed row
 * values or payload fragments).
 */
export function describeErrorSafely(err: unknown): { errorCode: string; errorName: string } {
  const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : "";
  const name = typeof (err as { name?: unknown } | null)?.name === "string" ? (err as { name: string }).name : "";
  return {
    errorCode: /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : "UNEXPECTED_ERROR",
    errorName: /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) ? name : "Error",
  };
}
