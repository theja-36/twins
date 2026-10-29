/**
 * THE shared stop-loss contract (Stage 1 / Task 4). Pure, dependency-free, deterministic. Every path that can produce an approval-class
 * state (today: APPROVE in decision-intelligence; in future QUALIFIED and any execution-eligible state) must obtain a VALID result from
 * validateStopLoss (or validateOptionsClaimStopLoss) first. A static test (tests/unit/safety/stopLossCoverage.test.ts) fails if a new
 * approval-class path appears that does not.
 */
export const STOP_LOSS_RULE_VERSION = "stop-loss-v1";

export type StopLossResult = "VALID" | "INVALID" | "MISSING" | "AMBIGUOUS";

/** Machine-readable reasons. Stored in stop_loss_validations.reason_code and surfaced in verdicts; also usable as `stop_loss.<lower_snake>` reason codes. */
export const STOP_LOSS_REASONS = [
  "MISSING_STOP_LOSS", // absent, null, empty or blank
  "INVALID_STOP_LOSS", // not a plain decimal number, not finite, zero or negative
  "STOP_LOSS_EQUALS_ENTRY", // zero risk distance: not a stop
  "STOP_LOSS_DIRECTION_INVALID", // on the profit side of the entry/reference for the trade direction
  "STOP_LOSS_TOO_FAR", // beyond the configured maximum risk distance
  "STOP_LOSS_REFERENCE_MISSING", // no usable entry/reference price: side and distance cannot be checked
  "STOP_LOSS_BASIS_UNSPECIFIED", // option levels without a stated premium/underlying basis
  "STOP_LOSS_NOT_PREMIUM_BASIS", // option stop given on the underlying: cannot be placed on the option without a model
  "UNSUPPORTED_INSTRUMENT_TYPE", // not equity, future or option
  "UNSUPPORTED_TRADE_SIDE", // not an explicit buy or sell
] as const;
export type StopLossReason = (typeof STOP_LOSS_REASONS)[number];

export type StopLossInstrumentKind = "equity" | "future" | "option";
export type StopLossBasis = "price" | "premium" | "underlying" | "unspecified";

export interface StopLossInput {
  /** Instrument type as stored (equity | future | option | ...). Anything else is AMBIGUOUS (not valid). */
  instrumentType: unknown;
  /** Explicit trade side. For options, "buy" = long premium, "sell" = short premium (writer). */
  side: unknown;
  /** CE / PE (options only; decides the direction when the levels are on the underlying). */
  optionType?: unknown;
  /** The stop-loss exactly as parsed/stored: number, numeric string, null, undefined, anything. */
  stopLoss: unknown;
  /** Entry (or reference) price. For a range entry pass entryLow/entryHigh instead. */
  entryPrice?: unknown;
  entryLow?: unknown;
  entryHigh?: unknown;
  /** What the quoted levels refer to. Equity/future: "price". Option: must be "premium" to be valid. */
  levelBasis?: StopLossBasis | string | null | undefined;
}

export interface StopLossConfig {
  /** Maximum allowed |entry - stop| / entry, as a percentage, per instrument kind. */
  maxRiskPct: Readonly<Record<StopLossInstrumentKind, number>>;
  source: Readonly<Record<StopLossInstrumentKind, "default" | "env">>;
}

export interface StopLossValidation {
  ruleVersion: typeof STOP_LOSS_RULE_VERSION;
  result: StopLossResult;
  /** null exactly when result is VALID. */
  reasonCode: StopLossReason | null;
  /** Finer, still machine-readable (e.g. non_numeric, not_finite, zero, negative, wrong_side_for_long). */
  detail: string | null;
  instrumentType: string | null;
  instrumentKind: StopLossInstrumentKind | null;
  side: "buy" | "sell" | null;
  optionType: "CE" | "PE" | null;
  levelBasis: StopLossBasis | null;
  /** The stop-loss as supplied, rendered as text (null when absent). */
  originalStopLoss: string | null;
  /** The normalized finite number, when the supplied value was a valid positive decimal. */
  normalizedStopLoss: number | null;
  /** The entry/reference price the stop was compared with (the entry for a single price; the farthest bound for a range). */
  entryPrice: number | null;
  /** |entry - stop| and as a percentage of the reference; only for a numeric stop with a usable reference. */
  riskDistance: number | null;
  riskPct: number | null;
  maxRiskPct: number | null;
  maxRiskSource: "default" | "env" | null;
  /** Where the stop must sit relative to the reference for this trade: "below" (long exposure) or "above" (short). */
  expectedStopSide: "below" | "above" | null;
}

export const isStopLossValid = (v: Pick<StopLossValidation, "result">): boolean => v.result === "VALID";
