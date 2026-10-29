import { createHash } from "node:crypto";

/**
 * Redaction and canonical hashing for the agent engine (Stage 5 / Task 1). Anything an agent (or an error) produces is reduced to allow-listed shapes before it is logged or stored:
 * bounded strings with secret-shaped substrings removed, closed key sets, no raw objects. The engine never receives message text in the first place (agents are given parsed fields only).
 */
const SECRET_SHAPES: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, // provider-style API keys
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex (hashes of secrets, raw keys)
  /\b[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9])/g, // long base64 / opaque tokens
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // e-mail addresses
];
/** Strips control characters, removes secret-shaped substrings and truncates. */
export function sanitizeText(value: unknown, max = 280): string {
  let s = typeof value === "string" ? value : String(value ?? "");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const re of SECRET_SHAPES) s = s.replace(re, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Deterministic JSON: object keys sorted recursively, so equal content always hashes equally. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hashOf = (v: unknown): string => sha256(stableStringify(v));

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
/** A frozen deep copy: an agent can neither see another agent's mutable state nor change the shared inputs. */
export const frozenCopy = <T>(v: T): T => deepFreeze(structuredClone(v));
