import { DEFAULT_STOP_LOSS_CONFIG } from "./config";
import {
  STOP_LOSS_RULE_VERSION,
  type StopLossBasis,
  type StopLossConfig,
  type StopLossInput,
  type StopLossInstrumentKind,
  type StopLossReason,
  type StopLossResult,
  type StopLossValidation,
} from "./types";

const DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;

type Parsed = { ok: true; value: number } | { ok: false; kind: "missing" } | { ok: false; kind: "invalid"; detail: string };

/** Normalizes a stop-loss / price value. Numbers must be finite; strings must be a plain decimal (no sign, exponent, hex, separators or letters). */
export function parseLevel(value: unknown): Parsed {
  if (value === null || value === undefined) return { ok: false, kind: "missing" };
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return { ok: false, kind: "missing" };
    if (t.startsWith("-") && DECIMAL.test(t.slice(1))) return { ok: false, kind: "invalid", detail: Number(t) === 0 ? "zero" : "negative" };
    if (!DECIMAL.test(t)) return { ok: false, kind: "invalid", detail: "non_numeric" };
    return classify(Number(t));
  }
  if (typeof value === "number") return classify(value);
  if (typeof value === "bigint") return classify(Number(value));
  return { ok: false, kind: "invalid", detail: "non_numeric" };
}

function classify(n: number): Parsed {
  if (!Number.isFinite(n)) return { ok: false, kind: "invalid", detail: "not_finite" };
  if (n === 0) return { ok: false, kind: "invalid", detail: "zero" };
  if (n < 0) return { ok: false, kind: "invalid", detail: "negative" };
  return { ok: true, value: n };
}

const render = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.slice(0, 64);
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  return `[${typeof v}]`;
};

function kindOf(instrumentType: unknown): StopLossInstrumentKind | null {
  if (typeof instrumentType !== "string") return null;
  const t = instrumentType.trim().toLowerCase();
  return t === "equity" || t === "future" || t === "option" ? t : null;
}

const BASES: readonly StopLossBasis[] = ["price", "premium", "underlying", "unspecified"];

/**
 * The single shared stop-loss rule. Checks run in a fixed order and the FIRST failure decides the result and the reason code:
 *  1 supported instrument (equity, future, option)  2 explicit buy/sell  3 present  4 numeric, finite, > 0
 *  5 (options) premium basis stated  6 usable entry/reference price  7 not equal to the entry  8 on the correct side  9 within the maximum risk distance
 * VALID only if all pass. MISSING / INVALID are defects of the signal; AMBIGUOUS means it cannot be shown to be valid (never treated as valid).
 * Direction: long exposure needs the stop BELOW the reference, short exposure ABOVE it.
 *  - equity / future: buy = long, sell = short.
 *  - option, premium basis (the only basis that is valid): buy = long premium (stop below the entry premium), sell = short premium (stop above) for
 *    CE and PE alike, because the stop is on the option's own price.
 *  - option, underlying basis: CE buy / PE sell are bullish (stop below the underlying entry), PE buy / CE sell are bearish (above). A stop on the wrong
 *    side is STOP_LOSS_DIRECTION_INVALID; on the right side it is still not placeable on the option: AMBIGUOUS STOP_LOSS_NOT_PREMIUM_BASIS.
 */
