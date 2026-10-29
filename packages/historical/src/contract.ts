/**
 * The historical-import INPUT CONTRACT (Stage 4 / Task 1), version `historical-contract-v1`. One message per record; JSONL (one JSON object per line, preferred), a JSON file
 * (an array, or an object with a `records` array) or CSV. Every record is validated before anything is written; a record that fails is reported by code, line and file -
 * never by content.
 *
 *   channel       string   REQUIRED  source channel identifier or label (1-80 of A-Za-z0-9 _ . : @ space -)
 *   message_id    string|int REQUIRED the message's own id within that channel
 *   timestamp     string|int REQUIRED ISO-8601 with an explicit offset (Z or +hh:mm), or Unix seconds; 2013-08-01 .. now + 1 day
 *   text          string   REQUIRED  the message text ("" for a media-only message; at most 20,000 characters)
 *   author        string   optional  handle / display label (1-80 of A-Za-z0-9 _ . @ space -); anything else is withheld
 *   market        string   optional  upper-case market code (NSE, BSE, NYSE, ...); never inferred when absent (see normalize.ts)
 *   media         array    optional  up to 20 references {type, ref}: LABELS only (no file content, no path traversal)
 *   edits         array    optional  up to 50 later revisions {edited_at, text}
 *   edited_at     string   optional  an edit marker without the edited text (kept as a warning; no revision is invented)
 * CSV columns: channel,message_id,timestamp,text[,author,market,media,edited_at,edit_text]; `media` is `type:ref;type:ref`, `edit_text` is ONE edit made at `edited_at`.
 * Unknown fields are ignored and counted (never stored): a credential-shaped extra field cannot ride along.
 */
export const CONTRACT_VERSION = "historical-contract-v1";
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_EDITS = 50;
export const MAX_MEDIA = 20;
export const EARLIEST_TIMESTAMP = Date.parse("2013-08-01T00:00:00Z"); // Telegram's launch: nothing earlier is a real message

const CHANNEL = /^[A-Za-z0-9_.:@ -]{1,80}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const AUTHOR = /^[A-Za-z0-9_.@ -]{1,80}$/;
const MARKET = /^[A-Z0-9]{2,20}$/;
const MEDIA_TYPE = /^[a-z_]{1,20}$/;
const MEDIA_REF = /^[A-Za-z0-9_.@:/-]{1,200}$/;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const KNOWN = new Set(["channel", "message_id", "timestamp", "text", "author", "market", "media", "edits", "edited_at"]);

export interface MediaRef { type: string; ref: string }
export interface MessageEdit { editedAt: Date; text: string }
export interface HistoricalMessage {
  channel: string;
  messageId: string;
  timestamp: Date;
  text: string;
  author: string | null;
  market: string | null;
  media: MediaRef[];
  edits: MessageEdit[];
  editMarkerWithoutText: boolean;
}
export type ValidationOutcome = { ok: true; message: HistoricalMessage; warnings: string[] } | { ok: false; code: string };

export function parseTimestamp(v: unknown, now: Date): Date | "invalid" | "out_of_range" {
  let ms: number;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) return "invalid";
    ms = v * 1000;
  } else if (typeof v === "string") {
    if (!ISO.test(v.trim())) return "invalid";
    ms = Date.parse(v.trim().replace(" ", "T"));
  } else return "invalid";
  if (Number.isNaN(ms)) return "invalid";
  if (ms < EARLIEST_TIMESTAMP || ms > now.getTime() + 86_400_000) return "out_of_range";
  return new Date(ms);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function validateRawRecord(raw: unknown, now: Date): ValidationOutcome {
  if (!isObject(raw)) return { ok: false, code: "record_not_an_object" };
  const warnings: string[] = [];
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) warnings.push("unknown_fields_ignored");
  const channel = typeof raw["channel"] === "string" ? raw["channel"].trim() : null;
  if (channel === null || !CHANNEL.test(channel)) return { ok: false, code: "invalid_channel" };
  const idRaw = raw["message_id"];
  const messageId = typeof idRaw === "number" ? (Number.isSafeInteger(idRaw) && idRaw >= 0 ? String(idRaw) : null) : typeof idRaw === "string" ? idRaw.trim() : null;
  if (messageId === null || !MESSAGE_ID.test(messageId)) return { ok: false, code: "invalid_message_id" };
  const ts = parseTimestamp(raw["timestamp"], now);
  if (ts === "invalid") return { ok: false, code: "invalid_timestamp" };
  if (ts === "out_of_range") return { ok: false, code: "timestamp_out_of_range" };
  if (typeof raw["text"] !== "string") return { ok: false, code: "invalid_text" };
  if (raw["text"].length > MAX_TEXT_LENGTH) return { ok: false, code: "text_too_long" };
  if (raw["text"].includes("\u0000")) return { ok: false, code: "invalid_text" };
  let author: string | null = null;
  if (raw["author"] !== undefined && raw["author"] !== null && raw["author"] !== "") {
    if (typeof raw["author"] === "string" && AUTHOR.test(raw["author"].trim())) author = raw["author"].trim();
    else warnings.push("author_withheld");
  }
  let market: string | null = null;
  if (raw["market"] !== undefined && raw["market"] !== null && raw["market"] !== "") {
    if (typeof raw["market"] !== "string" || !MARKET.test(raw["market"].trim())) return { ok: false, code: "invalid_market" };
    market = raw["market"].trim();
  }
  const media: MediaRef[] = [];
  if (raw["media"] !== undefined && raw["media"] !== null) {
    if (!Array.isArray(raw["media"])) return { ok: false, code: "invalid_media" };
    for (const m of raw["media"].slice(0, MAX_MEDIA)) {
      if (isObject(m) && typeof m["type"] === "string" && typeof m["ref"] === "string" && MEDIA_TYPE.test(m["type"]) && MEDIA_REF.test(m["ref"]) && !m["ref"].includes("..")) media.push({ type: m["type"], ref: m["ref"] });
      else warnings.push("media_ref_withheld");
    }
    if (raw["media"].length > MAX_MEDIA) warnings.push("media_truncated");
  }
  const edits: MessageEdit[] = [];
  if (raw["edits"] !== undefined && raw["edits"] !== null) {
    if (!Array.isArray(raw["edits"])) return { ok: false, code: "invalid_edits" };
    if (raw["edits"].length > MAX_EDITS) return { ok: false, code: "too_many_edits" };
    for (const e of raw["edits"]) {
      const at = isObject(e) ? parseTimestamp(e["edited_at"], now) : "invalid";
      if (isObject(e) && at instanceof Date && typeof e["text"] === "string" && e["text"].length <= MAX_TEXT_LENGTH && !e["text"].includes("\u0000")) edits.push({ editedAt: at, text: e["text"] });
      else warnings.push("edit_invalid");
    }
    edits.sort((a, b) => a.editedAt.getTime() - b.editedAt.getTime());
  }
  let editMarkerWithoutText = false;
  if (raw["edited_at"] !== undefined && raw["edited_at"] !== null && raw["edited_at"] !== "") {
    if (parseTimestamp(raw["edited_at"], now) instanceof Date) editMarkerWithoutText = edits.length === 0;
    else warnings.push("edited_at_invalid");
  }
  if (editMarkerWithoutText) warnings.push("edit_marker_without_text");
  if (ts.getTime() > now.getTime()) warnings.push("future_timestamp");
  return { ok: true, message: { channel, messageId, timestamp: ts, text: raw["text"], author, market, media, edits, editMarkerWithoutText }, warnings };
}
