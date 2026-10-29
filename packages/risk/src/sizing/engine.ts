import { createHash } from "node:crypto";
import { SIZING_CONFIG_VERSION, type SizingConfig } from "./config";

/**
 * Pure position-sizing engine (Stage 3 / Task 2): no I/O, no clock, no randomness. The size is derived from the planned MAXIMUM LOSS - never from the
 * profit target or the strength of the signal - and is rounded DOWN to whole units/lots. It never rounds up into a larger risk: if one unit/lot already
 * exceeds the allowed risk, nothing is sized.
 */
export const SIZING_ENGINE_VERSION = "sizing-v1";

export const SIZING_STATUSES = ["SIZED", "REJECTED", "INSUFFICIENT_CAPITAL", "INVALID_INPUT", "RISK_LIMIT_EXCEEDED"] as const;
export type SizingStatus = (typeof SIZING_STATUSES)[number];
export type SizingTier = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type SizingInstrument = "equity" | "future" | "option";

export interface SizingInput {
  /** Available capital (currency units). */
  capital: number | null;
  instrumentType: string | null;
  market?: string | null;
  /** BUY = long (stop below entry), SELL = short (stop above entry). */
  side: string | null;
  /** Entry price, or the option premium. */
  entryPrice: number | null;
  stopLoss: number | null;
  stopLossBasis?: string | null;
  /** Result of the stop-loss validation evidence; only VALID may be sized. */
  stopLossResult: string | null;
  targets?: Array<number | null>;
  /** Lot size / contract multiplier. Equity: units per lot (default 1). Futures and options: REQUIRED. */
  lotSize: number | null;
  /** 0-100; null/0 = unknown. */
  confidenceScore: number | null;
  /** HIGH | MODERATE | MEDIUM | LOW | UNKNOWN. */
  sourceTrustTier: string | null;
  /** The existing risk decision this sizing is computed for (context only; echoed into the snapshot). */
  context?: Record<string, unknown>;
}

export interface SizingResult {
  status: SizingStatus;
  reasonCode: string;
  explanation: string;
  /** Whole units (equity) or lots (futures/options). 0 unless SIZED. */
  quantity: number;
  notional: number;
  maxLossAmount: number;
  /** Percent of available capital. */
  maxLossPercent: number;
  /** Loss per ONE unit/lot at the stop (price distance x lot size). */
  riskPerUnit: number | null;
  riskRewardRatio: number | null;
  confidenceTier: SizingTier;
  trustTier: SizingTier;
  /** The tier actually applied: the LOWER of the two. */
  appliedTier: SizingTier;
  perTradeCap: number | null;
  tierBudget: number | null;
  inputHash: string;
  snapshot: Record<string, unknown>;
}