export function validateStopLoss(input: StopLossInput, config: StopLossConfig = DEFAULT_STOP_LOSS_CONFIG): StopLossValidation {
  const kind = kindOf(input.instrumentType);
  const side = input.side === "buy" || input.side === "sell" ? input.side : null;
  const optionType = input.optionType === "CE" || input.optionType === "PE" ? input.optionType : null;
  const basis: StopLossBasis | null = kind === "option" ? (BASES.includes(input.levelBasis as StopLossBasis) ? (input.levelBasis as StopLossBasis) : "unspecified") : kind ? "price" : null;
  const maxRiskPct = kind ? config.maxRiskPct[kind] : null;
  const maxRiskSource = kind ? config.source[kind] : null;

  const base: StopLossValidation = {
    ruleVersion: STOP_LOSS_RULE_VERSION,
    result: "AMBIGUOUS",
    reasonCode: null,
    detail: null,
    instrumentType: typeof input.instrumentType === "string" ? input.instrumentType.slice(0, 32) : null,
    instrumentKind: kind,
    side,
    optionType,
    levelBasis: basis,
    originalStopLoss: render(input.stopLoss),
    normalizedStopLoss: null,
    entryPrice: null,
    riskDistance: null,
    riskPct: null,
    maxRiskPct,
    maxRiskSource,
    expectedStopSide: null,
  };
  const fail = (result: Exclude<StopLossResult, "VALID">, reasonCode: StopLossReason, detail: string | null, extra: Partial<StopLossValidation> = {}): StopLossValidation => ({ ...base, ...extra, result, reasonCode, detail });

  if (!kind) return fail("AMBIGUOUS", "UNSUPPORTED_INSTRUMENT_TYPE", null);
  if (!side) return fail("AMBIGUOUS", "UNSUPPORTED_TRADE_SIDE", null);

  const sl = parseLevel(input.stopLoss);
  if (!sl.ok) return sl.kind === "missing" ? fail("MISSING", "MISSING_STOP_LOSS", "absent_or_blank") : fail("INVALID", "INVALID_STOP_LOSS", sl.detail);
  const stop = sl.value;
  base.normalizedStopLoss = stop;

  // Which way must the stop sit?
  let expected: "below" | "above";
  if (kind === "option") {
    if (basis === "unspecified" || basis === "price" || basis === null) return fail("AMBIGUOUS", "STOP_LOSS_BASIS_UNSPECIFIED", null, { normalizedStopLoss: stop });
    if (basis === "premium") expected = side === "buy" ? "below" : "above";
    else {
      if (!optionType) return fail("AMBIGUOUS", "STOP_LOSS_BASIS_UNSPECIFIED", "option_type_missing", { normalizedStopLoss: stop });
      const bullish = (side === "buy") === (optionType === "CE");
      expected = bullish ? "below" : "above";
    }
  } else {
    expected = side === "buy" ? "below" : "above";
  }
  base.expectedStopSide = expected;

  // Reference: a single entry price, or the farthest bound of a range (conservative for both the side check and the distance).
  const range = input.entryLow !== undefined || input.entryHigh !== undefined;
  let reference: number | null = null;
  let low: number | null = null;
  let high: number | null = null;
  if (range) {
    const l = parseLevel(input.entryLow);
    const h = parseLevel(input.entryHigh);
    if (l.ok && h.ok && l.value <= h.value) {
      low = l.value;
      high = h.value;
      reference = expected === "below" ? high : low; // the farthest entry from the stop
    }
  } else {
    const e = parseLevel(input.entryPrice);
    if (e.ok) reference = e.value;
  }
  if (reference === null) return fail("AMBIGUOUS", "STOP_LOSS_REFERENCE_MISSING", null, { normalizedStopLoss: stop });

  const distance = Math.abs(reference - stop);
  const pct = (distance / reference) * 100;
  const numbers = { normalizedStopLoss: stop, entryPrice: reference, riskDistance: distance, riskPct: pct };

  // The nearest entry bound decides "equals / wrong side": the stop must clear the WHOLE range.
  const nearest = range ? (expected === "below" ? (low as number) : (high as number)) : reference;
  if (stop === nearest || (range && stop >= (low as number) && stop <= (high as number))) return fail("INVALID", "STOP_LOSS_EQUALS_ENTRY", range ? "inside_entry_range" : null, numbers);
  const correct = expected === "below" ? stop < nearest : stop > nearest;
  if (!correct) return fail("INVALID", "STOP_LOSS_DIRECTION_INVALID", `wrong_side_expected_${expected}`, numbers);

  if (kind === "option" && basis === "underlying") return fail("AMBIGUOUS", "STOP_LOSS_NOT_PREMIUM_BASIS", null, numbers);
  if (maxRiskPct !== null && pct > maxRiskPct) return fail("INVALID", "STOP_LOSS_TOO_FAR", `risk_${pct.toFixed(2)}pct_exceeds_${maxRiskPct}pct`, numbers);

  return { ...base, ...numbers, result: "VALID", reasonCode: null, detail: null };
}
