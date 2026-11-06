/**
 * Cross-market correlation (P1 #15). PURE: Pearson correlation of aligned return series, a correlation matrix, a lead-lag scan between two markets, a regime-break flag (recent correlation versus long-run) and
 * an "effective number of independent bets" for a set of equal-risk positions. Series must be aligned and long enough; otherwise the answer is null with a reason, never a guess. Descriptive: correlation is
 * not causation, is unstable, and these numbers change no limit and approve nothing.
 */
export const CORRELATION_VERSION = "correlation-v1";
export const MIN_OBSERVATIONS = 20;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const clean = (xs: readonly number[]): boolean => xs.every(Number.isFinite);

/** Simple returns from a price series (oldest first); null when a price is not positive and finite. */
export function returnsOf(prices: readonly number[]): number[] | null {
  if (prices.length < 2 || !prices.every((p) => Number.isFinite(p) && p > 0)) return null;
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push((prices[i] as number) / (prices[i - 1] as number) - 1);
  return out;
}
export function pearson(a: readonly number[], b: readonly number[], min = MIN_OBSERVATIONS): number | null {
  if (a.length !== b.length || a.length < min || !clean(a) || !clean(b)) return null;
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = (a[i] as number) - ma, db = (b[i] as number) - mb; sab += da * db; saa += da * da; sbb += db * db; }
  if (Math.sqrt(saa / n) <= 1e-12 || Math.sqrt(sbb / n) <= 1e-12) return null; // a constant series has no correlation (tolerant to float error)
  return r4(Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb))));
}
export interface CorrelationMatrix { names: string[]; matrix: Array<Array<number | null>>; observations: number; highPairs: Array<{ a: string; b: string; corr: number }>; grantsApproval: false }
export function correlationMatrix(series: Record<string, readonly number[]>, highThreshold = 0.8): CorrelationMatrix {
  const names = Object.keys(series).sort();
  const lens = new Set(names.map((n) => (series[n] as readonly number[]).length));
  const matrix = names.map((x) => names.map((y) => (x === y ? 1 : pearson(series[x] as readonly number[], series[y] as readonly number[]))));
  const highPairs: CorrelationMatrix["highPairs"] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) { const c = matrix[i]?.[j]; if (c !== null && c !== undefined && Math.abs(c) >= highThreshold) highPairs.push({ a: names[i] as string, b: names[j] as string, corr: c }); }
  return { names, matrix, observations: lens.size === 1 ? [...lens][0] as number : 0, highPairs, grantsApproval: false };
}
/** Correlation of `leader[t]` with `follower[t + lag]` for lag 0..maxLag (the leader moving first). Returns the best lag by absolute correlation. */
export function leadLag(leader: readonly number[], follower: readonly number[], maxLag = 5): { bestLag: number | null; bestCorr: number | null; byLag: Array<{ lag: number; corr: number | null }>; reason: string | null } {
  if (leader.length !== follower.length) return { bestLag: null, bestCorr: null, byLag: [], reason: "SERIES_NOT_ALIGNED" };
  if (leader.length < MIN_OBSERVATIONS + maxLag) return { bestLag: null, bestCorr: null, byLag: [], reason: "INSUFFICIENT_OBSERVATIONS" };
  const byLag = Array.from({ length: maxLag + 1 }, (_, lag) => ({ lag, corr: pearson(leader.slice(0, leader.length - lag), follower.slice(lag)) }));
  const valid = byLag.filter((x): x is { lag: number; corr: number } => x.corr !== null);
  if (!valid.length) return { bestLag: null, bestCorr: null, byLag, reason: "NO_VALID_CORRELATION" };
  const best = valid.reduce((m, x) => (Math.abs(x.corr) > Math.abs(m.corr) ? x : m));
  return { bestLag: best.lag, bestCorr: best.corr, byLag, reason: null };
}
/** Recent versus long-run correlation of two series; `broken` when they differ by more than `threshold`. */
export function correlationBreak(a: readonly number[], b: readonly number[], recent = 20, threshold = 0.4): { long: number | null; recent: number | null; broken: boolean | null; reason: string | null } {
  if (a.length !== b.length) return { long: null, recent: null, broken: null, reason: "SERIES_NOT_ALIGNED" };
  if (a.length < recent + MIN_OBSERVATIONS) return { long: null, recent: null, broken: null, reason: "INSUFFICIENT_OBSERVATIONS" };
  const l = pearson(a, b), r = pearson(a.slice(-recent), b.slice(-recent), Math.min(MIN_OBSERVATIONS, recent));
  return { long: l, recent: r, broken: l === null || r === null ? null : Math.abs(l - r) > threshold, reason: null };
}
/** Effective number of independent bets for N equal-risk positions: N^2 / sum of all pairwise correlations (1 = one bet, N = fully independent). Null when any correlation is unknown. */
export function effectiveBets(m: CorrelationMatrix): number | null {
  const n = m.names.length;
  if (n === 0) return null;
  let total = 0;
  for (const row of m.matrix) for (const c of row) { if (c === null) return null; total += c; }
  return total <= 0 ? null : r4(Math.min(n, (n * n) / total));
}
