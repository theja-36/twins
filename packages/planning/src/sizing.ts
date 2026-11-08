import { abs, ceilTo2, dec, div, floorTo2, mul, S, str, wholeUnits, ZERO, type Dec } from "./decimal";
import { COST_MODEL_VERSION, roundTripCosts } from "./costs";
import { checkStop, type StopProblemCode } from "./stop";
import type { FeeSchedule, InstrumentSpec } from "./specs";

/**
 * Instrument-aware position sizing (Module 08), in fixed-point decimals. The size comes from the MONEY AT RISK, never from the target or the strength of a signal, and rounds DOWN to whole lots. It can only
 * be reduced by `sizeMultiplier` (at most 1): nothing here can enlarge a position. Costs and slippage are inside the loss, so the stop-out loss INCLUDING costs stays within the budget.
 * Invariants are re-checked on the final answer; a violation yields NOT_SIZED, never a larger size.
 */
export const SIZING_MODEL_VERSION = "position-sizing-v2";
export type NotSizedReason = StopProblemCode | "SPEC_UNAVAILABLE" | "FEES_UNAVAILABLE" | "CAPITAL_INVALID" | "BUDGET_NOT_POSITIVE" | "ONE_LOT_EXCEEDS_RISK_BUDGET" | "ONE_LOT_EXCEEDS_CAPITAL" | "ONE_LOT_EXCEEDS_FREEZE_LIMIT" | "MARGIN_MODEL_UNAVAILABLE" | "MULTIPLIER_INVALID" | "INVARIANT_VIOLATION" | "INPUT_INVALID";
export interface SizingPolicy { riskPercent: string; maxRiskPerTrade: string | null; maxLots: number; maxPositionNotionalPct: string | null }
export interface SizingInputV2 {
  side: "BUY" | "SELL"; entry: string | number; stop: string | number | null | undefined; stopBasis: string | null; targets: ReadonlyArray<string | number>;
  spec: InstrumentSpec | null; fees: FeeSchedule | null;
  capital: { total: string; available: string };
  policy: SizingPolicy;
  /** Remaining headroom from the daily-loss / portfolio / correlated-group budgets (null = not limited by that budget). */
  caps: { remainingDailyRisk: string | null; remainingPortfolioRisk: string | null; remainingGroupRisk: string | null };
  /** In (0, 1]. A risk restriction may shrink the position; nothing may enlarge it. */
  sizeMultiplier: number;
  slippageBps: { entry: number; exit: number };
}
export interface TargetOutcome { target: string; grossProfit: string; costs: string; netProfit: string; grossRewardToRisk: string; netRewardToRisk: string | null }
export interface SizingResultV2 {
  modelVersion: string; costModelVersion: string; status: "SIZED" | "NOT_SIZED"; reason: NotSizedReason | null; detail: string;
  lots: number; quantity: number; lotSize: string | null; tick: string | null;
  entry: string; stop: string | null; grossExposure: string;
  riskBudget: { riskPercentOfCapital: string; perTradeCap: string | null; remainingDailyRisk: string | null; remainingPortfolioRisk: string | null; remainingGroupRisk: string | null; sizeMultiplier: string; effectiveBudget: string; binding: string };
  maxLossAtStop: string; riskPerLot: string; stopLossGross: string; costsAtStop: string; slippageAtStop: string;
  breakevenPrice: string | null; targets: TargetOutcome[]; capitalUtilisationPct: string; riskPercentOfCapital: string;
  limitsApplied: string[]; specVersion: string | null; specSourceKind: string | null; feeVersion: string | null; feeSourceKind: string | null; grantsApproval: false;
}
const notSized = (reason: NotSizedReason, detail: string, i: Pick<SizingInputV2, "entry" | "stop" | "spec" | "fees">, extra: Partial<SizingResultV2> = {}): SizingResultV2 => ({
  modelVersion: SIZING_MODEL_VERSION, costModelVersion: COST_MODEL_VERSION, status: "NOT_SIZED", reason, detail, lots: 0, quantity: 0, lotSize: i.spec?.lotSize ?? null, tick: i.spec?.tickSize ?? null,
  entry: String(i.entry), stop: i.stop === null || i.stop === undefined ? null : String(i.stop), grossExposure: "0.00",
  riskBudget: { riskPercentOfCapital: "0", perTradeCap: null, remainingDailyRisk: null, remainingPortfolioRisk: null, remainingGroupRisk: null, sizeMultiplier: "0", effectiveBudget: "0.00", binding: "none" },
  maxLossAtStop: "0.00", riskPerLot: "0.00", stopLossGross: "0.00", costsAtStop: "0.00", slippageAtStop: "0.00", breakevenPrice: null, targets: [], capitalUtilisationPct: "0.00", riskPercentOfCapital: "0.00", limitsApplied: [],
  specVersion: i.spec?.specVersion ?? null, specSourceKind: i.spec?.sourceKind ?? null, feeVersion: i.fees?.feeVersion ?? null, feeSourceKind: i.fees?.sourceKind ?? null, grantsApproval: false, ...extra,
});
const bps = (n: number): Dec => dec(n / 10_000);

