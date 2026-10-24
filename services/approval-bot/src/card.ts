import { createHash } from "node:crypto";

/**
 * Card text for the approver. Plain text only (no Markdown/HTML parse mode, so nothing in it can be interpreted as markup), built ONLY from
 * the parsed claim fields and our own assessor strings. The original channel message text is never loaded by the bot (its database role cannot
 * read it) and never sent. The `raw` fields inside the stored claim (fragments of the message) are deliberately NOT used.
 */
export interface ClaimRow {
  claimId: string;
  createdAt: Date;
  parserVersion: string;
  claim: unknown;
  reasons: unknown;
  assessmentOutcome: string | null;
  externalMessageId: string;
  messageTimestamp: Date;
}

export interface CardContext {
  label: string;
  now: Date;
  ttlSeconds: number;
  cardId: string;
}

export interface RenderedCard {
  text: string;
  sha256: string;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_TEXT = 3500; // Telegram allows 4096; leave headroom
const SEVERITIES = new Set(["info", "warn", "warning", "insufficient", "reject", "error"]);

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7 ? v : null);
const fmt = (n: number | null): string => (n === null ? "not stated" : String(Math.round(n * 100) / 100));
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function shortId(cardId: string): string {
  return cardId.replace(/-/g, "").slice(0, 4).toUpperCase();
}

function expiryText(expiry: unknown): string {
  if (!isRecord(expiry)) return "not stated";
  const day = num(expiry["day"]);
  const month = num(expiry["month"]);
  const mon = month !== null && Number.isInteger(month) && month >= 1 && month <= 12 ? MONTHS[month - 1] : null;
  const dd = day !== null && Number.isInteger(day) && day >= 1 && day <= 31 ? String(day) : null;
  switch (expiry["status"]) {
    case "missing":
      return "not stated";
    case "period_word": {
      const word = typeof expiry["word"] === "string" && /^[A-Za-z]{3,12}$/.test(expiry["word"]) ? expiry["word"].toUpperCase() : null;
      return word ? `${word} (period word, no date)` : "a period word (unrecognised)";
    }
    case "full": {
      const year = num(expiry["year"]);
      return dd && mon && year !== null && Number.isInteger(year) && year >= 2000 && year <= 2100 ? `${dd} ${mon} ${year}` : "unreadable date";
    }
    case "day_month":
    case "year_dependent":
      return dd && mon ? `${dd} ${mon} (year not stated)` : "unreadable date";
    case "year_two_digit": {
      const yy = num(expiry["twoDigitYear"]);
      return dd && mon && yy !== null && Number.isInteger(yy) && yy >= 0 && yy <= 99 ? `${dd} ${mon} ${String(yy).padStart(2, "0")} (two-digit year, century unresolved)` : "unreadable date";
    }
    default:
      return "invalid or unreadable";
  }
}

function entryText(entry: unknown): string {
  if (!isRecord(entry)) return "not stated";
  switch (entry["type"]) {
    case "at":
    case "above":
    case "below":
    case "near":
      return `${entry["type"]} ${fmt(num(entry["price"]))}`;
    case "range":
      return `${fmt(num(entry["low"]))}-${fmt(num(entry["high"]))}`;
    case "market":
      return "at market";
    default:
      return "not stated";
  }
}

function formatTime(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${p(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]?.[0]}${MONTHS[date.getUTCMonth()]?.slice(1).toLowerCase()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}Z`;
}

export function ageText(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function ttlText(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`;
}

function reasonLines(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  const lines: string[] = [];
  for (const r of reasons) {
    if (!isRecord(r) || typeof r["code"] !== "string" || !/^[a-z0-9_.]{1,60}$/.test(r["code"])) continue;
    const severity = typeof r["severity"] === "string" && SEVERITIES.has(r["severity"]) ? r["severity"] : "info";
    const description = clean(r["description"], 110);
    lines.push(` - ${r["code"]} (${severity})${description ? `: ${description}` : ""}`);
  }
  return lines;
}

