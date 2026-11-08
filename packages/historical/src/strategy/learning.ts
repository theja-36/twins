import { wilsonInterval } from "../patterns/stats";

/**
 * Strategy learning analytics (Modules 06 and 07): performance by condition, profitability, drift and degradation, stop-loss behaviour, outcome reasons, revision effects and
 * counterfactual review. PURE and deterministic. HISTORICAL ASSOCIATION ONLY: thin slices are marked INSUFFICIENT_EVIDENCE and never ranked as "best" or "worst"; a counterfactual is a
 * review of what the recorded outcomes would have looked like, never a recommendation and never applied to live policy (activation is a separate, owner-only step).
 */
export const LEARNING_VERSION = "strategy-learning-v1";
export interface LearningConfig { minSliceResolved: number; minWindow: number; recentCount: number; zCritical: number; wilsonZ: number; nearStopMaeR: number; stopBands: { tightMaxPct: number; mediumMaxPct: number } }
export const DEFAULT_LEARNING: LearningConfig = { minSliceResolved: 30, minWindow: 30, recentCount: 30, zCritical: 2.576, wilsonZ: 1.96, nearStopMaeR: 0.8, stopBands: { tightMaxPct: 15, mediumMaxPct: 30 } };

export type Outcome = "WIN" | "LOSS" | "BREAKEVEN" | "UNRESOLVED";
export interface LearningOutcome {
  id: string; at: Date; outcome: Outcome; rMultiple: number | null;
  /** Best and worst excursion in R during the trade, when recorded (paper outcomes carry them). */
  mfeR?: number | null; maeR?: number | null; closeReason?: string | null;
  dims: Record<string, string | null | undefined>;
  stopDistancePct?: number | null; rewardToRisk?: number | null;
  edited?: boolean; firstEditDelaySec?: number | null;
}
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
const resolvedOnly = (o: readonly LearningOutcome[]): LearningOutcome[] => o.filter((x) => x.outcome !== "UNRESOLVED").sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));
const rs = (o: readonly LearningOutcome[]): number[] => o.map((x) => x.rMultiple).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const mean = (v: readonly number[]): number | null => (v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null);

export interface Stats { n: number; resolved: number; wins: number; losses: number; winRate: number | null; winRateInterval: { lower: number; upper: number } | null; avgR: number | null; totalR: number | null; profitFactor: number | null; maxDrawdownR: number | null; status: "SUFFICIENT" | "INSUFFICIENT_EVIDENCE" }
export function computeStats(outcomes: readonly LearningOutcome[], minResolved: number, z = DEFAULT_LEARNING.wilsonZ): Stats {
  const r = resolvedOnly(outcomes), wins = r.filter((x) => x.outcome === "WIN").length, losses = r.filter((x) => x.outcome === "LOSS").length;
  const rv = rs(r), gain = rv.filter((v) => v > 0).reduce((a, b) => a + b, 0), loss = -rv.filter((v) => v < 0).reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, dd = 0; for (const v of rv) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { n: outcomes.length, resolved: r.length, wins, losses, winRate: r.length ? round(wins / r.length) : null, winRateInterval: r.length ? wilsonInterval(wins, r.length, z) : null, avgR: mean(rv), totalR: rv.length ? round(rv.reduce((a, b) => a + b, 0)) : null,
    profitFactor: loss > 0 ? round(gain / loss) : null, maxDrawdownR: rv.length ? round(dd) : null, status: r.length >= minResolved ? "SUFFICIENT" : "INSUFFICIENT_EVIDENCE" };
}

