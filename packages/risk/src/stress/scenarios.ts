/**
 * Scenario stress test (P1 #14). PURE: applies fixed what-if shocks to a set of positions and reports the loss in money and as a share of capital. Equity-like positions move linearly with the shock (times
 * their beta); a protective stop caps the loss at the stop distance PLUS a configurable gap-through slippage; long options use a delta-vega approximation (gamma capped conservatively) floored at the premium paid (a long option
 * cannot lose more than its premium). It is a rough, assumption-driven what-if, not a forecast, and says so in `limitations`. Places nothing, closes nothing, approves nothing.
 */
export const STRESS_VERSION = "scenario-stress-v1";
export interface StressPosition {
  symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; /** Sensitivity to the market shock (1 = moves with it). */ beta: number; stop: number | null;
  /** Long options only: when present, an option approximation is used instead of the linear one. */
  option?: { delta: number; gamma: number; vega: number; premium: number; underlyingPrice: number };
}
export interface Scenario { id: string; label: string; /** Market move as a percent (negative = down). */ marketMovePct: number; /** Absolute change in implied volatility points (options). */ volShockPoints: number; /** Extra adverse gap beyond the stop, percent of price. */ gapThroughPct: number }
export const DEFAULT_SCENARIOS: readonly Scenario[] = [
  { id: "MARKET_DOWN_3", label: "Market -3%", marketMovePct: -3, volShockPoints: 3, gapThroughPct: 0.3 },
  { id: "MARKET_DOWN_7", label: "Market -7%", marketMovePct: -7, volShockPoints: 8, gapThroughPct: 0.8 },
  { id: "MARKET_UP_5", label: "Market +5%", marketMovePct: 5, volShockPoints: -2, gapThroughPct: 0.5 },
  { id: "GAP_DOWN_10", label: "Gap down -10%", marketMovePct: -10, volShockPoints: 12, gapThroughPct: 1.5 },
  { id: "VOL_SPIKE", label: "Volatility spike, flat market", marketMovePct: 0, volShockPoints: 10, gapThroughPct: 0 },
];
export interface ScenarioResult { id: string; label: string; pnl: number; pnlPctOfCapital: number; worstPosition: { symbol: string; pnl: number } | null; breachesLimit: boolean }
export interface StressReport { version: typeof STRESS_VERSION; capital: number; maxLossPct: number; results: ScenarioResult[]; worst: ScenarioResult | null; anyBreach: boolean; limitations: string[]; grantsApproval: false }
export class StressInputError extends Error { constructor(m: string) { super(m); this.name = "StressInputError"; } }
const r2 = (x: number): number => Math.round(x * 100) / 100;

function positionPnl(p: StressPosition, s: Scenario): number {
  const sign = p.side === "BUY" ? 1 : -1;
  if (p.option) {
    const o = p.option, dS = o.underlyingPrice * ((s.marketMovePct * p.beta) / 100);
    const lin = o.delta * dS;
    // Convexity (gamma) can offset at most HALF of a delta loss and never turns an adverse move into a gain: a delta-gamma expansion is unreliable for large shocks, so it is capped conservatively.
    const conv = 0.5 * o.gamma * dS * dS;
    const perUnit = lin + (lin < 0 ? Math.min(conv, -lin / 2) : conv) + o.vega * s.volShockPoints;
    return Math.max(-o.premium, perUnit) * p.quantity; // a long option cannot lose more than the premium paid
  }
  const move = (s.marketMovePct * p.beta) / 100;
  let pnl = sign * p.price * move * p.quantity;
  if (pnl < 0 && p.stop !== null) {
    const stopLoss = Math.abs(p.price - p.stop) * p.quantity + p.price * (s.gapThroughPct / 100) * p.quantity; // stop distance plus gap-through
    pnl = Math.max(pnl, -stopLoss);
  }
  return pnl;
}

export function runStress(positions: readonly StressPosition[], capital: number, maxLossPct: number, scenarios: readonly Scenario[] = DEFAULT_SCENARIOS): StressReport {
  if (!(Number.isFinite(capital) && capital > 0 && Number.isFinite(maxLossPct) && maxLossPct > 0)) throw new StressInputError("capital and maxLossPct must be positive");
  for (const p of positions) {
    if (!(Number.isFinite(p.quantity) && p.quantity > 0 && Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.beta) && (p.side === "BUY" || p.side === "SELL"))) throw new StressInputError("invalid position");
    if (p.option && (p.side !== "BUY" || !(p.option.premium > 0) || ![p.option.delta, p.option.gamma, p.option.vega, p.option.underlyingPrice].every(Number.isFinite))) throw new StressInputError("options are supported long-only with finite greeks and a positive premium");
  }
  const results: ScenarioResult[] = scenarios.map((s) => {
    const per = positions.map((p) => ({ symbol: p.symbol, pnl: positionPnl(p, s) }));
    const pnl = per.reduce((a, x) => a + x.pnl, 0);
    const worstPos = per.length ? per.reduce((m, x) => (x.pnl < m.pnl ? x : m)) : null;
    const pct = r2((pnl / capital) * 100);
    return { id: s.id, label: s.label, pnl: r2(pnl), pnlPctOfCapital: pct, worstPosition: worstPos && worstPos.pnl < 0 ? { symbol: worstPos.symbol, pnl: r2(worstPos.pnl) } : null, breachesLimit: pct < -maxLossPct };
  });
  const worst = results.length ? results.reduce((m, x) => (x.pnl < m.pnl ? x : m)) : null;
  return {
    version: STRESS_VERSION, capital, maxLossPct, results, worst, anyBreach: results.some((r) => r.breachesLimit),
    limitations: ["Linear moves scaled by a supplied beta; no correlation breakdown or liquidity gaps beyond the stated gap-through.", "Option approximation is delta-vega with gamma capped conservatively (at most half of a delta loss), long options only.", "Scenarios are fixed what-ifs, not probabilities or forecasts."],
    grantsApproval: false,
  };
}
