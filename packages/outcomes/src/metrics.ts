import { computeStats, type LearningOutcome, type Stats } from "@twins/historical";
import { abs, dec, div, mul, str, ZERO, type Dec } from "@twins/planning";
import type { AttributionRow } from "@twins/database";

/**
 * Performance metrics (Module 15A/B). PURE. Every figure comes with its sample size and definition; where the data cannot support a figure it is null with a reason, never zero or a guess. Money is summed in fixed-point decimals;
 * ratios are plain numbers. Only FINAL records are eligible, and the caller decides which datasets (mode, data source) are combined: fixture-backed records are reported as such and never counted as validated evidence.
 */
export const METRICS_VERSION = "performance-metrics-v1";
export type Reliability = "INSUFFICIENT_DATA" | "NOT_VALIDATED_FIXTURE" | "LOW" | "MODERATE" | "ADEQUATE";
export const isEligible = (r: AttributionRow): boolean => r.finality === "FINAL" && r.netPnl !== null && r.closedAt !== null;
export type OutcomeClass = "WIN" | "LOSS" | "BREAKEVEN";
export const classOf = (r: AttributionRow): OutcomeClass => { const n = dec(r.netPnl as string); return n > ZERO ? "WIN" : n < ZERO ? "LOSS" : "BREAKEVEN"; };
/** Reliability of a figure computed from the given eligible outcomes: too few = INSUFFICIENT_DATA; any fixture data = NOT_VALIDATED_FIXTURE; otherwise graded by size. */
export function reliabilityOf(records: readonly AttributionRow[], minSample: number): Reliability {
  const n = records.length;
  if (n < minSample) return "INSUFFICIENT_DATA";
  if (records.some((r) => r.dataSource === "FIXTURE")) return "NOT_VALIDATED_FIXTURE";
  return n < 100 ? "LOW" : n < 200 ? "MODERATE" : "ADEQUATE";
}
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (sorted: readonly number[], q: number): number | null => { if (!sorted.length) return null; const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return round((sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo), 2); };
export const toLearningOutcome = (r: AttributionRow): LearningOutcome => ({ id: r.id, at: r.closedAt as Date, outcome: classOf(r), rMultiple: r.rMultiple === null ? null : Number(r.rMultiple), closeReason: r.exitReason, dims: { setup: r.setup, detector: r.detectorVersion, instrument: r.instrument, source: r.candidateSource, channel: r.channelId, exit: r.exitReason } });

