/**
 * Redaction of secret-shaped and personal strings before ANY storage (Stage 4 / Task 1). The high-confidence credential patterns are the repository secret scanner's
 * own (scripts/ci/secret-scan.mjs; a unit test keeps the two lists identical); on top of them: e-mail addresses, international phone numbers written with a leading `+`,
 * and Telegram invite links. A match is replaced by `[REDACTED:<kind>]`; the original is never stored or logged. Prices and other plain numbers are untouched.
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["github_fine_grained_token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["api_secret_key", /\bsk-[A-Za-z0-9_-]{30,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["telegram_bot_token", /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/],
];
const EXTRA: ReadonlyArray<readonly [string, RegExp]> = [
  ["url_with_password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s:@/'"`]{4,}@[^\s/'"`]+/gi],
  ["quoted_secret_assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9+/_=.-]{8,}["']?/gi],
  ["email_address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["phone_number", /(?<![A-Za-z0-9])\+\d[\d\s-]{8,14}\d(?![A-Za-z0-9])/g],
  ["telegram_invite_link", /\b(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/gi],
];

export interface Redaction { text: string; kinds: string[] }

export function redactSecrets(text: string): Redaction {
  let out = text;
  const kinds = new Set<string>();
  for (const [kind, rx] of [...SECRET_PATTERNS.map(([k, r]) => [k, new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`)] as const), ...EXTRA]) {
    out = out.replace(rx, () => { kinds.add(kind); return `[REDACTED:${kind}]`; });
  }
  return { text: out, kinds: [...kinds].sort() };
}
