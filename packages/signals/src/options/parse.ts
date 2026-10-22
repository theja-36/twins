import {
  isReservedUnderlyingToken,
  type EntryCondition,
  type ExpiryClaim,
  type LevelBasis,
  type OptionAction,
  type OptionType,
  type OptionsClaim,
  type OptionsTextAnalysis,
  type Underlying,
} from "./types";

/**
 * Deterministic options-claim parsing: plain pattern matching, no AI, no inference. Follows the equity parser's
 * conventions (literal captures, absent means absent). Accepted underlying spellings are exactly NIFTY, BANKNIFTY,
 * SENSEX and the alias "BANK NIFTY" (normalized); nothing fuzzy.
 */

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
const MONTH_ALT = "JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC";
const NUM = "(\\d+(?:\\.\\d+)?)";

const UNDERLYING_RE = /(?<![A-Z0-9])(BANKNIFTY|NIFTY|SENSEX)(?![A-Z])/;
const UNDERLYING_AT_START_RE = /^\s*(BANKNIFTY|NIFTY|SENSEX)(?![A-Z])/;
const BANK_NIFTY_ALIAS_RE = /(?<![A-Za-z0-9])BANK\s+NIFTY(?![A-Za-z])/gi;
const STRIKE_TYPE_RE = /(?<![\d.])(\d{4,6})\s*(CE|PE|CALL|PUT)(?![A-Z])/g;
const TYPE_STRIKE_RE = /(?<![A-Z])(CE|PE|CALL|PUT)\s*(\d{4,6})(?![\d.])/g;
const TYPE_ONLY_RE = /(?<![A-Z])(CE|PE|CALL|PUT)(?![A-Z])/g;
const STRIKE_AFTER_UNDERLYING_RE = /^\s*(\d{4,6})(?![\d.])/;
const COMPACT_UNRECOGNIZED_RE = /(?<![A-Z0-9])(?:BANKNIFTY|NIFTY|SENSEX)(\d{7,})(CE|PE)(?![A-Z])/;
const DAY_MONTH_RE = new RegExp(`(?<![\\d.])(\\d{1,2})\\s*[-/ ]?\\s*(${MONTH_ALT})(?![A-Z])(?:\\s*[-'’/,]?\\s*(20\\d{2})(?!\\d)|['’/-](\\d{2})(?!\\d))?`);
const MONTH_DAY_RE = new RegExp(`(?<![A-Z])(${MONTH_ALT})(?![A-Z])\\s*[- ]?\\s*(\\d{1,2})(?:ST|ND|RD|TH)?(?![\\d.])(?:\\s*,?\\s*(20\\d{2})(?!\\d))?`);
const PERIOD_RE = /(?<![A-Z])(WEEKLY|MONTHLY|(?:CURRENT|NEXT)\s+(?:WEEK|MONTH))(?![A-Z])/;
// A label may be followed by a Telegram-style separator: ":", "=", ":-", "-" (whitespace, including line breaks, is already collapsed).
const LABEL_SEP = "\\s*(?:[:=]+-*|-+)?\\s*";
const SL_RE = new RegExp(`(?<![A-Z])(?:SL|STOP\\s*LOSS|STOPLOSS)${LABEL_SEP}(?:BELOW|ABOVE|AT)?\\s*${NUM}`);
const TARGET_KEYWORD_RE = new RegExp(`(?<![A-Z])(?:TGTS?|TARGETS?|TP)${LABEL_SEP}`);
const TARGET_LIST_RE = new RegExp(`^${NUM}(?:\\s*(?:,|/|;|&|AND|-)?\\s*${NUM})*`);
const PREMIUM_MARKER_RE = /(?<![A-Z])(PREMIUM|PREM)(?![A-Z])/;
const UNDERLYING_MARKER_RE = /(?<![A-Z])(UNDERLYING|SPOT|INDEX)(?![A-Z])/;

function normalize(raw: string): { text: string; aliasUsed: boolean } {
  const upper = raw.replace(/\s+/g, " ").trim().toUpperCase();
  const aliasUsed = new RegExp(BANK_NIFTY_ALIAS_RE.source, "i").test(upper);
  return { text: upper.replace(BANK_NIFTY_ALIAS_RE, "BANKNIFTY"), aliasUsed };
}

/** Text with the "BANK NIFTY" alias normalized, for callers that must treat it as one token. */
export function normalizeUnderlyingAliases(raw: string): string {
  return raw.replace(BANK_NIFTY_ALIAS_RE, "BANKNIFTY");
}

/** Non-stateful test (the pattern constants above carry the global flag for matchAll). */
function has(re: RegExp, s: string): boolean {
  return new RegExp(re.source, re.flags.replace("g", "")).test(s);
}

