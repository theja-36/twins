/** UUID <-> 22-character base64url, so a card id fits Telegram's 64-byte callback_data limit. */
export function uuidToB64(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("not a uuid");
  return Buffer.from(hex, "hex").toString("base64url");
}

export function b64ToUuid(text: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  if (buf.length !== 16) return null;
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