export function sizePosition(i: SizingInputV2): SizingResultV2 {
  try { return size(i); } catch (e) { if (e instanceof RangeError) return notSized("INPUT_INVALID", "an input is not a valid decimal", i); throw e; }
}
function size(i: SizingInputV2): SizingResultV2 {
  const { spec, fees } = i;
  if (!spec) return notSized("SPEC_UNAVAILABLE", "no versioned instrument specification is available for this instrument", i);
  if (!fees) return notSized("FEES_UNAVAILABLE", "no versioned fee schedule is available for this segment", i);
  if (!(i.sizeMultiplier > 0 && i.sizeMultiplier <= 1) || !Number.isFinite(i.sizeMultiplier)) return notSized("MULTIPLIER_INVALID", "the size multiplier must be in (0, 1]: a position can be reduced, never enlarged", i);
  const stopCheck = checkStop({ side: i.side, entry: i.entry, stop: i.stop, stopBasis: i.stopBasis, instrumentType: spec.instrumentType, tick: spec.tickSize });
  if (!stopCheck.ok) return notSized(stopCheck.code, stopCheck.detail, i);
  if ((spec.instrumentType === "future" || spec.instrumentType === "option") && i.side === "SELL") return notSized("MARGIN_MODEL_UNAVAILABLE", "selling a derivative needs a margin model, which does not exist yet; the position is not sized", i);
  const total = dec(i.capital.total), avail = dec(i.capital.available);
  if (total <= 0n || avail <= 0n || avail > total) return notSized("CAPITAL_INVALID", "capital is missing, not positive, or available exceeds total", i);
  const entry = dec(i.entry), stop = dec(i.stop as string | number), lot = dec(spec.lotSize), buy = i.side === "BUY";
  // adverse fills: the entry fills worse and the stop fills worse than their levels
  const entryFill = buy ? mul(entry, dec(1) + bps(i.slippageBps.entry), "up") : mul(entry, dec(1) - bps(i.slippageBps.entry), "down");
  const stopFill = buy ? mul(stop, dec(1) - bps(i.slippageBps.exit), "down") : mul(stop, dec(1) + bps(i.slippageBps.exit), "up");
  const perUnitLossGross = abs(entry - stop), perUnitLossFilled = buy ? entryFill - stopFill : stopFill - entryFill;
  // budgets
  const riskPct = dec(i.policy.riskPercent);
  const pctBudget = floorTo2(mul(avail, div(riskPct, dec(100))));
  const caps: Array<[string, Dec]> = [["risk_percent", pctBudget]];
  if (i.policy.maxRiskPerTrade !== null) caps.push(["max_risk_per_trade", dec(i.policy.maxRiskPerTrade)]);
  if (i.caps.remainingDailyRisk !== null) caps.push(["daily_loss_headroom", dec(i.caps.remainingDailyRisk)]);
  if (i.caps.remainingPortfolioRisk !== null) caps.push(["portfolio_risk_headroom", dec(i.caps.remainingPortfolioRisk)]);
  if (i.caps.remainingGroupRisk !== null) caps.push(["correlated_group_headroom", dec(i.caps.remainingGroupRisk)]);
  const base = caps.reduce((a, c) => (c[1] < a[1] ? c : a));
  const effective = floorTo2(mul(base[1], dec(i.sizeMultiplier)));
  const riskBudget = { riskPercentOfCapital: str(riskPct, 4), perTradeCap: i.policy.maxRiskPerTrade, remainingDailyRisk: i.caps.remainingDailyRisk, remainingPortfolioRisk: i.caps.remainingPortfolioRisk, remainingGroupRisk: i.caps.remainingGroupRisk, sizeMultiplier: String(i.sizeMultiplier), effectiveBudget: str(effective), binding: i.sizeMultiplier < 1 ? `${base[0]}*multiplier` : base[0] };
  if (effective <= 0n) return notSized("BUDGET_NOT_POSITIVE", "the remaining risk budget is zero", i, { riskBudget });

  const costsFor = (lots: bigint) => roundTripCosts(fees, i.side, entryFill, stopFill, lots * (lot / S));
  const lossFor = (lots: bigint): Dec => ceilTo2(mul(perUnitLossFilled, dec(lots * (lot / S)), "up")) + costsFor(lots).total;
  const unitsPerLot = lot / S; // whole units per lot (lot sizes are whole numbers)
  if (lot % S !== 0n) return notSized("SPEC_LOT_OR_TICK" as never, "the lot size must be a whole number of units", i);
  // upper bounds in lots
  const limits: string[] = [];
  const bound = (name: string, lots: bigint | null): bigint | null => { if (lots !== null) limits.push(`${name}=${lots}`); return lots; };
  const notionalPerLot = mul(entryFill, lot, "up");
  const cash = buy; // a bought equity/option/future is paid for or margined; long cash instruments are limited by available capital
  const capLots = cash ? wholeUnits(avail, notionalPerLot) : null;
  const posCapLots = i.policy.maxPositionNotionalPct !== null ? wholeUnits(floorTo2(mul(avail, div(dec(i.policy.maxPositionNotionalPct), dec(100)))), notionalPerLot) : null;
  const freezeLots = spec.freezeQuantity !== null ? BigInt(Math.floor(spec.freezeQuantity / Number(unitsPerLot))) : null;
  const bounds: Array<[string, bigint | null]> = [["policy_max_lots", BigInt(i.policy.maxLots)], ["spec_max_lots", spec.maxLots === null ? null : BigInt(spec.maxLots)], ["capital", capLots], ["position_notional_pct", posCapLots], ["freeze_quantity", freezeLots]];
  let lots = BigInt(Number.MAX_SAFE_INTEGER);
  for (const [n, b] of bounds) { const v = bound(n, b); if (v !== null && v < lots) lots = v; }
  // risk: the largest whole number of lots whose stop-out loss INCLUDING costs fits the budget
  const perLot1 = lossFor(1n);
  if (perLot1 > effective) return notSized("ONE_LOT_EXCEEDS_RISK_BUDGET", `one lot loses ${str(perLot1)} at the stop (costs and slippage included), more than the ${str(effective)} budget`, i, { riskBudget, limitsApplied: limits });
  if (capLots !== null && capLots < 1n) return notSized("ONE_LOT_EXCEEDS_CAPITAL", "one lot costs more than the available capital", i, { riskBudget, limitsApplied: limits });
  if (freezeLots !== null && freezeLots < 1n) return notSized("ONE_LOT_EXCEEDS_FREEZE_LIMIT", "one lot exceeds the exchange freeze quantity", i, { riskBudget, limitsApplied: limits });
  if (lots < 1n) return notSized("INPUT_INVALID", "a lots limit is below one lot", i, { riskBudget, limitsApplied: limits });
  // the loss grows with the number of lots (fixed brokerage makes it non-linear), so find the LARGEST whole number of lots that fits by binary search
  const grossPerLot = ceilTo2(mul(perUnitLossFilled, lot, "up"));
  let hi = grossPerLot > ZERO ? effective / grossPerLot + 1n : lots;
  if (hi > lots) hi = lots;
  let lo = 1n; // one lot is known to fit (checked above)
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (lossFor(mid) <= effective) lo = mid; else hi = mid - 1n; }
  lots = lo;
  if (capLots !== null && capLots < 1n) return notSized("ONE_LOT_EXCEEDS_CAPITAL", "one lot costs more than the available capital", i, { riskBudget, limitsApplied: limits });
  if (freezeLots !== null && freezeLots < 1n) return notSized("ONE_LOT_EXCEEDS_FREEZE_LIMIT", "one lot exceeds the exchange freeze quantity", i, { riskBudget, limitsApplied: limits });
  if (lots < 1n) return notSized("ONE_LOT_EXCEEDS_RISK_BUDGET", "no whole lot fits the risk budget", i, { riskBudget, limitsApplied: limits });

  const qty = lots * unitsPerLot, exposure = ceilTo2(mul(entry, dec(qty), "up"));
  const stopCosts = costsFor(lots).total, stopGross = ceilTo2(mul(perUnitLossGross, dec(qty), "up")), maxLoss = lossFor(lots);
  const slipAtStop = maxLoss - stopGross - stopCosts;
  // breakeven: the exit price at which the net result is zero after round-trip costs, with the entry fill (slippage) included
  const unitCostsAtBe = ceilTo2(roundTripCosts(fees, i.side, entryFill, entryFill, qty).total);
  const perUnitCost = div(unitCostsAtBe, dec(qty), "up");
  const breakeven = buy ? entryFill + perUnitCost : entryFill - perUnitCost;
  const targets: TargetOutcome[] = i.targets.map((t) => {
    const tp = dec(t), good = buy ? tp > entry : tp < entry;
    if (!good) return { target: String(t), grossProfit: "0.00", costs: "0.00", netProfit: "0.00", grossRewardToRisk: "0.00", netRewardToRisk: null };
    const exitFill = buy ? mul(tp, dec(1) - bps(i.slippageBps.exit), "down") : mul(tp, dec(1) + bps(i.slippageBps.exit), "up");
    const gross = floorTo2(mul(abs(tp - entry), dec(qty), "down")), costs = roundTripCosts(fees, i.side, entryFill, exitFill, qty).total;
    const filledMove = buy ? exitFill - entryFill : entryFill - exitFill, netRaw = mul(filledMove, dec(qty), "down") - costs, net = netRaw < 0n ? -ceilTo2(-netRaw) : floorTo2(netRaw);
    return { target: String(t), grossProfit: str(gross), costs: str(costs), netProfit: str(net), grossRewardToRisk: str(div(gross, stopGross > 0n ? stopGross : dec(1), "down"), 2), netRewardToRisk: maxLoss > 0n ? str(div(net, maxLoss, "down"), 2) : null };
  });
  // invariants (fail closed)
  const violated = maxLoss > effective || (cash && exposure > avail) || lots > BigInt(i.policy.maxLots) || (spec.maxLots !== null && lots > BigInt(spec.maxLots)) || (freezeLots !== null && lots > freezeLots);
  if (violated) return notSized("INVARIANT_VIOLATION", "the computed size breached a limit and was discarded", i, { riskBudget, limitsApplied: limits });
  const utilBase = cash ? exposure : ZERO;
  return {
    modelVersion: SIZING_MODEL_VERSION, costModelVersion: COST_MODEL_VERSION, status: "SIZED", reason: null, detail: `${lots} lot(s) sized from the ${riskBudget.binding} budget`, lots: Number(lots), quantity: Number(qty), lotSize: spec.lotSize, tick: spec.tickSize,
    entry: String(i.entry), stop: String(i.stop), grossExposure: str(exposure), riskBudget, maxLossAtStop: str(maxLoss), riskPerLot: str(ceilTo2(div(maxLoss, dec(lots), "up"))), stopLossGross: str(stopGross), costsAtStop: str(stopCosts), slippageAtStop: str(slipAtStop < 0n ? ZERO : slipAtStop),
    breakevenPrice: str(breakeven, 4), targets, capitalUtilisationPct: str(mul(div(utilBase, avail), dec(100)), 2), riskPercentOfCapital: str(mul(div(maxLoss, avail, "up"), dec(100), "up"), 4), limitsApplied: limits,
    specVersion: spec.specVersion, specSourceKind: spec.sourceKind, feeVersion: fees.feeVersion, feeSourceKind: fees.sourceKind, grantsApproval: false,
  };
}
