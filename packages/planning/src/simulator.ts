import { ceilTo2, dec, div, mul, str, ZERO, type Dec } from "./decimal";
import { COST_MODEL_VERSION, roundTripCosts } from "./costs";
import { sizePosition, SIZING_MODEL_VERSION, type SizingInputV2, type SizingPolicy, type SizingResultV2 } from "./sizing";
import { DEFAULT_RISK_EXTRAS, type PortfolioState, type RiskExtras } from "./risk";

/**
 * Pre-trade what-if simulator (Module 11). INFORMATIONAL: it places nothing, approves nothing and writes only a simulation record. Every scenario is sized by the SAME sizing engine as a real plan, so a scenario can
 * never show a position the risk budget would not allow without saying so (`permitted: false`). It states its inputs, assumptions, limitations and the specification / fee / model versions used.
 */
export const SIMULATOR_VERSION = "what-if-simulator-v1";
export interface ScenarioSpec { id: string; label: string; entry?: string | number; stop?: string | number | null; targets?: ReadonlyArray<string | number>; lots?: number; riskPercent?: string }
export interface RiskShocks { gapPct: readonly number[]; adversePct: readonly number[]; /** Options only; needs greeks, otherwise the shock is reported as not modelled. */ volShockPoints: readonly number[]; greeks: { delta: number; vega: number } | null }
export const DEFAULT_SHOCKS: RiskShocks = { gapPct: [1, 2, 3, 5], adversePct: [1, 2, 3], volShockPoints: [-5, 5], greeks: null };
export interface SimulationInput { base: Omit<SizingInputV2, "policy" | "targets" | "entry" | "stop"> & { entry: string | number; stop: string | number | null | undefined; targets: ReadonlyArray<string | number> }; policy: SizingPolicy; scenarios: readonly ScenarioSpec[]; shocks?: RiskShocks; portfolio: PortfolioState | null; groupOf: (underlying: string) => string | null; underlying: string; extras?: RiskExtras; /** ids of scenarios assumed taken at the same time */ simultaneous?: readonly string[]; hardMaxRiskPct?: string }
export interface ScenarioOutput { id: string; label: string; requested: { entry: string; stop: string | null; targets: string[]; lots: number | null; riskPercent: string }; permitted: boolean; notPermittedReasons: string[]; sizing: SizingResultV2 }
export interface GapOutcome { gapPct: number; fillPrice: string; lossGross: string; costs: string; totalLoss: string; multipleOfPlannedLoss: string; exceedsRiskBudget: boolean; gappedThroughStop: boolean }
export interface SimulationReport {
  simulatorVersion: string; sizingModelVersion: string; costModelVersion: string; versions: { spec: string | null; specSource: string | null; fees: string | null; feeSource: string | null };
  scenarios: ScenarioOutput[];
  riskScenarios: { forScenario: string; gaps: GapOutcome[]; adverse: Array<{ movePct: number; loss: string; stoppedOut: boolean }>; volatility: Array<{ shockPoints: number; status: "MODELLED" | "NOT_MODELLED"; pnl: string | null; note: string }> } | null;
  portfolioImpact: { forScenario: string; openRiskAfter: string; openNotionalAfter: string; groupKey: string | null; groupRiskAfter: string; dailyBudgetAfterStopOut: string | null; positionsAfter: number } | null;
  simultaneous: { ids: string[]; totalMaxLoss: string; totalExposure: string; withinAvailableCapital: boolean; withinDailyLimit: boolean | null; note: string } | null;
  inputsEcho: Record<string, unknown>; assumptions: string[]; limitations: string[]; informationalOnly: true; grantsApproval: false;
}
const HARD = "5";
export function simulate(inp: SimulationInput): SimulationReport {
  const policyRisk = dec(inp.policy.riskPercent), hard = dec(inp.hardMaxRiskPct ?? HARD), X = inp.extras ?? DEFAULT_RISK_EXTRAS;
  const outputs: ScenarioOutput[] = [];
  const seen = new Set<string>();
  for (const sc of inp.scenarios) {
    if (seen.has(sc.id)) throw new RangeError("duplicate scenario id"); seen.add(sc.id);
    const reasons: string[] = [], rp = sc.riskPercent ?? inp.policy.riskPercent;
    if (dec(rp) > policyRisk) reasons.push("RISK_PERCENT_ABOVE_POLICY");
    if (dec(rp) > hard) reasons.push("RISK_PERCENT_ABOVE_HARD_CEILING");
    const cappedRp = dec(rp) > hard ? inp.hardMaxRiskPct ?? HARD : rp;
    const policy: SizingPolicy = { ...inp.policy, riskPercent: cappedRp, maxLots: sc.lots !== undefined && sc.lots >= 1 ? Math.min(sc.lots, inp.policy.maxLots) : inp.policy.maxLots };
    const sizing = sizePosition({ ...inp.base, entry: sc.entry ?? inp.base.entry, stop: sc.stop === undefined ? inp.base.stop : sc.stop, targets: sc.targets ?? inp.base.targets, policy });
    if (sc.lots !== undefined && sc.lots > inp.policy.maxLots) reasons.push("LOTS_ABOVE_POLICY_MAX");
    if (sc.lots !== undefined && sizing.status === "SIZED" && sizing.lots < sc.lots) reasons.push(`REQUESTED_${sc.lots}_LOTS_EXCEED_PERMITTED_${sizing.lots}`);
    if (sizing.status === "NOT_SIZED") reasons.push(`NOT_SIZED_${sizing.reason}`);
    outputs.push({ id: sc.id, label: sc.label, requested: { entry: String(sc.entry ?? inp.base.entry), stop: (sc.stop === undefined ? inp.base.stop : sc.stop) === null || (sc.stop === undefined ? inp.base.stop : sc.stop) === undefined ? null : String(sc.stop === undefined ? inp.base.stop : sc.stop), targets: (sc.targets ?? inp.base.targets).map(String), lots: sc.lots ?? null, riskPercent: rp }, permitted: reasons.length === 0, notPermittedReasons: reasons, sizing });
  }
  const first = outputs.find((o) => o.sizing.status === "SIZED") ?? null;
  let riskScenarios: SimulationReport["riskScenarios"] = null, impact: SimulationReport["portfolioImpact"] = null;
  const fees = inp.base.fees, spec = inp.base.spec;
  if (first && fees && spec) {
    const s = first.sizing, qty = BigInt(s.quantity), entry = dec(s.entry), stop = dec(s.stop as string), buy = inp.base.side === "BUY", planned = dec(s.maxLossAtStop), budget = dec(s.riskBudget.effectiveBudget);
    const shocks = inp.shocks ?? DEFAULT_SHOCKS;
    const gaps: GapOutcome[] = shocks.gapPct.map((g) => {
      const gp = buy ? mul(entry, dec(1) - dec(g / 100), "down") : mul(entry, dec(1) + dec(g / 100), "up");
      const through = buy ? gp < stop : gp > stop, fill = through ? gp : stop, move = buy ? entry - fill : fill - entry;
      const gross = ceilTo2(mul(move, dec(qty), "up")), costs = roundTripCosts(fees, inp.base.side, entry, fill, qty).total, total = gross + costs;
      return { gapPct: g, fillPrice: str(fill, 4), lossGross: str(gross), costs: str(costs), totalLoss: str(total), multipleOfPlannedLoss: planned > ZERO ? str(div(total, planned, "up"), 2) : "0.00", exceedsRiskBudget: total > budget, gappedThroughStop: through };
    });
    const adverse = shocks.adversePct.map((m) => { const mv = mul(entry, dec(m / 100), "up"), stopDist = buy ? entry - stop : stop - entry, stopped = mv >= stopDist, eff = stopped ? stopDist : mv; return { movePct: m, loss: str(ceilTo2(mul(eff, dec(qty), "up")) + roundTripCosts(fees, inp.base.side, entry, buy ? entry - eff : entry + eff, qty).total), stoppedOut: stopped }; });
    const vol = shocks.volShockPoints.map((p) => shocks.greeks && spec.instrumentType === "option"
      ? { shockPoints: p, status: "MODELLED" as const, pnl: str(mul(dec(shocks.greeks.vega * p), dec(qty), "down") * (buy ? 1n : -1n)), note: "linear vega approximation per unit: second-order effects ignored" }
      : { shockPoints: p, status: "NOT_MODELLED" as const, pnl: null, note: spec.instrumentType === "option" ? "no greeks were supplied" : "volatility affects options only; not modelled for this instrument" });
    riskScenarios = { forScenario: first.id, gaps, adverse, volatility: vol };
    const P = inp.portfolio, gk = inp.groupOf(inp.underlying);
    if (P) {
      const openRisk = P.openPositions.reduce<Dec>((a, p) => a + dec(p.riskAmount), ZERO), openNot = P.openPositions.reduce<Dec>((a, p) => a + dec(p.notional), ZERO);
      const gRisk = P.openPositions.filter((p) => gk !== null && inp.groupOf(p.underlying) === gk).reduce<Dec>((a, p) => a + dec(p.riskAmount), ZERO);
      impact = { forScenario: first.id, openRiskAfter: str(openRisk + planned), openNotionalAfter: str(openNot + dec(s.grossExposure)), groupKey: gk, groupRiskAfter: str(gRisk + (gk ? planned : ZERO)), dailyBudgetAfterStopOut: inp.base.caps.remainingDailyRisk === null ? null : str(dec(inp.base.caps.remainingDailyRisk) - planned), positionsAfter: P.openPositions.length + 1 };
    }
  }
  let simul: SimulationReport["simultaneous"] = null;
  if (inp.simultaneous && inp.simultaneous.length > 1) {
    const chosen = outputs.filter((o) => inp.simultaneous!.includes(o.id) && o.sizing.status === "SIZED");
    const loss = chosen.reduce<Dec>((a, o) => a + dec(o.sizing.maxLossAtStop), ZERO), expo = chosen.reduce<Dec>((a, o) => a + dec(o.sizing.grossExposure), ZERO), avail = dec(inp.base.capital.available);
    simul = { ids: chosen.map((o) => o.id), totalMaxLoss: str(loss), totalExposure: str(expo), withinAvailableCapital: expo <= avail, withinDailyLimit: inp.base.caps.remainingDailyRisk === null ? null : loss <= dec(inp.base.caps.remainingDailyRisk), note: "worst case: every position stops out together (no diversification credit); the combined loss is compared with the same budgets, each scenario having been sized alone" };
  }
  void X;
  return {
    simulatorVersion: SIMULATOR_VERSION, sizingModelVersion: SIZING_MODEL_VERSION, costModelVersion: COST_MODEL_VERSION,
    versions: { spec: spec?.specVersion ?? null, specSource: spec?.sourceKind ?? null, fees: fees?.feeVersion ?? null, feeSource: fees?.sourceKind ?? null },
    scenarios: outputs, riskScenarios, portfolioImpact: impact, simultaneous: simul,
    inputsEcho: { side: inp.base.side, entry: String(inp.base.entry), stop: inp.base.stop === null || inp.base.stop === undefined ? null : String(inp.base.stop), targets: inp.base.targets.map(String), capital: inp.base.capital, policy: inp.policy, slippageBps: inp.base.slippageBps, sizeMultiplier: inp.base.sizeMultiplier, caps: inp.base.caps },
    assumptions: ["prices fill at the stated levels adjusted by the slippage assumption, always against the position", "costs follow the fee schedule version shown, rounded up to the paisa", "a stop that is gapped through fills at the gap price, not at the stop", "scenarios are sized by the production sizing engine and the same risk budgets", "all monetary arithmetic is fixed-point decimal"],
    limitations: ["not a forecast: no probability of any outcome is estimated", "no margin model: derivative sales are not simulated", "no intraday path, partial fills or liquidity impact are modelled", "volatility effects need supplied greeks and are first-order only", "specification and fee values are only as authoritative as their source kind shown above", "the stop is structurally checked, not independently validated"],
    informationalOnly: true, grantsApproval: false,
  };
}