function daysIn(month: number, year: number | null): number {
  if (month === 2) return year === null ? 29 : (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function buildExpiry(day: number, month: number, year: number | null, raw: string): ExpiryClaim {
  if (day < 1 || day > daysIn(month, year)) {
    return { status: "invalid", reason: year === null ? `day ${day} does not exist in month ${month}` : `${day}/${month}/${year} is not a calendar date`, raw };
  }
  if (year === null) return month === 2 && day === 29 ? { status: "year_dependent", day, month, raw } : { status: "day_month", day, month, raw };
  return { status: "full", day, month, year, raw };
}

function parseExpiry(segment: string): { expiry: ExpiryClaim; span: string | null } {
  const dm = DAY_MONTH_RE.exec(segment);
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS[(dm[2] ?? "").slice(0, 3)] ?? 0;
    if (dm[4]) {
      // A two-digit year is NOT expanded to a century (no policy exists): kept as written, unresolved.
      const base = buildExpiry(day, month, null, dm[0].trim());
      if (base.status === "invalid") return { expiry: base, span: dm[0] };
      return { expiry: { status: "year_two_digit", day, month, twoDigitYear: Number(dm[4]), raw: dm[0].trim() }, span: dm[0] };
    }
    const year = dm[3] ? Number(dm[3]) : null;
    return { expiry: buildExpiry(day, month, year, dm[0].trim()), span: dm[0] };
  }
  const md = MONTH_DAY_RE.exec(segment);
  if (md) {
    const month = MONTHS[(md[1] ?? "").slice(0, 3)] ?? 0;
    return { expiry: buildExpiry(Number(md[2]), month, md[3] ? Number(md[3]) : null, md[0].trim()), span: md[0] };
  }
  const pw = PERIOD_RE.exec(segment);
  if (pw) return { expiry: { status: "period_word", word: pw[1] ?? "" }, span: pw[0] };
  return { expiry: { status: "missing" }, span: null };
}

const toType = (t: string): OptionType => (t === "CE" || t === "CALL" ? "CE" : "PE");

interface Contract {
  strike: number | null;
  optionType: OptionType | null;
  compactCodeUnrecognized: boolean;
  optionTypeConflict: boolean;
  distinctContracts: Set<string>;
  spans: string[];
}

function parseContract(segment: string): Contract {
  const spans: string[] = [];
  const contracts = new Set<string>();
  const types = new Set<OptionType>();
  let strike: number | null = null;
  for (const m of segment.matchAll(STRIKE_TYPE_RE)) {
    strike = Number(m[1]);
    contracts.add(`${m[1]}${toType(m[2] ?? "")}`);
    types.add(toType(m[2] ?? ""));
    spans.push(m[0]);
  }
  if (contracts.size === 0) {
    for (const m of segment.matchAll(TYPE_STRIKE_RE)) {
      strike = Number(m[2]);
      contracts.add(`${m[2]}${toType(m[1] ?? "")}`);
      types.add(toType(m[1] ?? ""));
      spans.push(m[0]);
    }
  }
  const compact = COMPACT_UNRECOGNIZED_RE.exec(segment);
  if (compact) {
    types.add(compact[2] === "CE" ? "CE" : "PE");
    spans.push(compact[0]);
  }
  for (const m of segment.matchAll(TYPE_ONLY_RE)) types.add(toType(m[1] ?? "")); // stray CE/PE words count: conflicts are reported, not guessed
  if (contracts.size === 0) {
    const after = STRIKE_AFTER_UNDERLYING_RE.exec(segment.replace(UNDERLYING_RE, " ").replace(/^\s+/, ""));
    if (after && !compact) strike = Number(after[1]);
  }
  const optionTypeConflict = types.size > 1;
  return {
    strike: contracts.size > 1 ? null : strike,
    optionType: optionTypeConflict ? null : ([...types][0] ?? null),
    compactCodeUnrecognized: Boolean(compact),
    optionTypeConflict,
    distinctContracts: contracts,
    spans,
  };
}

function parseLevels(levelsText: string): { entry: EntryCondition; stopLoss: number | null; targets: number[]; cleaned: string } {
  let text = levelsText;
  let stopLoss: number | null = null;
  const sl = SL_RE.exec(text);
  if (sl) {
    stopLoss = Number(sl[1]);
    text = text.replace(sl[0], " ");
  }
  let targets: number[] = [];
  const tk = TARGET_KEYWORD_RE.exec(text);
  if (tk) {
    const rest = text.slice(tk.index + tk[0].length);
    const list = TARGET_LIST_RE.exec(rest);
    if (list) {
      targets = (list[0].match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      text = text.slice(0, tk.index) + " " + rest.slice(list[0].length);
    } else {
      text = text.slice(0, tk.index) + " " + rest;
    }
  }
  const num = (s: string | undefined) => Number(s);
  let entry: EntryCondition = { type: "unspecified" };
  const range = new RegExp(`(?:@|ENTRY\\s*[:=]?|BETWEEN|NEAR|AROUND)\\s*${NUM}\\s*(?:-|–|TO|AND)\\s*${NUM}`).exec(text);
  const above = new RegExp(`(?<![A-Z])ABOVE\\s*[:=]?\\s*${NUM}`).exec(text);
  const below = new RegExp(`(?<![A-Z])BELOW\\s*[:=]?\\s*${NUM}`).exec(text);
  const near = new RegExp(`(?<![A-Z])(?:NEAR|AROUND)\\s*[:=]?\\s*${NUM}`).exec(text);
  const at = new RegExp(`(?:@|ENTRY\\s*[:=]?)\\s*${NUM}`).exec(text);
  if (range) entry = { type: "range", low: Math.min(num(range[1]), num(range[2])), high: Math.max(num(range[1]), num(range[2])) };
  else if (above) entry = { type: "above", price: num(above[1]) };
  else if (below) entry = { type: "below", price: num(below[1]) };
  else if (near) entry = { type: "near", price: num(near[1]) };
  else if (at) entry = { type: "at", price: num(at[1]) };
  else if (/(?<![A-Z])(CMP|MARKET|MKT)(?![A-Z])/.test(text)) entry = { type: "market" };
  return { entry, stopLoss, targets, cleaned: text };
}

function levelBasisOf(segment: string): { basis: LevelBasis; conflict: boolean } {
  const premium = PREMIUM_MARKER_RE.test(segment);
  const underlying = UNDERLYING_MARKER_RE.test(segment);
  if (premium && underlying) return { basis: "unspecified", conflict: true };
  return { basis: premium ? "premium" : underlying ? "underlying" : "unspecified", conflict: false };
}

interface Segment {
  action: OptionAction | null;
  text: string;
}

function segmentsOf(text: string): Segment[] {
  const marks = [...text.matchAll(/(?<![A-Z])(BUY|SELL)(?![A-Z])/g)];
  if (marks.length === 0) return [{ action: null, text }];
  return marks.map((m, i) => ({
    action: (m[1] === "BUY" ? "buy" : "sell") as OptionAction,
    text: text.slice((m.index ?? 0) + m[0].length, marks[i + 1]?.index ?? text.length),
  }));
}

function claimFromSegment(seg: Segment, aliasUsed: boolean): { claim: OptionsClaim; key: string } | null {
  const u = UNDERLYING_RE.exec(seg.text);
  if (!u) return null;
  const underlying = u[1] as Underlying;
  const contract = parseContract(seg.text);
  const { expiry, span } = parseExpiry(seg.text);
  let levelsText = seg.text.replace(UNDERLYING_RE, " ");
  for (const s of contract.spans) levelsText = levelsText.replace(s, " ");
  if (span) levelsText = levelsText.replace(span, " ");
  levelsText = levelsText.replace(PERIOD_RE, " ");
  if (contract.strike !== null && contract.optionType === null) levelsText = levelsText.replace(STRIKE_AFTER_UNDERLYING_RE, " ");
  const { entry, stopLoss, targets } = parseLevels(levelsText);
  const basis = levelBasisOf(seg.text);
  const intent = seg.action === "buy" ? "long_entry_presumed" : "unresolved";
  const claim: OptionsClaim = {
    action: seg.action,
    intent,
    underlying,
    underlyingAliasUsed: aliasUsed,
    strike: contract.strike,
    optionType: contract.optionType,
    compactCodeUnrecognized: contract.compactCodeUnrecognized,
    optionTypeConflict: contract.optionTypeConflict,
    expiry,
    entry,
    stopLoss,
    targets,
    levelBasis: basis.basis,
    levelBasisConflict: basis.conflict,
    impliedUnderlyingView:
      intent === "long_entry_presumed" && contract.optionType ? (contract.optionType === "CE" ? "bullish" : "bearish") : "unresolved",
  };
  return { claim, key: `${seg.action}|${underlying}|${contract.strike}|${contract.optionType}` };
}

/**
 * Recognizes options-style directives. A directive is options-style when the token after BUY/SELL is an index
 * underlying (NIFTY / BANKNIFTY / SENSEX / "BANK NIFTY"), or when a message without BUY/SELL names an underlying
 * together with CE/PE. Several distinct contracts/actions are reported as ambiguous, never merged or guessed.
 * Equity directives are NOT handled here (kind "none").
 */
export function analyzeOptionsText(raw: string): OptionsTextAnalysis {
  const { text, aliasUsed } = normalize(raw);
  const segments = segmentsOf(text);
  const optionsSegments = segments.filter((s) =>
    s.action ? has(UNDERLYING_AT_START_RE, s.text) : has(UNDERLYING_RE, s.text) && (has(STRIKE_TYPE_RE, s.text) || has(TYPE_ONLY_RE, s.text) || has(COMPACT_UNRECOGNIZED_RE, s.text)),
  );
  if (optionsSegments.length === 0) return { kind: "none" };

  const parsed = optionsSegments.map((s) => claimFromSegment(s, aliasUsed)).filter((p): p is NonNullable<typeof p> => p !== null);
  const distinct = new Map<string, OptionsClaim>();
  for (const p of parsed) if (!distinct.has(p.key)) distinct.set(p.key, p.claim);

  const contractCounts = optionsSegments.map((s) => parseContract(s.text).distinctContracts.size);
  const first = [...distinct.values()][0];
  if (distinct.size === 1 && first && contractCounts.every((n) => n <= 1) && segments.length === optionsSegments.length) {
    return { kind: "options_claim", claim: first };
  }
  // several contracts/actions, or an options directive alongside other BUY/SELL directives: never merged into one claim
  return { kind: "ambiguous", directives: describeDirectives(segments), optionsRelated: true };
}

function describeDirectives(segments: Segment[]): Array<{ direction: OptionAction; symbol: string }> {
  const out: Array<{ direction: OptionAction; symbol: string }> = [];
  for (const s of segments) {
    if (!s.action) continue;
    const u = UNDERLYING_AT_START_RE.exec(s.text);
    const contracts = [...parseContract(s.text).distinctContracts];
    if (u && contracts.length > 1) for (const c of contracts) out.push({ direction: s.action, symbol: `${u[1]} ${c}` });
    else if (u) {
      const c = parseContract(s.text);
      out.push({ direction: s.action, symbol: `${u[1]} ${c.strike ?? "?"} ${c.optionType ?? "?"}` });
    } else {
      const sym = /^\s*([A-Z][A-Z0-9&.-]{0,19})/.exec(s.text)?.[1];
      if (sym) out.push({ direction: s.action, symbol: sym });
    }
  }
  return out;
}

export { isReservedUnderlyingToken };


const FILLER =
  `(?!SL(?![A-Z])|TGTS?(?![A-Z])|TARGETS?(?![A-Z])|ENTRY(?![A-Z])|STOP(?![A-Z])|TP(?![A-Z]))` +
  `(?:\\d{1,2}(?:ST|ND|RD|TH)?|20\\d{2}|(?:${MONTH_ALT})[A-Z]*|\\d{1,2}[-']?(?:${MONTH_ALT})[-']?\\d{0,4}|WEEKLY|MONTHLY)`;
const SYM = "([A-Z][A-Z0-9&.\\-]{1,19})";
/**
 * STRUCTURAL shapes of an options directive whose underlying is NOT supported (stock options, other indices,
 * misspellings). Each needs a symbol, optional date-like filler, and a 4-6 digit strike glued to or next to an exact
 * CE/PE token - a plain substring match on CE/PE is not used, so ordinary equity symbols and prose do not trigger it.
 * The underlying is never mapped or corrected.
 */
const UNSUPPORTED_SHAPES: Array<{ form: string; re: RegExp }> = [
  { form: "compact_strike_type", re: /^\s*([A-Z][A-Z&.\-]{1,19}?)(?:\d{1,2}[A-Z]{3}(?:\d{2,4})?)?(\d{4,6})(CE|PE)(?![A-Z])/ },
  { form: "compact_code_type", re: /^\s*([A-Z][A-Z&.\-]{1,19}?)(\d{7,10})(CE|PE)(?![A-Z])/ },
  { form: "spaced_strike_type", re: new RegExp(`^\\s*${SYM}(?:\\s+${FILLER}){0,4}\\s+(\\d{4,6})\\s*(CE|PE)(?![A-Z])`) },
  { form: "type_strike", re: new RegExp(`^\\s*${SYM}(?:\\s+${FILLER}){0,3}\\s+(CE|PE)\\s*(\\d{4,6})(?![\\d.])`) },
];

export interface UnsupportedOptionsShape {
  actionSegments: number;
  flagged: Array<{ action: OptionAction; symbol: string; form: string }>;
}

/** Options-shaped directives (after BUY/SELL) whose underlying is not NIFTY/BANKNIFTY/SENSEX. Requires an action word. */
export function detectUnsupportedOptionsShape(raw: string): UnsupportedOptionsShape {
  const { text } = normalize(raw);
  const segments = segmentsOf(text).filter((x) => x.action !== null);
  const flagged: UnsupportedOptionsShape["flagged"] = [];
  for (const seg of segments) {
    if (!seg.action) continue;
    for (const shape of UNSUPPORTED_SHAPES) {
      const m = shape.re.exec(seg.text);
      if (m?.[1]) {
        flagged.push({ action: seg.action, symbol: m[1], form: shape.form });
        break;
      }
    }
  }
  return { actionSegments: segments.length, flagged };
}
