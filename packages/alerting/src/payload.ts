/**
 * Alert payload contract (docs/twins/OPERATIONAL_ALERTING.md). An alert is a small, fixed-shape JSON object. It is built ONLY from fixed
 * templates and an ALLOW-LIST of detail keys whose values are scrubbed, so message text, credentials and free-form error messages cannot get in.
 */
export type Severity = "INFO" | "WARNING" | "CRITICAL";
export const SEVERITIES: readonly Severity[] = ["INFO", "WARNING", "CRITICAL"];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export interface AlertPayload {
  /** Contract version. */
  v: 1;
  event: string;
  severity: Severity;
  environment: string;
  service: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  /** Commit SHA or image tag of the code that raised the alert; "unknown" when not available. */
  build: string;
  correlationId?: string;
  /** Safe machine code (A-Za-z0-9_.:-), e.g. checksum_mismatch. */
  code: string;
  /** Fixed-template human text; never contains message content or an error message. */
  summary: string;
  details: Record<string, string | number | boolean>;
}

/** The ONLY detail keys that may travel in an alert. Everything else is dropped. */
export const DETAIL_ALLOWLIST = [
  "name", "step", "failure", "count", "attempt", "maxAttempts", "outboxId", "channelId", "messageType", "control", "version", "previousValue", "newValue",
  "changedBy", "chain", "rows", "ageSeconds", "bytes", "sha256", "reason", "action", "unit", "kind", "restarts", "windowSeconds", "oldestAgeSeconds", "firstFailure",
] as const;
const ALLOWED = new Set<string>(DETAIL_ALLOWLIST);

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_NAME = /^[A-Za-z0-9_.:/@-]{1,120}$/;

/** Patterns that must never appear in any value, whatever the key. A matching value is replaced, not trimmed. */
const SECRET_VALUE: RegExp[] = [
  /AGE-SECRET-KEY-1[0-9A-Z]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, // URL with credentials
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*\S{4,}/i,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, // Telegram bot token shape
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Fa-f0-9]{96,}\b/,
  /\b[A-Za-z0-9+/_-]{48,}={0,2}\b/, // long opaque strings (keys, tokens); sha256 (64 hex) is handled by its own key below
];

export function scrubString(value: string, key?: string): string {
  const v = value.length > 200 ? `${value.slice(0, 200)}...[truncated]` : value;
  if (key === "sha256") return /^[0-9a-f]{64}$/.test(v) ? v : "[redacted]";
  if (key === "outboxId") return /^[0-9a-f-]{36}$/i.test(v) ? v : "[redacted]";
  if (SECRET_VALUE.some((rx) => rx.test(v))) return "[redacted]";
  return SAFE_NAME.test(v) ? v : "[redacted]";
}

export function sanitizeDetails(details: Record<string, unknown> | undefined): AlertPayload["details"] {
  const out: AlertPayload["details"] = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (!ALLOWED.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = scrubString(v, k);
  }
  return out;
}

export interface AlertContext {
  environment: string;
  service: string;
  build?: string | undefined;
}

export interface AlertInput {
  event: string;
  severity: Severity;
  code: string;
  summary: string;
  correlationId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export function buildAlert(input: AlertInput, context: AlertContext, now: Date = new Date()): AlertPayload {
  if (!SEVERITIES.includes(input.severity)) throw new Error("unknown severity");
  if (!/^[a-z][a-z0-9_.]{1,60}$/.test(input.event)) throw new Error("bad alert event name");
  const correlation = input.correlationId && /^[A-Za-z0-9_-]{4,80}$/.test(input.correlationId) ? input.correlationId : undefined;
  return {
    v: 1,
    event: input.event,
    severity: input.severity,
    environment: SAFE_CODE.test(context.environment) ? context.environment : "unknown",
    service: SAFE_CODE.test(context.service) ? context.service : "unknown",
    timestamp: now.toISOString(),
    build: context.build && SAFE_NAME.test(context.build) && !SECRET_VALUE.some((rx) => rx.test(context.build ?? "")) ? context.build : "unknown",
    ...(correlation ? { correlationId: correlation } : {}),
    code: SAFE_CODE.test(input.code) ? input.code : "unspecified",
    summary: scrubSummary(input.summary),
    details: sanitizeDetails(input.details),
  };
}

/** Summaries come from fixed templates; this is a second line of defence (printable ASCII only, no secret shapes, bounded). */
export function scrubSummary(text: string): string {
  const t = text.replace(/[^\x20-\x7e]/g, " ").slice(0, 240);
  return SECRET_VALUE.some((rx) => rx.test(t)) ? "[redacted summary]" : t;
}
