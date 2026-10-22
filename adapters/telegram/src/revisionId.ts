import { createHash } from "node:crypto";

/** Full SHA-256 (hex) of a text, UTF-8. Used for revision identity and for content-free event records. */
export function textSha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First 12 hex characters of the text's SHA-256: the content part of a revision identity. */
export function revisionHash12(text: string): string {
  return textSha256Hex(text).slice(0, 12);
}

/**
 * The ONE rule that identifies an edited revision of a Telegram message, shared by every capture path (Bot API webhook,
 * User API live capture and history import): `<original message id>_edit_<edit_date seconds>_<sha256-12 of the text>`.
 * Two paths that see the same edit must produce the same id, so storage collapses them (idempotency).
 */
export function revisionExternalId(originMessageId: string, editDateSeconds: number, text: string): string {
  return `${originMessageId}_edit_${editDateSeconds}_${revisionHash12(text)}`;
}