const TIER_ORDER: SizingTier[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"];
const lower = (a: SizingTier, b: SizingTier): SizingTier => (TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Rounds UP at `dp` decimals (after removing binary noise at 1e-9) so a reported loss is never below the true loss. */
const ceilTo = (v: number, dp: number): number => { const f = 10 ** dp; return Math.ceil(Math.round(v * f * 1e6) / 1e6) / f; };
const roundTo = (v: number, dp: number): number => Math.round(v * 10 ** dp) / 10 ** dp;

export function normalizeInstrument(raw: string | null): SizingInstrument | null {
  const v = (raw ?? "").toLowerCase();
  if (v === "equity" || v === "stock") return "equity";
  if (v === "future" || v === "futures") return "future";
  if (v === "option" || v === "options") return "option";
  return null;
}

export function confidenceTier(score: number | null, config: SizingConfig): SizingTier {
  if (!finite(score) || score <= 0) return "UNKNOWN";
  if (score >= config.confidenceMin.HIGH) return "HIGH";
  if (score >= config.confidenceMin.MEDIUM) return "MEDIUM";
  return "LOW";
}

export function trustTier(raw: string | null): SizingTier {
  switch ((raw ?? "").toUpperCase()) {
    case "HIGH": return "HIGH";
    case "MODERATE": case "MEDIUM": return "MEDIUM";
    case "LOW": return "LOW";
    default: return "UNKNOWN";
  }
}

export function hashSizingInput(input: SizingInput, config: SizingConfig): string {
  const { context: _context, ...rest } = input;
  void _context;
  return createHash("sha256").update(JSON.stringify({ engine: SIZING_ENGINE_VERSION, config: configView(config), input: rest })).digest("hex");
}

const configView = (c: SizingConfig) => ({ version: SIZING_CONFIG_VERSION, maxRiskPct: c.maxRiskPct, maxRiskAmount: c.maxRiskAmount, tierPct: c.tierPct, confidenceMin: c.confidenceMin });

export function computePositionSize(input: SizingInput, config: SizingConfig): SizingResult {
  const inputHash = hashSizingInput(input, config);
  const confTier = confidenceTier(input.confidenceScore, config);
  const trust = trustTier(input.sourceTrustTier);
  const applied = lower(confTier, trust);
  const base = { confidenceTier: confTier, trustTier: trust, appliedTier: applied, inputHash };

  const finish = (status: SizingStatus, reasonCode: string, explanation: string, o: Partial<SizingResult> = {}): SizingResult => {
    const result: SizingResult = { status, reasonCode, explanation, quantity: 0, notional: 0, maxLossAmount: 0, maxLossPercent: 0, riskPerUnit: null, riskRewardRatio: null, perTradeCap: null, tierBudget: null, ...base, snapshot: {}, ...o };
    result.snapshot = {
      engineVersion: SIZING_ENGINE_VERSION,
      config: configView(config),
      input: { ...input, context: undefined },
      context: input.context ?? null,
      output: { status, reasonCode, explanation, quantity: result.quantity, notional: result.notional, maxLossAmount: result.maxLossAmount, maxLossPercent: result.maxLossPercent, riskPerUnit: result.riskPerUnit, riskRewardRatio: result.riskRewardRatio, confidenceTier: confTier, trustTier: trust, appliedTier: applied, perTradeCap: result.perTradeCap, tierBudget: result.tierBudget },
      inputHash,
    };
    return result;
  };
  const invalid = (code: string, text: string) => finish("INVALID_INPUT", code, text);

  // ── input validation: nothing is sized on a missing, unevaluated or implausible input ──
  if (!finite(input.capital)) return invalid("capital_invalid", "Available capital is missing or not a finite number.");
  if (input.capital <= 0) return finish("INSUFFICIENT_CAPITAL", "capital_not_positive", "Available capital is zero or negative; nothing can be sized.");
  const kind = normalizeInstrument(input.instrumentType);
  if (!kind) return invalid("instrument_type_unsupported", "The instrument type is not equity, future or option; it is not sized.");
  if (input.stopLossResult === null || input.stopLossResult === undefined) return invalid("stop_loss_unevaluated", "The stop-loss has not been evaluated; a position is never sized without validated stop-loss evidence.");
  if (input.stopLossResult !== "VALID") return invalid("stop_loss_not_valid", `The stop-loss validation is ${input.stopLossResult}, not VALID; it is not sized.`);
  if (!finite(input.stopLoss) || input.stopLoss <= 0) return invalid("stop_loss_missing", "There is no usable stop-loss price.");
  if (!finite(input.entryPrice) || input.entryPrice <= 0) return invalid("entry_invalid", "The entry price / premium is missing or not a positive number.");
  const side = (input.side ?? "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return invalid("side_invalid", "The side is not BUY or SELL; the direction of the stop cannot be checked.");
  if (side === "BUY" ? !(input.stopLoss < input.entryPrice) : !(input.stopLoss > input.entryPrice)) return invalid("stop_loss_wrong_side", `For a ${side} the stop-loss must be ${side === "BUY" ? "below" : "above"} the entry.`);
  let lot = input.lotSize;
  if (kind === "equity" && (lot === null || lot === undefined)) lot = 1;
  if (!finite(lot) || lot <= 0 || !Number.isInteger(lot)) return invalid("lot_size_invalid", kind === "equity" ? "The lot size must be a positive whole number." : "A verified lot size / contract multiplier (positive whole number) is required for futures and options.");
  if (finite(input.confidenceScore) && (input.confidenceScore < 0 || input.confidenceScore > 100)) return invalid("confidence_out_of_range", "The confidence score must be between 0 and 100.");

  // ── tiers: unknown means NO size ──
  if (confTier === "UNKNOWN") return finish("REJECTED", "confidence_unknown", "The signal confidence is unknown or zero; the configured allocation is 0%, so nothing is sized.");
  if (trust === "UNKNOWN") return finish("REJECTED", "source_trust_unknown", "The source trust tier is unknown; the configured allocation is 0%, so nothing is sized.");
  const tierPct = config.tierPct[applied as "HIGH" | "MEDIUM" | "LOW"];
  if (tierPct <= 0) return finish("REJECTED", "tier_allocation_zero", `The configured allocation for the ${applied} tier is 0%; nothing is sized.`);

  // ── budget: the per-trade cap is the smaller of the percentage and the absolute cap; the tier takes a share of it ──
  const pctCap = (input.capital * config.maxRiskPct) / 100;
  const perTradeCap = config.maxRiskAmount === null ? pctCap : Math.min(pctCap, config.maxRiskAmount);
  const tierBudget = (perTradeCap * tierPct) / 100;
  const riskPerUnit = Math.abs(input.entryPrice - input.stopLoss) * lot;
  if (!(riskPerUnit > 0)) return invalid("risk_distance_zero", "Entry and stop-loss are equal; there is no risk distance.");
  const notionalPerUnit = input.entryPrice * lot;
  const common = { riskPerUnit: ceilTo(riskPerUnit, 6), perTradeCap: roundTo(perTradeCap, 6), tierBudget: roundTo(tierBudget, 6) };

  // one unit/lot must fit the cap: never round up into a larger risk
  if (ceilTo(riskPerUnit, 4) > perTradeCap) return finish("RISK_LIMIT_EXCEEDED", "min_lot_exceeds_risk_cap", `The risk of one ${kind === "equity" ? "unit" : "lot"} (${ceilTo(riskPerUnit, 4)}) already exceeds the per-trade risk cap (${roundTo(perTradeCap, 4)}); the position is not sized.`, common);

  let qty = Math.floor(tierBudget / riskPerUnit);
  while (qty > 0 && ceilTo(qty * riskPerUnit, 4) > tierBudget) qty -= 1;
  if (qty < 1) return finish("RISK_LIMIT_EXCEEDED", "min_lot_exceeds_tier_budget", `One ${kind === "equity" ? "unit" : "lot"} risks ${ceilTo(riskPerUnit, 4)}, more than the ${applied}-tier budget (${roundTo(tierBudget, 4)}); sizing never rounds up.`, common);

  // the position must be affordable
  const affordable = Math.floor(input.capital / notionalPerUnit);
  if (affordable < 1) return finish("INSUFFICIENT_CAPITAL", "capital_below_one_unit", `Available capital cannot pay for one ${kind === "equity" ? "unit" : "lot"} (notional ${roundTo(notionalPerUnit, 4)}).`, common);
  const capitalLimited = qty > affordable;
  if (capitalLimited) qty = affordable;

  const maxLossAmount = ceilTo(qty * riskPerUnit, 4);
  const notional = ceilTo(qty * notionalPerUnit, 4);
  const maxLossPercent = ceilTo((qty * riskPerUnit * 100) / input.capital, 6);
  const t1 = input.targets?.[0];
  const profitSide = finite(t1) && (side === "BUY" ? t1 > input.entryPrice : t1 < input.entryPrice);
  const riskRewardRatio = finite(t1) && profitSide ? roundTo(Math.abs(t1 - input.entryPrice) / Math.abs(input.entryPrice - input.stopLoss), 6) : null;
  return finish("SIZED", capitalLimited ? "sized_capital_limited" : "sized_within_risk_budget",
    `Sized ${qty} ${kind === "equity" ? "unit(s)" : "lot(s)"} so the loss at the stop is ${maxLossAmount} (${maxLossPercent}% of capital), within the ${applied}-tier budget of ${roundTo(tierBudget, 4)} (${tierPct}% of the per-trade cap ${roundTo(perTradeCap, 4)})${capitalLimited ? "; limited by available capital" : ""}.`,
    { ...common, quantity: qty, notional, maxLossAmount, maxLossPercent, riskRewardRatio });
}