export interface Metric<T> { value: T | null; n: number; definition: string; note?: string }
export interface PerformanceMetrics {
  version: string; eligible: number; reliability: Reliability; status: "SUFFICIENT" | "INSUFFICIENT_DATA";
  wins: number; losses: number; breakeven: number;
  winRate: Metric<number> & { interval: { lower: number; upper: number } | null };
  grossPnl: string; costs: string; netPnl: string; avgWin: Metric<string>; avgLoss: Metric<string>; payoffRatio: Metric<number>;
  rMultiple: { n: number; mean: number | null; total: number | null; definition: string };
  expectancyR: Metric<number> & { interval95: { lower: number; upper: number } | null };
  expectancyMoney: Metric<string>; profitFactor: Metric<number>;
  maxDrawdown: Metric<string> & { basis: string };
  holdingSeconds: { n: number; mean: number | null; min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null };
  costImpact: Metric<number>; slippage: Metric<string>;
  dataSources: Record<string, number>; modes: Record<string, number>; periodStart: string | null; periodEnd: string | null;
}
export function computeMetrics(all: readonly AttributionRow[], minSample: number): PerformanceMetrics {
  const rs = all.filter(isEligible).sort((a, b) => (a.closedAt as Date).getTime() - (b.closedAt as Date).getTime() || (a.id < b.id ? -1 : 1)), n = rs.length;
  const cls = rs.map(classOf), wins = cls.filter((c) => c === "WIN").length, losses = cls.filter((c) => c === "LOSS").length, be = n - wins - losses;
  const sum = (f: (r: AttributionRow) => string | null): Dec => rs.reduce<Dec>((a, r) => a + (f(r) === null ? ZERO : dec(f(r) as string)), ZERO);
  const gross = sum((r) => r.grossPnl), costs = sum((r) => r.costs), net = sum((r) => r.netPnl);
  const winSum = rs.filter((r) => classOf(r) === "WIN").reduce<Dec>((a, r) => a + dec(r.netPnl as string), ZERO), lossSum = rs.filter((r) => classOf(r) === "LOSS").reduce<Dec>((a, r) => a + dec(r.netPnl as string), ZERO);
  const stats: Stats = computeStats(rs.map(toLearningOutcome), minSample);
  const rv = rs.map((r) => (r.rMultiple === null ? null : Number(r.rMultiple))).filter((v): v is number => v !== null && Number.isFinite(v));
  const meanR = rv.length ? rv.reduce((a, b) => a + b, 0) / rv.length : null;
  let ci: { lower: number; upper: number } | null = null;
  if (meanR !== null && rv.length >= minSample) { const sd = Math.sqrt(rv.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rv.length - 1)); const se = sd / Math.sqrt(rv.length); ci = { lower: round(meanR - 1.96 * se), upper: round(meanR + 1.96 * se) }; }
  // cumulative net P&L in closing order; drawdown = largest fall from a running peak (the series starts at zero)
  let cum = ZERO, peak = ZERO, dd = ZERO; for (const r of rs) { cum += dec(r.netPnl as string); if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  const hold = rs.map((r) => r.holdingSeconds).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const enough = n >= minSample, why = `fewer than ${minSample} eligible outcomes`;
  const srcs: Record<string, number> = {}, modes: Record<string, number> = {}; for (const r of rs) { srcs[r.dataSource] = (srcs[r.dataSource] ?? 0) + 1; modes[r.mode] = (modes[r.mode] ?? 0) + 1; }
  const avgWin = wins ? div(winSum, dec(wins), "down") : null, avgLoss = losses ? div(lossSum, dec(losses), "up") : null;
  return {
    version: METRICS_VERSION, eligible: n, reliability: reliabilityOf(rs, minSample), status: enough ? "SUFFICIENT" : "INSUFFICIENT_DATA", wins, losses, breakeven: be,
    winRate: { value: n ? round(wins / n) : null, n, interval: stats.winRateInterval, definition: "wins / all eligible outcomes (net P&L > 0); breakeven counts as resolved and not a win; 95% Wilson interval", ...(enough ? {} : { note: why }) },
    grossPnl: str(gross), costs: str(costs), netPnl: str(net),
    avgWin: { value: avgWin === null ? null : str(avgWin), n: wins, definition: "mean net P&L of winning outcomes" }, avgLoss: { value: avgLoss === null ? null : str(avgLoss), n: losses, definition: "mean net P&L of losing outcomes (negative)" },
    payoffRatio: { value: avgWin !== null && avgLoss !== null && avgLoss !== ZERO ? round(Number(str(avgWin, 4)) / Math.abs(Number(str(avgLoss, 4)))) : null, n, definition: "average win / absolute average loss; null without both a win and a loss" },
    rMultiple: { n: rv.length, mean: meanR === null ? null : round(meanR), total: rv.length ? round(rv.reduce((a, b) => a + b, 0)) : null, definition: "net P&L / planned risk (initial stop distance x initial quantity); outcomes without a recorded R are excluded and counted here" },
    expectancyR: { value: enough && meanR !== null ? round(meanR) : null, n: rv.length, interval95: ci, definition: "mean realised R-multiple; reported only with at least the minimum sample, with a 95% normal interval", ...(enough ? {} : { note: why }) },
    expectancyMoney: { value: enough ? str(div(net, dec(n), "down")) : null, n, definition: "mean net P&L per eligible outcome", ...(enough ? {} : { note: why }) },
    profitFactor: { value: lossSum < ZERO && enough ? round(Number(str(winSum, 4)) / Math.abs(Number(str(lossSum, 4)))) : null, n, definition: "sum of winning net P&L / absolute sum of losing net P&L; null without losses or below the minimum sample", ...(lossSum >= ZERO ? { note: "no losing outcomes" } : enough ? {} : { note: why }) },
    maxDrawdown: { value: n >= 2 ? str(dd) : null, n, basis: "largest fall of cumulative net P&L from its running peak, in closing order; the series starts at 0 and is not an account equity curve", definition: "needs at least two outcomes", ...(n >= 2 ? {} : { note: "fewer than two outcomes" }) },
    holdingSeconds: { n: hold.length, mean: hold.length ? round(hold.reduce((a, b) => a + b, 0) / hold.length, 1) : null, min: hold[0] ?? null, p25: quantile(hold, 0.25), median: quantile(hold, 0.5), p75: quantile(hold, 0.75), max: hold[hold.length - 1] ?? null },
    costImpact: { value: gross !== ZERO ? round(Number(str(div(mul(costs, dec(100)), abs(gross), "down"), 2))) : null, n, definition: "costs as a percentage of the absolute gross P&L" },
    slippage: { value: null, n: 0, definition: "slippage versus a reference price", note: "the reference price is not recorded for paper fills, so slippage cannot be measured; it is included in the fill prices but not separable" },
    dataSources: srcs, modes, periodStart: rs[0]?.closedAt?.toISOString() ?? null, periodEnd: rs[n - 1]?.closedAt?.toISOString() ?? null,
  };
}
export interface Slice { key: string; metrics: PerformanceMetrics }
/** Groups eligible records by a dimension. A null / unknown value is its own explicit "UNKNOWN" slice, never merged into another. */
export function sliceBy(records: readonly AttributionRow[], keyOf: (r: AttributionRow) => string | null | undefined, minSample: number): Slice[] {
  const g = new Map<string, AttributionRow[]>();
  for (const r of records.filter(isEligible)) { const k = keyOf(r) ?? "UNKNOWN"; g.set(k, [...(g.get(k) ?? []), r]); }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map(([key, rs]) => ({ key, metrics: computeMetrics(rs, minSample) }));
}
const trade = (r: AttributionRow): { stopHit?: boolean | null; targetsHit?: number; stopMoves?: number } => r.trade as never;
export const DIMENSIONS: Record<string, (r: AttributionRow) => string | null | undefined> = {
  strategy: (r) => r.setup, strategyVersion: (r) => (r.setup ? `${r.setup}@${r.detectorVersion ?? "unversioned"}` : null), instrument: (r) => r.instrument, timeframe: (r) => (r.timeframeSeconds === null ? null : `${r.timeframeSeconds}s`),
  regime: (r) => (r.regime as { atDecision?: { regime?: string } } | null)?.atDecision?.regime ?? null, source: (r) => r.candidateSource, side: (r) => r.side, exitReason: (r) => r.exitReason, channel: (r) => r.channelId,
  stopBehaviour: (r) => { const h = trade(r).stopHit; return h === undefined || h === null ? null : h ? "STOP_HIT" : "STOP_NOT_HIT"; },
  targetBehaviour: (r) => { const t = trade(r).targetsHit; return t === undefined ? null : t === 0 ? "NO_TARGET_HIT" : `${t}_TARGET_RUNGS_HIT`; },
  stopMoved: (r) => { const m = trade(r).stopMoves; return m === undefined ? null : m > 0 ? "STOP_TIGHTENED" : "STOP_UNCHANGED"; },
};
