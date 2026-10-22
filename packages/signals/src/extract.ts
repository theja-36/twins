/**
 * Deterministic Telegram signal extraction (spec section 18/61: a
 * Telegram signal is untrusted external content and must be parsed with
 * plain pattern matching - never an LLM, never anything that could be
 * steered by the message text itself. There is no "interpretation" step
 * here: every extracted field is either a literal regex capture or
 * absent. Text this doesn't recognize as a directive produces no signal
 * at all (spec section 61: a Telegram signal is an input, not a
 * decision - noise is not upgraded into an ungrounded structured signal).
 */

import { analyzeOptionsText, detectUnsupportedOptionsShape, normalizeUnderlyingAliases } from "./options/parse";
import { isReservedUnderlyingToken, type OptionsClaim } from "./options/types";

/** Identifies this deterministic parser; bump when extraction rules change. */
export const TELEGRAM_PARSER_VERSION = "telegram-regex-v2";

/**
 * The previous parser version. v2 differs ONLY in that options-style directives (index underlyings NIFTY /
 * BANKNIFTY / SENSEX) are routed to the options claim path instead of being read as an equity symbol. v1 stays
 * available for explicit reparse and for the signals already stored under it.
 */
export const TELEGRAM_PARSER_VERSION_V1 = "telegram-regex-v1";

/**
 * Label for historical signals created before parser versions were recorded.
 * Their true parser provenance is UNKNOWN; this label states that, it does not infer it.
 */
export const LEGACY_PARSER_VERSION = "legacy-unversioned";

export interface ParsedSignal {
  direction: "buy" | "sell";
  symbol: string;
  entryPrice?: number;
  stopLoss?: number;
  targets: number[];
  timeframe?: string;
  extractedConfidence?: number;
}

const DIRECTION_SYMBOL_RE = /\b(BUY|SELL)\b\s+([A-Z][A-Z0-9&.\-]{0,19})\b/i;
const ENTRY_RE = /(?:@|ENTRY\s*[:=]?)\s*(\d+(?:\.\d+)?)/i;
const STOP_LOSS_RE = /\b(?:SL|STOP\s*LOSS)\s*[:=]?\s*(\d+(?:\.\d+)?)/i;
const TARGETS_KEYWORD_RE = /\b(?:TGT|TARGETS?)\s*[:=]?\s*/i;
const CONFIDENCE_RE = /(\d{1,3})\s*%\s*confidence|confidence\s*[:=]?\s*(\d{1,3})\s*%/i;
const TIMEFRAME_RE =
  /\b(intraday|swing|positional|btst|long[\s-]?term|\d+\s*(?:min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks))\b/i;

function extractTargets(normalized: string): number[] {
  const match = TARGETS_KEYWORD_RE.exec(normalized);
  if (!match) return [];
  const rest = normalized.slice(match.index + match[0].length);
  // Stop at the next clearly-different keyword section (SL, confidence, timeframe words),
  // so trailing unrelated text doesn't get parsed as extra targets.
  const stopMatch = /\b(SL|STOP\s*LOSS|CONFIDENCE)\b/i.exec(rest);
  const window = stopMatch ? rest.slice(0, stopMatch.index) : rest;
  const numbers = window.match(/\d+(?:\.\d+)?/g);
  return numbers ? numbers.map(Number) : [];
}

export type TelegramTextAnalysis =
  | { kind: "none" }
  | { kind: "signal"; signal: ParsedSignal }
  /** An options-style claim (index underlying): unverified, never an equity signal; see ./options. */
  | { kind: "options_claim"; claim: OptionsClaim }
  /** Strong options structure but an underlying this system does not support; never mapped, corrected or sent to the equity resolver. */
  | { kind: "options_unsupported"; symbol: string; form: string }
  /** More than one distinct BUY/SELL directive: unsupported by this parser version, never guessed. */
  | { kind: "ambiguous"; directives: Array<{ direction: "buy" | "sell"; symbol: string }>; optionsRelated?: true };

