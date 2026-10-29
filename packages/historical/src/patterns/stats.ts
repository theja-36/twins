import { InputError } from "../readers";
import { R_MODEL, computeMetrics, round, type Metrics, type ScoredSignal } from "../scorecards/metrics";

/**
 * Pattern statistics (Stage 4 / Task 4). Uncertainty method: the WILSON SCORE INTERVAL for the win proportion (wins / entered trades) at a fixed z (default 1.96, ~95%), chosen because it
 * behaves at small n and at proportions near 0 or 1. The conservative expectancy bound is the normal-approximation lower limit of the mean net R per evaluable outcome
 * (mean - z x sd / sqrt(n)); with n < 2 it is null. These are historical ASSOCIATION statistics: they carry no causal claim and no guarantee about future signals.
 */
export const PATTERN_ALGORITHM_VERSION = "pattern-metrics-v1";
export type EvidenceStatus = "SUFFICIENT" | "INSUFFICIENT_EVIDENCE" | "LOW_QUALITY_EVIDENCE";

export function wilsonInterval(successes: number, n: number, z: number): { lower: number; upper: number } | null {
  if (n <= 0 || successes < 0 || successes > n) return null;
  const p = successes / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: round(Math.max(0, centre - half)), upper: round(Math.min(1, centre + half)) };
}

export interface PatternConfig { minSample: number; maxUnverifiableRate: number; wilsonZ: number; costPerTradeR: number; embargoDays: number }
export const DEFAULT_PATTERN_CONFIG: PatternConfig = { minSample: 30, maxUnverifiableRate: 0.4, wilsonZ: 1.96, costPerTradeR: 0.05, embargoDays: 30 };
export function resolvePatternConfig(over: Partial<PatternConfig> = {}): PatternConfig {
  const c = { ...DEFAULT_PATTERN_CONFIG, ...over };
  if (!Number.isInteger(c.minSample) || c.minSample < 1 || c.minSample > 100_000 || !(c.maxUnverifiableRate >= 0 && c.maxUnverifiableRate <= 1) || !(c.wilsonZ > 0 && c.wilsonZ <= 4) || !(c.costPerTradeR >= 0 && c.costPerTradeR <= 1) || !Number.isInteger(c.embargoDays) || c.embargoDays < 0 || c.embargoDays > 3650) throw new InputError("invalid_pattern_config");
  return c;
}

export interface PatternMetrics extends Metrics {
  winRateEnteredWilsonLower: number | null; winRateEnteredWilsonUpper: number | null; netExpectancyLowerBoundR: number | null; netExpectancyStdDevR: number | null;
}
export interface PatternStats { status: EvidenceStatus; flags: string[]; sampleSize: number; metrics: PatternMetrics; firstObserved: Date | null; lastObserved: Date | null }

const ENTERED = new Set(["WIN_T1", "WIN_T2", "WIN_T3", "LOSS_SL", "EXPIRED_AFTER_ENTRY"]);
export function computePatternStats(signals: ScoredSignal[], cfg: PatternConfig): PatternStats {
  const m = computeMetrics(signals, { costPerTradeR: cfg.costPerTradeR });
  const w = wilsonInterval(m.wins, m.entered, cfg.wilsonZ);
  const rs = signals.filter((s) => s.isSignal && s.outcome !== null && s.outcome in R_MODEL).map((s) => R_MODEL[s.outcome as keyof typeof R_MODEL] - (ENTERED.has(s.outcome as string) ? cfg.costPerTradeR : 0));
  let lower: number | null = null, sd: number | null = null;
  if (rs.length >= 2) {
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
    lower = round(mean - (cfg.wilsonZ * sd) / Math.sqrt(rs.length));
    sd = round(sd);
  }
  const flags: string[] = ["HISTORICAL_ASSOCIATION_ONLY"];
  let status: EvidenceStatus = "SUFFICIENT";
  if (m.evaluable < cfg.minSample) { status = "INSUFFICIENT_EVIDENCE"; flags.push("SAMPLE_BELOW_MINIMUM"); }
  if ((m.unverifiableRate ?? 0) > cfg.maxUnverifiableRate) { if (status === "SUFFICIENT") status = "LOW_QUALITY_EVIDENCE"; flags.push("HIGH_UNVERIFIABLE_SHARE"); }
  const seen = signals.filter((s) => s.isSignal && s.outcome !== null).map((s) => s.at.getTime());
  return {
    status, flags, sampleSize: m.evaluable, firstObserved: seen.length ? new Date(Math.min(...seen)) : null, lastObserved: seen.length ? new Date(Math.max(...seen)) : null,
    metrics: { ...m, winRateEnteredWilsonLower: w ? w.lower : null, winRateEnteredWilsonUpper: w ? w.upper : null, netExpectancyLowerBoundR: lower, netExpectancyStdDevR: sd },
  };
}
