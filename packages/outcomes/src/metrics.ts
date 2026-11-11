import { wilsonInterval, type LearningOutcome } from "@twins/historical";
import { abs, dec, div, mul, str, ZERO, type Dec } from "@twins/planning";
import type { AttributionRow } from "@twins/database";

/**
 * Performance metrics (Module 15A/B). PURE. Every figure comes with its sample size and definition; where the data cannot support a figure it is null with a reason, never zero or a guess. Money is summed in fixed-point decimals;
 * ratios are plain numbers. Only FINAL records are eligible, and the caller decides which datasets (mode, data source) are combined: fixture-backed records are reported as such and never counted as validated evidence.
 */
export const METRICS_VERSION = "performance-metrics-v2";
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
/**
 * Two-sided 95% critical value of Student's t for `df` degrees of freedom (97.5th percentile). Cornish-Fisher expansion about the normal quantile; accurate to better than 1e-3 for df >= 10 and used only for
 * df >= 29 here (the minimum sample is 30), where it agrees with the published table to 4 decimals (df 29 = 2.0452, 30 = 2.0423, 60 = 2.0003, 120 = 1.9799). Below 10 degrees of freedom it is refused rather than approximated.
 */
export function tCritical95(df: number): number {
  if (!Number.isFinite(df) || df < 10) throw new RangeError("the t critical value is only provided for at least 10 degrees of freedom");
  const z = 1.959963984540054, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (sorted: readonly number[], q: number): number | null => { if (!sorted.length) return null; const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return round((sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo), 2); };
export const toLearningOutcome = (r: AttributionRow): LearningOutcome => ({ id: r.id, at: r.closedAt as Date, outcome: classOf(r), rMultiple: r.rMultiple === null ? null : Number(r.rMultiple), closeReason: r.exitReason, dims: { setup: r.setup, detector: r.detectorVersion, instrument: r.instrument, source: r.candidateSource, channel: r.channelId, exit: r.exitReason } });

export interface Metric<T> { value: T | null; n: number; definition: string; note?: string }
export interface PerformanceMetrics {
  version: string; eligible: number; reliability: Reliability; status: "SUFFICIENT" | "INSUFFICIENT_DATA";
  wins: number; losses: number; breakeven: number;
  winRate: Metric<number> & { interval: { lower: number; upper: number } | null };
  lossRate: Metric<number> & { interval: { lower: number; upper: number } | null };
  grossPnl: string; costs: string; netPnl: string; avgWin: Metric<string>; avgLoss: Metric<string>; payoffRatio: Metric<number> & { exact: string | null };
  rMultiple: { n: number; mean: number | null; total: number | null; definition: string };
  expectancyR: Metric<number> & { exact: string | null; interval95: { lower: number; upper: number } | null; intervalMethod: string; degreesOfFreedom: number | null };
  expectancyMoney: Metric<string>; profitFactor: Metric<number> & { exact: string | null; interval: null; intervalNote: string };
  maxDrawdown: Metric<string> & { basis: string };
  maxDrawdownPct: { value: null; status: "NOT_AVAILABLE"; reason: string; definition: string };
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
  // R-multiples are fixed-point decimals (8 places, as stored): the mean, total and spread are computed exactly, never from rounded or floating-point values
  const rd: Dec[] = []; for (const r of rs) { if (r.rMultiple === null) continue; try { rd.push(dec(r.rMultiple)); } catch { /* an unparseable R counts as not recorded */ } }
  const rN = rd.length, rSum = rd.reduce<Dec>((a, b) => a + b, ZERO), meanRd = rN ? div(rSum, dec(rN), "down") : null;
  let ci: { lower: number; upper: number } | null = null, df: number | null = null;
  if (meanRd !== null && rN >= minSample && rN >= 11) {
    const sumSq = rd.reduce<bigint>((a, v) => a + (v - meanRd) * (v - meanRd), 0n); // scale 1e16
    const sd = Math.sqrt(Number(sumSq) / (rN - 1) / 1e16), se = sd / Math.sqrt(rN), t = tCritical95(rN - 1), m = Number(str(meanRd, 8));
    ci = { lower: round(m - t * se), upper: round(m + t * se) }; df = rN - 1;
  }
  const wr = n ? wilsonInterval(wins, n, 1.96) : null, lr = n ? wilsonInterval(losses, n, 1.96) : null;
  // cumulative net P&L in closing order; drawdown = largest fall from a running peak (the series starts at zero)
  let cum = ZERO, peak = ZERO, dd = ZERO; for (const r of rs) { cum += dec(r.netPnl as string); if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  const hold = rs.map((r) => r.holdingSeconds).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const enough = n >= minSample, why = `fewer than ${minSample} eligible outcomes`;
  const srcs: Record<string, number> = {}, modes: Record<string, number> = {}; for (const r of rs) { srcs[r.dataSource] = (srcs[r.dataSource] ?? 0) + 1; modes[r.mode] = (modes[r.mode] ?? 0) + 1; }
  const avgWin = wins ? div(winSum, dec(wins), "down") : null, avgLoss = losses ? div(lossSum, dec(losses), "up") : null;
  const payoff = avgWin !== null && avgLoss !== null && avgLoss !== ZERO ? div(avgWin, abs(avgLoss), "down") : null, pf = lossSum < ZERO && enough ? div(winSum, abs(lossSum), "down") : null;
  return {
    version: METRICS_VERSION, eligible: n, reliability: reliabilityOf(rs, minSample), status: enough ? "SUFFICIENT" : "INSUFFICIENT_DATA", wins, losses, breakeven: be,
    winRate: { value: n ? round(wins / n) : null, n, interval: wr, definition: "wins / all eligible outcomes (net P&L > 0); breakeven counts as resolved and not a win; 95% Wilson interval", ...(enough ? {} : { note: why }) },
    lossRate: { value: n ? round(losses / n) : null, n, interval: lr, definition: "losses / all eligible outcomes (net P&L < 0); win rate + loss rate + breakeven share = 1; 95% Wilson interval", ...(enough ? {} : { note: why }) },
    grossPnl: str(gross), costs: str(costs), netPnl: str(net),
    avgWin: { value: avgWin === null ? null : str(avgWin), n: wins, definition: "mean net P&L of winning outcomes" }, avgLoss: { value: avgLoss === null ? null : str(avgLoss), n: losses, definition: "mean net P&L of losing outcomes (negative)" },
    payoffRatio: { value: payoff === null ? null : round(Number(str(payoff, 8))), exact: payoff === null ? null : str(payoff, 8), n, definition: "average win / absolute average loss, computed in exact decimals (`exact` is the 8-place result, `value` its rounding to 4 places); null without both a win and a loss" },
    rMultiple: { n: rN, mean: meanRd === null ? null : round(Number(str(meanRd, 8))), total: rN ? round(Number(str(rSum, 8))) : null, definition: "net P&L / planned risk (initial stop distance x initial quantity); outcomes without a recorded R are excluded and counted here" },
    expectancyR: { value: enough && meanRd !== null ? round(Number(str(meanRd, 8))) : null, exact: enough && meanRd !== null ? str(meanRd, 8) : null, n: rN, interval95: ci, intervalMethod: "95% interval of the mean, Student's t with n-1 degrees of freedom", degreesOfFreedom: df, definition: "mean realised R-multiple (unrounded, 8-place fixed point); reported only with at least the minimum sample, with a 95% t interval", ...(enough ? {} : { note: why }) },
    expectancyMoney: { value: enough ? str(div(net, dec(n), "down")) : null, n, definition: "mean net P&L per eligible outcome", ...(enough ? {} : { note: why }) },
    profitFactor: { value: pf === null ? null : round(Number(str(pf, 8))), exact: pf === null ? null : str(pf, 8), interval: null, intervalNote: "no interval is reported: a ratio of sums has no exact small-sample interval and none is estimated or invented", n, definition: "sum of winning net P&L / absolute sum of losing net P&L, in exact decimals (`exact` is the 8-place result); null without losses or below the minimum sample", ...(lossSum >= ZERO ? { note: "no losing outcomes" } : enough ? {} : { note: why }) },
    maxDrawdown: { value: n >= 2 ? str(dd) : null, n, basis: "largest fall of cumulative net P&L from its running peak, in closing order; the series starts at 0 and is not an account equity curve", definition: "needs at least two outcomes", ...(n >= 2 ? {} : { note: "fewer than two outcomes" }) },
    maxDrawdownPct: { value: null, status: "NOT_AVAILABLE", reason: "a percentage drawdown needs an account equity curve (capital over time), which is not recorded; the drawdown above is of cumulative net P&L only", definition: "largest peak-to-trough fall of account equity as a percentage of the peak" },
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
/** Confidence strength band at decision time: 0-20 ... 80-100. A score recorded AFTER the position opened is look-ahead and is not used (the record falls into UNKNOWN). Descriptive only: this is NOT calibration (that stays with the Stage 06 procedure). */
export function confidenceBandOf(r: AttributionRow): string | null {
  if (r.confidenceScore === null || r.dataQuality.includes("CONFIDENCE_RECORDED_AFTER_OPEN") || !Number.isFinite(r.confidenceScore)) return null;
  const lo = Math.min(80, Math.max(0, Math.floor(r.confidenceScore / 20) * 20)); return `${lo}-${lo + 20}`;
}
/** Planned reward-to-risk at decision time, bucketed (the plan, not the result). */
export function plannedRewardToRiskBucket(r: AttributionRow): string | null {
  const v = (r.predicted as { plannedRewardToRisk?: string | null } | null)?.plannedRewardToRisk; if (v === null || v === undefined) return null;
  const x = Number(v); if (!Number.isFinite(x) || x <= 0) return null; return x < 1.5 ? "<1.5" : x < 2 ? "1.5-2" : x < 3 ? "2-3" : ">=3";
}
export const DIMENSIONS: Record<string, (r: AttributionRow) => string | null | undefined> = {
  confidenceBand: confidenceBandOf, plannedRewardToRisk: plannedRewardToRiskBucket, riskVerdict: (r) => (r.predicted as { riskVerdict?: string | null } | null)?.riskVerdict ?? null,
  strategy: (r) => r.setup, strategyVersion: (r) => (r.setup ? `${r.setup}@${r.detectorVersion ?? "unversioned"}` : null), instrument: (r) => r.instrument, timeframe: (r) => (r.timeframeSeconds === null ? null : `${r.timeframeSeconds}s`),
  regime: (r) => (r.regime as { atDecision?: { regime?: string } } | null)?.atDecision?.regime ?? null, source: (r) => r.candidateSource, side: (r) => r.side, exitReason: (r) => r.exitReason, channel: (r) => r.channelId,
  stopBehaviour: (r) => { const h = trade(r).stopHit; return h === undefined || h === null ? null : h ? "STOP_HIT" : "STOP_NOT_HIT"; },
  targetBehaviour: (r) => { const t = trade(r).targetsHit; return t === undefined ? null : t === 0 ? "NO_TARGET_HIT" : `${t}_TARGET_RUNGS_HIT`; },
  stopMoved: (r) => { const m = trade(r).stopMoves; return m === undefined ? null : m > 0 ? "STOP_TIGHTENED" : "STOP_UNCHANGED"; },
};