const DIRECTION_SYMBOL_RE_GLOBAL = new RegExp(DIRECTION_SYMBOL_RE.source, "gi");

/**
 * Parser capability limit (not a product invariant): this parser version can
 * represent at most ONE signal per message. Text with several distinct
 * (direction, symbol) directives is reported as ambiguous instead of silently
 * becoming one executable signal.
 */
export function analyzeTelegramTextV1(rawText: string): TelegramTextAnalysis {
  const normalized = rawText.replace(/\s+/g, " ").trim();
  const seen = new Map<string, { direction: "buy" | "sell"; symbol: string }>();
  for (const m of normalized.matchAll(DIRECTION_SYMBOL_RE_GLOBAL)) {
    if (!m[1] || !m[2]) continue;
    const direction = m[1].toLowerCase() as "buy" | "sell";
    const symbol = m[2].toUpperCase();
    seen.set(`${direction}:${symbol}`, { direction, symbol });
  }
  if (seen.size === 0) return { kind: "none" };
  if (seen.size > 1) return { kind: "ambiguous", directives: [...seen.values()] };
  const signal = parseTelegramSignal(rawText);
  return signal ? { kind: "signal", signal } : { kind: "none" };
}

export function parseTelegramSignal(rawText: string): ParsedSignal | null {
  const normalized = rawText.replace(/\s+/g, " ").trim();

  const directionMatch = DIRECTION_SYMBOL_RE.exec(normalized);
  if (!directionMatch) return null;

  const direction = directionMatch[1]!.toLowerCase() as "buy" | "sell";
  const symbol = directionMatch[2]!.toUpperCase();

  const entryMatch = ENTRY_RE.exec(normalized);
  const stopLossMatch = STOP_LOSS_RE.exec(normalized);
  const confidenceMatch = CONFIDENCE_RE.exec(normalized);
  const timeframeMatch = TIMEFRAME_RE.exec(normalized);
  const targets = extractTargets(normalized);

  const result: ParsedSignal = { direction, symbol, targets };
  if (entryMatch) result.entryPrice = Number(entryMatch[1]);
  if (stopLossMatch) result.stopLoss = Number(stopLossMatch[1]);
  if (confidenceMatch) {
    const pct = Number(confidenceMatch[1] ?? confidenceMatch[2]);
    result.extractedConfidence = pct / 100;
  }
  if (timeframeMatch) result.timeframe = timeframeMatch[1]!.toLowerCase();

  return result;
}

/**
 * Current parser (telegram-regex-v2). Options-style text (an index underlying after BUY/SELL, or a CE/PE contract)
 * is handled by the options path and can never produce an equity signal; a message mixing it with other directives
 * is ambiguous. Everything else is parsed exactly as in v1.
 */
export function analyzeTelegramText(rawText: string): TelegramTextAnalysis {
  const options = analyzeOptionsText(rawText);
  if (options.kind !== "none") return options;
  const unsupported = detectUnsupportedOptionsShape(rawText);
  const [firstFlag] = unsupported.flagged;
  if (firstFlag) {
    if (unsupported.actionSegments > 1) {
      return { kind: "ambiguous", directives: unsupported.flagged.map((f) => ({ direction: f.action, symbol: f.symbol })), optionsRelated: true };
    }
    return { kind: "options_unsupported", symbol: firstFlag.symbol, form: firstFlag.form };
  }
  // No options directive found, but an index-underlying token must still never reach the equity resolver.
  const v1 = analyzeTelegramTextV1(normalizeUnderlyingAliases(rawText));
  if (v1.kind === "signal" && isReservedUnderlyingToken(v1.signal.symbol)) {
    return { kind: "ambiguous", directives: [{ direction: v1.signal.direction, symbol: v1.signal.symbol }], optionsRelated: true };
  }
  return v1;
}
