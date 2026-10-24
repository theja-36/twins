import { createHmac, timingSafeEqual } from "node:crypto";
import { b64ToUuid, uuidToB64 } from "./ids";

/**
 * Signed button data: `v1.<card id, 22 chars>.<a|r>.<mac, 16 chars>` (44 bytes, Telegram allows 64). The MAC is an HMAC-SHA256 over
 * card id, action and the card's random nonce with a key that exists only in the bot's env file, so a forged, edited, reused or
 * cross-card callback does not verify. Only Telegram can deliver updates to a long-polling bot, but a tampered button must still fail.
 */
export type CallbackAction = "a" | "r";

function macOf(key: Buffer, cardId: string, nonce: string, action: CallbackAction): string {
  return createHmac("sha256", key).update(`${cardId}|${action}|${nonce}`).digest().subarray(0, 12).toString("base64url");
}

export function buildCallbackData(key: Buffer, cardId: string, nonce: string, action: CallbackAction): string {
  return `v1.${uuidToB64(cardId)}.${action}.${macOf(key, cardId, nonce, action)}`;
}

export interface ParsedCallback {
  cardId: string;
  action: CallbackAction;
  mac: string;
}

export function parseCallbackData(data: unknown): ParsedCallback | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const m = /^v1\.([A-Za-z0-9_-]{22})\.([ar])\.([A-Za-z0-9_-]{16})$/.exec(data);
  if (!m) return null;
  const cardId = b64ToUuid(m[1] as string);
  return cardId === null ? null : { cardId, action: m[2] as CallbackAction, mac: m[3] as string };
}

export function verifyCallback(key: Buffer, parsed: ParsedCallback, nonce: string): boolean {
  const expected = Buffer.from(macOf(key, parsed.cardId, nonce, parsed.action));
  const given = Buffer.from(parsed.mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