export interface Slice { value: string; stats: Stats }
export interface ConditionalPerformance { dimension: string; slices: Slice[]; unknown: Stats; best: string | null; worst: string | null; note: string }
/** Performance per value of one dimension (time of day, instrument, regime, setup, cluster...). Best and worst are named only among slices with sufficient evidence, by average R. */
export function conditionalPerformance(outcomes: readonly LearningOutcome[], dimension: string, override: Partial<LearningConfig> = {}): ConditionalPerformance {
  const cfg = { ...DEFAULT_LEARNING, ...override };
  const groups = new Map<string, LearningOutcome[]>(); const unknown: LearningOutcome[] = [];
  for (const o of outcomes) { const v = o.dims[dimension]; if (v == null || v.trim() === "" || /^UNKNOWN/i.test(v)) unknown.push(o); else { const k = v.trim().toUpperCase(); (groups.get(k) ?? groups.set(k, []).get(k) as LearningOutcome[]).push(o); } }
  const slices = [...groups.entries()].map(([value, os]) => ({ value, stats: computeStats(os, cfg.minSliceResolved, cfg.wilsonZ) })).sort((a, b) => b.stats.resolved - a.stats.resolved || (a.value < b.value ? -1 : 1));
  const ranked = slices.filter((s) => s.stats.status === "SUFFICIENT" && s.stats.avgR !== null).sort((a, b) => (b.stats.avgR as number) - (a.stats.avgR as number) || (a.value < b.value ? -1 : 1));
  const best = ranked.length >= 2 ? (ranked[0] as Slice).value : null, worst = ranked.length >= 2 ? (ranked[ranked.length - 1] as Slice).value : null;
  return { dimension, slices, unknown: computeStats(unknown, cfg.minSliceResolved, cfg.wilsonZ), best, worst, note: ranked.length >= 2 ? "best and worst compare only slices with enough resolved outcomes" : "no best or worst: fewer than two slices have enough resolved outcomes" };
}

export interface DriftReport {
  version: string; status: "NO_DRIFT" | "DRIFT" | "DEGRADATION" | "INSUFFICIENT_DATA";
  baseline: Stats | null; recent: Stats | null; z: number | null; winRateDelta: number | null; avgRDelta: number | null; note: string;
}
/** Compares the latest `recentCount` resolved outcomes with everything earlier (two-proportion z test on the win rate). DEGRADATION = drift with BOTH a lower win rate and a lower average R. */
export function detectDrift(outcomes: readonly LearningOutcome[], override: Partial<LearningConfig> = {}): DriftReport {
  const cfg = { ...DEFAULT_LEARNING, ...override };
  const r = resolvedOnly(outcomes), recent = r.slice(-cfg.recentCount), base = r.slice(0, Math.max(0, r.length - cfg.recentCount));
  if (recent.length < cfg.minWindow || base.length < cfg.minWindow) return { version: LEARNING_VERSION, status: "INSUFFICIENT_DATA", baseline: null, recent: null, z: null, winRateDelta: null, avgRDelta: null, note: `needs at least ${cfg.minWindow} resolved outcomes in both the baseline and the recent window (have ${base.length} and ${recent.length})` };
  const b = computeStats(base, cfg.minWindow, cfg.wilsonZ), c = computeStats(recent, cfg.minWindow, cfg.wilsonZ);
  const p1 = b.wins / b.resolved, p2 = c.wins / c.resolved, pool = (b.wins + c.wins) / (b.resolved + c.resolved), se = Math.sqrt(pool * (1 - pool) * (1 / b.resolved + 1 / c.resolved));
  const z = se === 0 ? 0 : (p2 - p1) / se, winDelta = round(p2 - p1), avgDelta = b.avgR !== null && c.avgR !== null ? round(c.avgR - b.avgR) : null;
  const drift = Math.abs(z) >= cfg.zCritical;
  const status = !drift ? "NO_DRIFT" : winDelta < 0 && avgDelta !== null && avgDelta < 0 ? "DEGRADATION" : "DRIFT";
  return { version: LEARNING_VERSION, status, baseline: b, recent: c, z: round(z, 3), winRateDelta: winDelta, avgRDelta: avgDelta, note: status === "NO_DRIFT" ? "no statistically clear change" : status === "DEGRADATION" ? "recent results are clearly worse on win rate and average R" : "recent behaviour differs clearly from the baseline" };
}
/** The row to record in `strategy_drift_events` for a drift or degradation (null when there is nothing to record). */
export function driftEventOf(r: DriftReport): { kind: "DRIFT" | "DEGRADATION"; metric: string; baseline: number; observed: number; details: Record<string, unknown> } | null {
  if ((r.status !== "DRIFT" && r.status !== "DEGRADATION") || !r.baseline || !r.recent || r.baseline.winRate === null || r.recent.winRate === null) return null;
  return { kind: r.status, metric: "win_rate", baseline: r.baseline.winRate, observed: r.recent.winRate, details: { z: r.z, winRateDelta: r.winRateDelta, avgRDelta: r.avgRDelta, baselineN: r.baseline.resolved, recentN: r.recent.resolved } };
}

