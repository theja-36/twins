import { InputError } from "../readers";
import type { Tier } from "../scorecards/tiers";
import { deriveFeatures, FEATURE_VERSION, patternKeys, type FeatureInput, type Features } from "./features";
import { wilsonInterval, type EvidenceStatus, type PatternMetrics } from "./stats";

/**
 * Confidence estimator (Stage 4 / Task 4): LOCAL and DETERMINISTIC - no LLM, no randomness, no clock. Same inputs + pattern snapshot + configuration => same output.
 *
 *   evidence   exact-key patterns only (levels 1-4); the primary pattern is the deepest level that has any observations and is not INSUFFICIENT (else, if configured, the deepest observed).
 *   score      100 x Wilson lower bound of the primary pattern's win rate (over entered trades) x quality factors (unverifiable share, pattern and signal data quality, missing market
 *              context, invalid stop-loss, conflicts with other matched levels), then limited by the caps below. Evidence exists => at least 1; no usable evidence => UNKNOWN, score 0.
 *   caps       source trust UNKNOWN / D -> LOW, C -> MEDIUM; unverifiable share above the limit, LOW_QUALITY_EVIDENCE, non-positive net expectancy, invalid stop-loss -> LOW.
 * A confidence is a statement about HISTORICAL ASSOCIATION in the matched pattern; it is not a prediction, a probability of profit, or advice.
 */
export const CONFIDENCE_ALGORITHM_VERSION = "pattern-confidence-v1";
export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type CapTier = "LOW" | "MEDIUM";
export type DataQualityInput = "GOOD" | "DEGRADED" | "INSUFFICIENT" | "UNKNOWN";

export interface ConfidenceConfig {
  /** Bounds of the score bands: LOW 1..mediumMin-1, MEDIUM mediumMin..highMin-1, HIGH highMin..100. */
  mediumMin: number; highMin: number;
  minSample: number; maxUnverifiableRate: number; wilsonZ: number;
  trustCaps: Record<Tier, CapTier | null>;
  /** "UNKNOWN": a pattern below the minimum sample gives UNKNOWN (default). "CAP_LOW": it is used but capped at LOW. */
  insufficientSample: "UNKNOWN" | "CAP_LOW";
  factors: { dataQuality: Record<DataQualityInput, number>; marketContextUnavailable: number; conflict: number; invalidStopLoss: number };
}
export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceConfig = {
  mediumMin: 40, highMin: 65, minSample: 30, maxUnverifiableRate: 0.4, wilsonZ: 1.96,
  trustCaps: { A: null, B: null, C: "MEDIUM", D: "LOW", UNKNOWN: "LOW" }, insufficientSample: "UNKNOWN",
  factors: { dataQuality: { GOOD: 1, DEGRADED: 0.85, INSUFFICIENT: 0.6, UNKNOWN: 0.8 }, marketContextUnavailable: 0.9, conflict: 0.8, invalidStopLoss: 0.5 },
};
export type ConfidenceConfigOverride = Partial<Omit<ConfidenceConfig, "trustCaps" | "factors">> & { trustCaps?: Partial<ConfidenceConfig["trustCaps"]>; factors?: Partial<Omit<ConfidenceConfig["factors"], "dataQuality">> & { dataQuality?: Partial<Record<DataQualityInput, number>> } };

export function resolveConfidenceConfig(o: ConfidenceConfigOverride = {}): ConfidenceConfig {
  const d = DEFAULT_CONFIDENCE_CONFIG;
  const c: ConfidenceConfig = {
    mediumMin: o.mediumMin ?? d.mediumMin, highMin: o.highMin ?? d.highMin, minSample: o.minSample ?? d.minSample, maxUnverifiableRate: o.maxUnverifiableRate ?? d.maxUnverifiableRate, wilsonZ: o.wilsonZ ?? d.wilsonZ,
    insufficientSample: o.insufficientSample ?? d.insufficientSample, trustCaps: { ...d.trustCaps, ...o.trustCaps },
    factors: { ...d.factors, ...o.factors, dataQuality: { ...d.factors.dataQuality, ...o.factors?.dataQuality } },
  };
  const unit = [c.maxUnverifiableRate, c.factors.marketContextUnavailable, c.factors.conflict, c.factors.invalidStopLoss, ...Object.values(c.factors.dataQuality)];
  if (!(c.mediumMin >= 2 && c.highMin > c.mediumMin && c.highMin <= 100) || !Number.isInteger(c.minSample) || c.minSample < 1 || !(c.wilsonZ > 0 && c.wilsonZ <= 4) || unit.some((x) => !(x >= 0 && x <= 1)) || !["UNKNOWN", "CAP_LOW"].includes(c.insufficientSample)
    || Object.values(c.trustCaps).some((x) => x !== null && x !== "LOW" && x !== "MEDIUM")) throw new InputError("invalid_confidence_config");
  return c;
}

