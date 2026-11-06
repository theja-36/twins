/**
 * Independent signal generation (P1 #16), partial. PURE, rule-based CANDIDATES from price bars alone: a breakout, a breakdown and a pullback-in-trend generator. A candidate is a proposal for the normal
 * pipeline to judge, never an order: it always carries a protective stop (mandatory-stop rule), targets in R multiples, reason codes, and `confidence: null` because no calibration exists for these rules
 * (they have not been backtested; do not read a candidate as an edge). `requiresFullPipeline` is always true: it must pass stop validation, sizing, portfolio, market and approval like any signal, and
 * `orderable` is always false. No data beyond the bars is read.
 */
export const INDEPENDENT_VERSION = "independent-signals-v1";
export interface IBar { open: number; high: number; low: number; close: number; volume: number | null }
export type Strategy = "BREAKOUT_LONG" | "BREAKDOWN_SHORT" | "PULLBACK_LONG";
export interface IndependentPolicy { breakoutLookback: number; atrWindow: number; stopAtrMultiple: number; minStopPct: number; targetsR: [number, number, number]; volumeConfirm: number; fastMa: number; slowMa: number; pullbackBars: number }
export const DEFAULT_INDEPENDENT_POLICY: IndependentPolicy = { breakoutLookback: 20, atrWindow: 14, stopAtrMultiple: 1.5, minStopPct: 0.3, targetsR: [1, 2, 3], volumeConfirm: 1.2, fastMa: 20, slowMa: 50, pullbackBars: 3 };
export interface Candidate {
  version: typeof INDEPENDENT_VERSION; strategy: Strategy; symbol: string; side: "BUY" | "SELL"; entry: number; stop: number; targets: [number, number, number]; riskPerUnit: number; reasons: string[];
  /** No calibration exists for these rules. */ confidence: null; calibrated: false; status: "CANDIDATE"; requiresFullPipeline: true; orderable: false; source: "twins-independent";
}
const r2 = (x: number): number => Math.round(x * 100) / 100;
const sma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** `bars` oldest first. Returns zero or more candidates (at most one per strategy), or [] when the data is insufficient or malformed. `blockedRegimes` suppresses generation (e.g. HIGH_VOLATILITY). */
export function generateCandidates(symbol: string, bars: readonly IBar[], regime: string | null = null, blockedRegimes: readonly string[] = ["HIGH_VOLATILITY", "UNKNOWN"], policy: IndependentPolicy = DEFAULT_INDEPENDENT_POLICY): Candidate[] {
  const p = policy, need = Math.max(p.slowMa, p.breakoutLookback, p.atrWindow) + 2;
  if (bars.length < need || (regime !== null && blockedRegimes.includes(regime))) return [];
  for (const b of bars) if (![b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) || b.high < b.low || b.close > b.high || b.close < b.low) return [];
  const last = bars[bars.length - 1] as IBar, prior = bars.slice(0, -1);
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) { const b = bars[i] as IBar, pc = (bars[i - 1] as IBar).close; tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))); }
  const atr = sma(tr.slice(-p.atrWindow));
  const entry = last.close, risk = Math.max(atr * p.stopAtrMultiple, entry * (p.minStopPct / 100));
  if (!(risk > 0)) return [];
  const out: Candidate[] = [];
  const make = (strategy: Strategy, side: "BUY" | "SELL", reasons: string[]): void => {
    const s = side === "BUY" ? 1 : -1;
    const stop = r2(entry - s * risk), targets = p.targetsR.map((r) => r2(entry + s * risk * r)) as [number, number, number];
    if (side === "BUY" ? stop >= entry : stop <= entry) return;
    out.push({ version: INDEPENDENT_VERSION, strategy, symbol, side, entry: r2(entry), stop, targets, riskPerUnit: r2(risk), reasons, confidence: null, calibrated: false, status: "CANDIDATE", requiresFullPipeline: true, orderable: false, source: "twins-independent" });
  };
  const window = prior.slice(-p.breakoutLookback);
  const hi = Math.max(...window.map((b) => b.high)), lo = Math.min(...window.map((b) => b.low));
  const vols = window.map((b) => b.volume).filter((v): v is number => v !== null);
  const volOk = last.volume === null || vols.length === 0 ? null : last.volume >= p.volumeConfirm * sma(vols);
  if (last.close > hi && volOk !== false) make("BREAKOUT_LONG", "BUY", ["CLOSE_ABOVE_PRIOR_HIGH", volOk === null ? "VOLUME_UNKNOWN" : "VOLUME_CONFIRMED"]);
  if (last.close < lo && volOk !== false) make("BREAKDOWN_SHORT", "SELL", ["CLOSE_BELOW_PRIOR_LOW", volOk === null ? "VOLUME_UNKNOWN" : "VOLUME_CONFIRMED"]);
  const closes = bars.map((b) => b.close), fast = sma(closes.slice(-p.fastMa)), slow = sma(closes.slice(-p.slowMa));
  const recent = bars.slice(-p.pullbackBars - 1, -1);
  if (fast > slow && last.close > fast && recent.some((b) => b.low <= fast) && last.close > (bars[bars.length - 2] as IBar).close) make("PULLBACK_LONG", "BUY", ["UPTREND_FAST_ABOVE_SLOW", "TOUCHED_FAST_MA", "CLOSED_BACK_ABOVE"]);
  return out;
}