export interface StopBehaviour { stopHitRate: number | null; byBand: Record<"TIGHT" | "MEDIUM" | "WIDE" | "UNKNOWN", Stats>; nearStopWinners: { winners: number; nearStop: number; share: number | null } }
/** Stop-loss behaviour: how often the stop is hit, results by stop width, and how many winners came close to the stop (a stop that was nearly hit and not hit). */
export function stopBehaviour(outcomes: readonly LearningOutcome[], override: Partial<LearningConfig> = {}): StopBehaviour {
  const cfg = { ...DEFAULT_LEARNING, ...override }; const r = resolvedOnly(outcomes);
  const band = (p: number | null | undefined): "TIGHT" | "MEDIUM" | "WIDE" | "UNKNOWN" => (p == null ? "UNKNOWN" : p <= cfg.stopBands.tightMaxPct ? "TIGHT" : p <= cfg.stopBands.mediumMaxPct ? "MEDIUM" : "WIDE");
  const by = { TIGHT: [] as LearningOutcome[], MEDIUM: [] as LearningOutcome[], WIDE: [] as LearningOutcome[], UNKNOWN: [] as LearningOutcome[] };
  for (const o of r) by[band(o.stopDistancePct)].push(o);
  const winners = r.filter((o) => o.outcome === "WIN" && typeof o.maeR === "number"), near = winners.filter((o) => Math.abs(o.maeR as number) >= cfg.nearStopMaeR).length;
  return { stopHitRate: r.length ? round(r.filter((o) => o.outcome === "LOSS").length / r.length) : null, byBand: { TIGHT: computeStats(by.TIGHT, cfg.minSliceResolved), MEDIUM: computeStats(by.MEDIUM, cfg.minSliceResolved), WIDE: computeStats(by.WIDE, cfg.minSliceResolved), UNKNOWN: computeStats(by.UNKNOWN, cfg.minSliceResolved) }, nearStopWinners: { winners: winners.length, nearStop: near, share: winners.length ? round(near / winners.length) : null } };
}

