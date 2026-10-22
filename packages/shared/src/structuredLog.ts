/**
 * Minimal structured (JSON-lines) logging with built-in redaction. No external backend.
 * Callers log explicit, known-safe fields; a defensive filter additionally masks values
 * whose KEY looks sensitive or like message/payload content, bounds string lengths and
 * never serialises Error objects beyond their class name.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogRecord = Record<string, unknown> & { ts: string; level: LogLevel; event: string };
export type LogSink = (record: LogRecord) => void;

export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `base` to every record (per-job/per-request context, no shared state). */
  child(base: LogFields): StructuredLogger;
}

const SENSITIVE_KEY = /(secret|token|authorization|password|passwd|api[_-]?key|cookie|credential|raw|text|payload|body|content)/i;
const MAX_STRING = 200;
const MAX_ARRAY = 10;
const MAX_DEPTH = 3;
const RESERVED = new Set(["ts", "level", "event"]);

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { errorName: /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(value.name) ? value.name : "Error" };
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === "object") return sanitizeFields(value as LogFields, depth + 1);
  return String(typeof value);
}

export function sanitizeFields(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED.has(k)) continue;
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : sanitizeValue(v, depth);
  }
  return out;
}

export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

export function createStructuredLogger(sink: LogSink = consoleSink, base: LogFields = {}, now: () => Date = () => new Date()): StructuredLogger {
  const baseSafe = sanitizeFields(base);
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    sink({ ...baseSafe, ...sanitizeFields(fields), ts: now().toISOString(), level, event });
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (more) => createStructuredLogger(sink, { ...baseSafe, ...sanitizeFields(more) }, now),
  };
}