export function renderClaimCard(row: ClaimRow, ctx: CardContext): RenderedCard {
  const claim = isRecord(row.claim) ? row.claim : {};
  const underlying = typeof claim["underlying"] === "string" && /^(NIFTY|BANKNIFTY|SENSEX)$/.test(claim["underlying"]) ? claim["underlying"] : "unrecognised underlying";
  const strike = num(claim["strike"]);
  const optionType = claim["optionType"] === "CE" || claim["optionType"] === "PE" ? claim["optionType"] : null;
  const action = claim["action"] === "buy" ? "BUY" : claim["action"] === "sell" ? "SELL" : null;
  const intent =
    action === "BUY" ? (claim["intent"] === "long_entry_presumed" ? " (presumed long entry)" : " (direction unresolved)") : action === "SELL" ? " (unresolved: exit or fresh short?)" : "";
  const targets = Array.isArray(claim["targets"]) ? claim["targets"].map(num).filter((t): t is number => t !== null).slice(0, 5) : [];
  const basis = claim["levelBasis"] === "premium" || claim["levelBasis"] === "underlying" ? claim["levelBasis"] : "not stated";
  const view = claim["impliedUnderlyingView"] === "bullish" || claim["impliedUnderlyingView"] === "bearish" ? claim["impliedUnderlyingView"] : null;
  const flags: string[] = [];
  if (claim["levelBasisConflict"] === true) flags.push("premium and underlying levels both present");
  if (claim["optionTypeConflict"] === true) flags.push("both CE and PE mentioned");
  if (claim["compactCodeUnrecognized"] === true) flags.push("contract code not decoded");
  const messageId = /^[0-9]{1,15}/.exec(row.externalMessageId)?.[0] ?? "?";
  const revision = row.externalMessageId.includes("_edit_") ? " (edited revision)" : "";
  const parser = /^[A-Za-z0-9._-]{1,40}$/.test(row.parserVersion) ? row.parserVersion : "unknown";
  const outcome = row.assessmentOutcome && /^[A-Z_]{3,40}$/.test(row.assessmentOutcome) ? row.assessmentOutcome : "not assessed";
  const reasons = reasonLines(row.reasons);

  const head = [
    `TWINS claim ${shortId(ctx.cardId)}  |  UNVERIFIED  |  records your decision only - places NO order`,
    `Source: ${ctx.label} - message ${messageId}${revision} - posted ${formatTime(row.messageTimestamp)} (${ageText(row.messageTimestamp, ctx.now)} ago)`,
    `${action ?? "No BUY/SELL stated"}${intent} ${underlying}${strike !== null ? ` ${fmt(strike)}` : ""}${optionType ? ` ${optionType}` : ""}  |  expiry ${expiryText(claim["expiry"])}`,
    `Entry: ${entryText(claim["entry"])} | Stop: ${fmt(num(claim["stopLoss"]))} | Targets: ${targets.length > 0 ? targets.map((t) => fmt(t)).join(", ") : "not stated"} | Levels refer to: ${basis}`,
    ...(flags.length > 0 ? [`Note: ${flags.join("; ")}`] : []),
    ...(view ? [`Implied underlying view (informational only): ${view}`] : []),
    `Assessment: ${outcome}`,
  ];
  const tail = [`Parser: ${parser} | card expires in ${ttlText(ctx.ttlSeconds)}`, "Approve = your decision is recorded. Nothing is traded."];
  let shown = reasons.slice(0, 5);
  let text = "";
  for (;;) {
    const more = reasons.length - shown.length;
    text = [...head, ...shown, ...(more > 0 ? [` (+${more} more reason codes)`] : []), ...tail].join("\n");
    if (text.length <= MAX_TEXT || shown.length === 0) break;
    shown = shown.slice(0, -1);
  }
  text = text.slice(0, MAX_TEXT);
  return { text, sha256: sha(text) };
}

export function renderTestCard(ctx: CardContext): RenderedCard {
  const text = [
    `TWINS approval bot - HANDSHAKE TEST CARD ${shortId(ctx.cardId)}`,
    "This is a TEST: it is not a claim, involves no channel message and no order.",
    "Tap Approve or Reject to confirm the buttons reach the bot and are recorded.",
    `Test card expires in ${ttlText(ctx.ttlSeconds)}.`,
  ].join("\n");
  return { text, sha256: sha(text) };
}

export function renderOutcome(original: string, decision: "approve" | "reject", at: Date, test: boolean): string {
  const word = decision === "approve" ? "APPROVED (recorded only - no order)" : "REJECTED (recorded)";
  return `${original}\n\n>> ${test ? "TEST " : ""}${word} at ${at.toISOString().slice(11, 19)}Z`;
}

export function renderExpired(cardId: string): string {
  return `TWINS card ${shortId(cardId)} expired - no decision was recorded.`;
}
