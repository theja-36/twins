import { detectDrift, type DriftReport } from "@twins/historical";
import type { AttributionRow } from "@twins/database";
import { DIMENSIONS, isEligible, reliabilityOf, toLearningOutcome, type Reliability } from "./metrics";

/**
 * Drift and degradation monitoring (Module 15 / Stage 08 §7). It REUSES the Stage 03 detector (`detectDrift`: baseline versus the most recent window, two-proportion z test, DEGRADATION = clearly lower win rate AND lower average R)
 * so there is one system, not two. Comparison is like-for-like: a subject is a strategy VERSION, a channel, or a regime within a strategy version, never a mixture of versions. Too little evidence is reported as INSUFFICIENT_DATA, which is
 * not the same as "no drift". Nothing here disables or changes anything: a warning is a request for human review.
 */
export const DRIFT_MONITOR_VERSION = "drift-monitor-v1";
export interface DriftFinding { subjectKind: "STRATEGY_VERSION" | "CHANNEL" | "STRATEGY_REGIME" | "SOURCE"; subject: string; n: number; reliability: Reliability; report: DriftReport; warn: boolean }
export function monitorPerformanceDrift(records: readonly AttributionRow[], minWindow: number): DriftFinding[] {
  const eligible = records.filter(isEligible), out: DriftFinding[] = [];
  const groups: Array<[DriftFinding["subjectKind"], string, (r: AttributionRow) => string | null | undefined]> = [["STRATEGY_VERSION", "strategyVersion", DIMENSIONS["strategyVersion"] as never], ["CHANNEL", "channel", DIMENSIONS["channel"] as never], ["SOURCE", "source", DIMENSIONS["source"] as never],
    ["STRATEGY_REGIME", "strategy_regime", (r) => { const s = DIMENSIONS["strategyVersion"]!(r), g = DIMENSIONS["regime"]!(r); return s && g ? `${s}|${g}` : null; }]];
  for (const [kind, , key] of groups) {
    const g = new Map<string, AttributionRow[]>(); for (const r of eligible) { const k = key(r); if (k) g.set(k, [...(g.get(k) ?? []), r]); }
    for (const [subject, rs] of [...g.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const report = detectDrift(rs.map(toLearningOutcome), { minWindow, recentCount: minWindow });
      out.push({ subjectKind: kind, subject, n: rs.length, reliability: reliabilityOf(rs, minWindow * 2), report, warn: report.status === "DRIFT" || report.status === "DEGRADATION" });
    }
  }
  return out;
}
export type Shift = { status: "INSUFFICIENT_DATA" | "NO_SHIFT" | "SHIFT"; totalVariationDistance: number | null; baselineN: number; recentN: number };
/** Change in a categorical distribution (agent verdicts, decision outcomes, data-quality codes) between an earlier and a recent window: total variation distance, reported only when both windows are large enough. */
export function distributionShift(baseline: Record<string, number>, recent: Record<string, number>, minN: number, threshold = 0.25): Shift {
  const bn = Object.values(baseline).reduce((a, b) => a + b, 0), rn = Object.values(recent).reduce((a, b) => a + b, 0);
  if (bn < minN || rn < minN) return { status: "INSUFFICIENT_DATA", totalVariationDistance: null, baselineN: bn, recentN: rn };
  const keys = new Set([...Object.keys(baseline), ...Object.keys(recent)]); let tvd = 0;
  for (const k of keys) tvd += Math.abs((baseline[k] ?? 0) / bn - (recent[k] ?? 0) / rn);
  tvd = Math.round((tvd / 2) * 10_000) / 10_000;
  return { status: tvd >= threshold ? "SHIFT" : "NO_SHIFT", totalVariationDistance: tvd, baselineN: bn, recentN: rn };
}
/** Splits chronologically ordered items into an earlier (baseline) and a recent window of `recentCount` items and tallies a category for each. */
export function windowTallies<T>(items: readonly T[], recentCount: number, cat: (t: T) => string): { baseline: Record<string, number>; recent: Record<string, number> } {
  const base: Record<string, number> = {}, rec: Record<string, number> = {}, cut = Math.max(0, items.length - recentCount);
  items.forEach((t, i) => { const k = cat(t), dst = i >= cut ? rec : base; dst[k] = (dst[k] ?? 0) + 1; });
  return { baseline: base, recent: rec };
}
