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