/** The slice of a pattern snapshot the estimator needs. */
export interface PatternView { patternId: string; snapshotId: string; keyText: string; level: number; status: EvidenceStatus; sampleSize: number; metrics: PatternMetrics }
export interface SignalForConfidence extends FeatureInput {
  /** Stop-loss present, on the right side of the entry and passing the shared stop-loss rule. */
  stopLossValid: boolean;
  dataQuality: DataQualityInput;
}
export interface MarketContext { available: boolean }
export interface ConfidenceEstimate {
  score: number; tier: ConfidenceTier;
  evidenceQuality: "SUFFICIENT" | "LOW_QUALITY_EVIDENCE" | "INSUFFICIENT_EVIDENCE" | "NO_MATCH" | "NO_LIBRARY";
  sampleSize: number; primaryPatternKey: string | null;
  patternRefs: Array<{ level: number; keyText: string; patternId: string; snapshotId: string; status: EvidenceStatus; sampleSize: number }>;
  inputs: Record<string, unknown>; explanation: Array<{ rule: string; detail: string }>; limitations: string[];
}
/** The highest score a cap allows: the top of the capped band (LOW: below mediumMin, MEDIUM: below highMin) under the active configuration. */
const capMax = (c: CapTier, cfg: ConfidenceConfig): number => (c === "LOW" ? cfg.mediumMin - 1 : cfg.highMin - 1);
const RANK: Record<ConfidenceTier, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function tierOf(score: number, cfg: ConfidenceConfig): ConfidenceTier {
  return score <= 0 ? "UNKNOWN" : score >= cfg.highMin ? "HIGH" : score >= cfg.mediumMin ? "MEDIUM" : "LOW";
}

