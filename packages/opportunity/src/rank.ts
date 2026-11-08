import type { MarketRegimeObject } from "@twins/agents";
import type { SetupSignal } from "./setups";

/**
 * Deterministic, explainable ranking and confluence (Module 16). A score orders candidates for REVIEW; it is not a probability, not a win rate and not permission to act. Every factor is listed with its points,
 * and every piece of evidence that was not available is listed in `missing` (missing evidence scores ZERO: it is never treated as supportive and never as neutral-positive). No calibration exists, so there is no confidence.
 */
export const RANK_MODEL_VERSION = "opportunity-rank-v1";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
export interface RankFactor { code: string; points: number; note: string }
export interface RankDetail { version: string; score: number; factors: RankFactor[]; missing: string[]; confidence: null; calibrated: false; grantsApproval: false }
export interface RankContext { htfTrend: Trend; regime: MarketRegimeObject | null; regimeUsable: boolean }
const BASE = 30;
const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 100) / 100));

export function rankSetup(s: SetupSignal, c: RankContext): RankDetail {
  const f: RankFactor[] = [{ code: "SETUP_VALID", points: BASE, note: "a rule-based setup with a protective stop and an invalidation level" }], missing: string[] = [];
  const want = s.side === "BUY" ? "BULLISH" : "BEARISH", against = s.side === "BUY" ? "BEARISH" : "BULLISH";
  // multi-timeframe confluence
  if (c.htfTrend === "UNKNOWN") missing.push("HTF_TREND_UNAVAILABLE");
  else if (c.htfTrend === want) f.push({ code: "HTF_ALIGNED", points: 20, note: "the higher-timeframe trend agrees with the side" });
  else if (c.htfTrend === against) f.push({ code: "HTF_OPPOSED", points: -25, note: "the higher-timeframe trend is against the side" });
  else f.push({ code: "HTF_NEUTRAL", points: 0, note: "the higher timeframe is neutral" });
  // regime context
  const r = c.regime;
  if (!r || !c.regimeUsable) missing.push(r ? "REGIME_UNUSABLE" : "REGIME_UNAVAILABLE");
  else {
    if (r.direction === want) f.push({ code: "REGIME_ALIGNED", points: 20, note: "the market regime direction agrees with the side" });
    else if (r.direction === against) f.push({ code: "REGIME_OPPOSED", points: -30, note: "the market regime direction is against the side" });
    else f.push({ code: "REGIME_NEUTRAL", points: 0, note: "the market regime is neutral" });
    if (r.volatilityRegime === "HIGH") f.push({ code: "VOLATILITY_HIGH", points: -10, note: "volatility is high" });
    if (r.volatilityRegime === "EXTREME") f.push({ code: "VOLATILITY_EXTREME", points: -20, note: "volatility is extreme" });
    if (r.eventRisk === "HIGH") f.push({ code: "EVENT_RISK_HIGH", points: -20, note: "a high-impact event is imminent" });
    else if (r.eventRisk === "ELEVATED") f.push({ code: "EVENT_RISK_ELEVATED", points: -10, note: "a high-impact event is near" });
    else if (r.eventRisk === "UNKNOWN") missing.push("EVENT_RISK_UNKNOWN");
    if (r.correlatedIndexAgreement === "MIXED") f.push({ code: "INDICES_DISAGREE", points: -5, note: "correlated indices disagree" });
    else if (r.correlatedIndexAgreement === "UNKNOWN") missing.push("INDEX_AGREEMENT_UNKNOWN");
    if (r.dataSource === "FIXTURE") f.push({ code: "FIXTURE_REGIME", points: -10, note: "the regime was computed from fixture data" });
  }
  // volume
  if (s.volumeConfirmed === true) f.push({ code: "VOLUME_CONFIRMED", points: 10, note: "volume confirms the move" });
  else if (s.volumeConfirmed === null) missing.push("VOLUME_UNKNOWN");
  // independent technical agreement (two setups of the same side on the same bar)
  return { version: RANK_MODEL_VERSION, score: clamp(f.reduce((a, x) => a + x.points, 0)), factors: f, missing, confidence: null, calibrated: false, grantsApproval: false };
}

/** Adds a confluence bonus when several DIFFERENT setup classes agree on the same side for one instrument and bar (computed once per group by the scanner). */
export function withSetupAgreement(d: RankDetail, agreeingOthers: readonly string[]): RankDetail {
  if (agreeingOthers.length === 0) return d;
  const pts = Math.min(10, 5 * agreeingOthers.length);
  const factors = [...d.factors, { code: "SETUPS_AGREE", points: pts, note: `also detected on the same bar: ${agreeingOthers.join(", ")}` }];
  return { ...d, factors, score: clamp(factors.reduce((a, x) => a + x.points, 0)) };
}