export interface ReasonRow { reason: string; count: number; share: number; avgR: number | null }
/** Outcome-reason analysis: how trades ended (target, stop, square-off...) and what each ending was worth. */
export function reasonBreakdown(outcomes: readonly LearningOutcome[]): ReasonRow[] {
  const r = resolvedOnly(outcomes); const m = new Map<string, LearningOutcome[]>();
  for (const o of r) { const k = (o.closeReason ?? "UNKNOWN").toUpperCase(); (m.get(k) ?? m.set(k, []).get(k) as LearningOutcome[]).push(o); }
  return [...m.entries()].map(([reason, os]) => ({ reason, count: os.length, share: round(os.length / Math.max(1, r.length)), avgR: mean(rs(os)) })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

export interface RevisionAnalysis { editedShare: number | null; medianFirstEditDelaySec: number | null; edited: Stats; unedited: Stats }
/** Signal revision and staleness analysis: how often a call is edited after sending, how quickly, and whether edited calls did differently. */
export function revisionAnalysis(outcomes: readonly LearningOutcome[], override: Partial<LearningConfig> = {}): RevisionAnalysis {
  const cfg = { ...DEFAULT_LEARNING, ...override }; const known = outcomes.filter((o) => typeof o.edited === "boolean");
  const delays = known.filter((o) => o.edited && typeof o.firstEditDelaySec === "number").map((o) => o.firstEditDelaySec as number).sort((a, b) => a - b);
  const median = delays.length ? ((delays[Math.floor((delays.length - 1) / 2)] as number) + (delays[Math.ceil((delays.length - 1) / 2)] as number)) / 2 : null;
  return { editedShare: known.length ? round(known.filter((o) => o.edited).length / known.length) : null, medianFirstEditDelaySec: median, edited: computeStats(known.filter((o) => o.edited), cfg.minSliceResolved), unedited: computeStats(known.filter((o) => !o.edited), cfg.minSliceResolved) };
}

export type Scenario = { kind: "min_reward_to_risk"; minR: number } | { kind: "stop_at_r"; r: number } | { kind: "exclude"; dimension: string; value: string };
export interface CounterfactualResult { scenario: Scenario; actual: Stats; counterfactual: Stats; takenShare: number | null; deltaAvgR: number | null; approximation: string | null; note: string }
/**
 * Counterfactual review: what the RECORDED outcomes would have looked like under a different rule. `stop_at_r` is an approximation (a trade whose worst excursion reached the tighter stop is
 * treated as stopped there; others keep their result) and says so. This reviews the past; it changes nothing and recommends nothing.
 */
export function counterfactual(outcomes: readonly LearningOutcome[], scenario: Scenario, override: Partial<LearningConfig> = {}): CounterfactualResult {
  const cfg = { ...DEFAULT_LEARNING, ...override }; const r = resolvedOnly(outcomes); let kept: LearningOutcome[] = r; let approximation: string | null = null;
  if (scenario.kind === "min_reward_to_risk") kept = r.filter((o) => typeof o.rewardToRisk === "number" && o.rewardToRisk >= scenario.minR);
  else if (scenario.kind === "exclude") kept = r.filter((o) => (o.dims[scenario.dimension] ?? "").trim().toUpperCase() !== scenario.value.trim().toUpperCase());
  else {
    approximation = "uses the recorded worst excursion (MAE) to decide whether the tighter stop would have been hit; ignores slippage and what happened after";
    kept = r.map((o) => (typeof o.maeR === "number" && Math.abs(o.maeR) >= scenario.r ? { ...o, outcome: "LOSS" as const, rMultiple: -Math.abs(scenario.r) } : o));
  }
  const actual = computeStats(r, cfg.minSliceResolved), cf = computeStats(kept, cfg.minSliceResolved);
  return { scenario, actual, counterfactual: cf, takenShare: r.length ? round(kept.length / r.length) : null, deltaAvgR: actual.avgR !== null && cf.avgR !== null ? round(cf.avgR - actual.avgR) : null, approximation, note: cf.status === "SUFFICIENT" ? "review of recorded outcomes only; not a recommendation" : "too few resolved outcomes for the counterfactual to mean anything" };
}

export interface OutOfSampleEvaluation { outOfSample: true; resolved: number; driftFlag: boolean; evaluatedAt: string; metrics: Stats & { drift: DriftReport["status"] } }
/**
 * Builds the evaluation a playbook activation needs. ONLY outcomes strictly AFTER the end of the window the profile was learned from count (`profileWindowEnd`), so the result is out of
 * sample by construction; earlier outcomes are ignored. Drift is checked inside that window. It does not decide anything: activation (owner only) applies its own gate.
 */
export function evaluateOutOfSample(outcomes: readonly LearningOutcome[], profileWindowEnd: Date, now: Date, override: Partial<LearningConfig> = {}): OutOfSampleEvaluation {
  const cfg = { ...DEFAULT_LEARNING, ...override };
  const after = outcomes.filter((o) => o.at.getTime() > profileWindowEnd.getTime() && o.at.getTime() <= now.getTime());
  const stats = computeStats(after, cfg.minSliceResolved, cfg.wilsonZ), drift = detectDrift(after, cfg);
  return { outOfSample: true, resolved: stats.resolved, driftFlag: drift.status === "DRIFT" || drift.status === "DEGRADATION", evaluatedAt: now.toISOString(), metrics: { ...stats, drift: drift.status } };
}