export function computeConfidence(signal: SignalForConfidence, trust: Tier, ctx: MarketContext, lookup: (keyText: string) => PatternView | undefined, cfg: ConfidenceConfig, extraLimitations: string[] = []): ConfidenceEstimate {
  const features: Features = deriveFeatures(signal);
  const keys = patternKeys(features);
  const found = keys.map((k) => ({ k, p: lookup(k.keyText) })).filter((x): x is { k: (typeof keys)[number]; p: PatternView } => x.p !== undefined);
  const limitations = ["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM", "EXACT_FEATURE_MATCH_ONLY", "NOT_A_PREDICTION_OR_ADVICE", ...extraLimitations];
  if (!ctx.available) limitations.push("MARKET_CONTEXT_UNAVAILABLE");
  const inputs = { featureVersion: FEATURE_VERSION, features, sourceTrustTier: trust, dataQuality: signal.dataQuality, stopLossValid: signal.stopLossValid, marketContextAvailable: ctx.available };
  const refs = found.map(({ p }) => ({ level: p.level, keyText: p.keyText, patternId: p.patternId, snapshotId: p.snapshotId, status: p.status, sampleSize: p.sampleSize }));
  const unknown = (quality: ConfidenceEstimate["evidenceQuality"], rule: string, detail: string): ConfidenceEstimate => ({ score: 0, tier: "UNKNOWN", evidenceQuality: quality, sampleSize: found.length ? (found[found.length - 1] as { p: PatternView }).p.sampleSize : 0, primaryPatternKey: null, patternRefs: refs, inputs, explanation: [{ rule, detail }], limitations });
  if (found.length === 0) return unknown("NO_MATCH", "NO_MATCHING_PATTERN", "no pattern with this exact feature combination exists at any level");

  const usable = found.filter((x) => x.p.status !== "INSUFFICIENT_EVIDENCE");
  let primary = usable.length ? (usable[usable.length - 1] as (typeof found)[number]) : undefined;
  const explanation: ConfidenceEstimate["explanation"] = [];
  let insufficientFallback = false;
  if (!primary) {
    if (cfg.insufficientSample === "UNKNOWN") return unknown("INSUFFICIENT_EVIDENCE", "INSUFFICIENT_SAMPLE", `deepest matching pattern has ${(found[found.length - 1] as { p: PatternView }).p.sampleSize} evaluable outcomes (minimum ${cfg.minSample})`);
    primary = found[found.length - 1] as (typeof found)[number];
    insufficientFallback = true;
  }
  const p = primary.p, m = p.metrics;
  explanation.push({ rule: "PRIMARY_PATTERN", detail: `${p.keyText} (level ${p.level}, ${p.sampleSize} evaluable, status ${p.status})` });
  const w = wilsonInterval(m.wins, m.entered, cfg.wilsonZ);
  const raw = w ? w.lower : 0;
  explanation.push({ rule: "WIN_RATE_WILSON_LOWER_BOUND", detail: `${m.wins}/${m.entered} wins -> lower bound ${raw}` });
  let factor = 1;
  const apply = (rule: string, f: number, detail: string): void => { if (f < 1) { factor *= f; explanation.push({ rule, detail: `x${f} (${detail})` }); } };
  apply("UNVERIFIABLE_SHARE_FACTOR", 1 - (m.unverifiableRate ?? 0), `unverifiable share ${m.unverifiableRate ?? 0}`);
  apply("PATTERN_DATA_QUALITY_FACTOR", m.dataQualityScore ?? 0.8, `pattern data-quality score ${m.dataQualityScore ?? "unknown"}`);
  apply("SIGNAL_DATA_QUALITY_FACTOR", cfg.factors.dataQuality[signal.dataQuality], `signal data quality ${signal.dataQuality}`);
  if (!ctx.available) apply("MARKET_CONTEXT_FACTOR", cfg.factors.marketContextUnavailable, "market context unavailable");
  if (!signal.stopLossValid) apply("INVALID_STOP_LOSS_FACTOR", cfg.factors.invalidStopLoss, "stop-loss missing or invalid");
  // conflicting evidence: another matched level with real evidence that disagrees with the primary one
  const conflicts = usable.filter(({ p: o }) => o.level !== p.level && ((o.metrics.netExpectancyR ?? 0) > 0) !== ((m.netExpectancyR ?? 0) > 0)).length
    + usable.filter(({ p: o }) => o.level !== p.level && o.metrics.winRateEnteredWilsonLower !== null && m.winRateEnteredWilsonUpper !== null && m.winRateEnteredWilsonLower !== null && o.metrics.winRateEnteredWilsonUpper !== null
      && (o.metrics.winRateEnteredWilsonLower > m.winRateEnteredWilsonUpper || m.winRateEnteredWilsonLower > o.metrics.winRateEnteredWilsonUpper)).length;
  if (conflicts > 0) { factor *= cfg.factors.conflict ** conflicts; explanation.push({ rule: "CONFLICTING_EVIDENCE", detail: `x${cfg.factors.conflict}^${conflicts} (matched levels disagree on expectancy sign or win-rate interval)` }); }

  let score = Math.max(1, Math.round(100 * raw * factor));
  // caps
  let cap: CapTier | null = null;
  const capBy = (c: CapTier | null, rule: string, detail: string): void => {
    if (!c) return;
    explanation.push({ rule, detail: `capped at ${c} (${detail})` });
    if (cap === null || capMax(c, cfg) < capMax(cap, cfg)) cap = c;
  };
  capBy(cfg.trustCaps[trust], "SOURCE_TRUST_CAP", `source trust tier ${trust}`);
  if ((m.unverifiableRate ?? 0) > cfg.maxUnverifiableRate) capBy("LOW", "UNVERIFIABLE_RATE_CAP", `unverifiable share ${m.unverifiableRate} above ${cfg.maxUnverifiableRate}`);
  if (p.status === "LOW_QUALITY_EVIDENCE") capBy("LOW", "LOW_QUALITY_EVIDENCE_CAP", "pattern evidence is low quality");
  if (insufficientFallback) capBy("LOW", "INSUFFICIENT_SAMPLE_CAP", `sample ${p.sampleSize} below ${cfg.minSample}`);
  if (!((m.netExpectancyR ?? 0) > 0)) capBy("LOW", "NON_POSITIVE_EXPECTANCY_CAP", `net expectancy ${m.netExpectancyR ?? "n/a"}R`);
  if (!signal.stopLossValid) capBy("LOW", "INVALID_STOP_LOSS_CAP", "stop-loss missing or invalid");
  const capNow: CapTier | null = cap;
  if (capNow !== null) score = Math.min(score, capMax(capNow, cfg));
  score = Math.min(100, score);
  const tier = tierOf(score, cfg);
  if (RANK[tier] === 0) return unknown("INSUFFICIENT_EVIDENCE", "NO_USABLE_SCORE", "score could not be established");
  if (found[found.length - 1] && (found[found.length - 1] as { p: PatternView }).p.level > p.level) limitations.push("DEEPER_LEVELS_INSUFFICIENT_OR_ABSENT");
  const evidenceQuality = insufficientFallback ? "INSUFFICIENT_EVIDENCE" : p.status === "LOW_QUALITY_EVIDENCE" ? "LOW_QUALITY_EVIDENCE" : "SUFFICIENT";
  explanation.push({ rule: "SCORE", detail: `${score} -> ${tier}` });
  return { score, tier, evidenceQuality, sampleSize: p.sampleSize, primaryPatternKey: p.keyText, patternRefs: refs, inputs, explanation, limitations };
}
