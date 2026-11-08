import { CONFIDENCE_MODEL_VERSION } from "./score";

/**
 * Confidence calibration (Module 09), a SEPARATE capability from scoring. It compares predicted score bands with what actually happened and only reports CALIBRATED when there is enough OUT-OF-SAMPLE evidence
 * that the observed win rate rises with the score. Until then no probability is ever produced. Nothing here invents history: with no samples every result is UNCALIBRATED with the reason.
 */
export const CALIBRATION_VERSION = "confidence-calibration-v1";
export interface Sample { score: number; won: boolean; r: number | null; outOfSample: boolean; at: string }
export interface CalibrationPolicy { binWidth: number; minOutOfSample: number; minPerBin: number; monotoneTolerance: number; maxCalibrationError: number }
export const DEFAULT_CALIBRATION_POLICY: CalibrationPolicy = { binWidth: 20, minOutOfSample: 200, minPerBin: 20, monotoneTolerance: 0.05, maxCalibrationError: 0.1 };
export interface Bin { from: number; to: number; n: number; observedWinRate: number | null; averageR: number | null; meanScore: number | null }
export interface CalibrationRun { calibrationVersion: string; modelVersion: string; sampleSize: number; outOfSampleSize: number; outOfSample: boolean; bins: Bin[]; brierScore: number | null; status: "UNCALIBRATED" | "CALIBRATING" | "CALIBRATED"; reasons: string[] }
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
export function binsOf(samples: readonly Sample[], width: number): Bin[] {
  const out: Bin[] = [];
  for (let from = 0; from < 100; from += width) {
    const to = from + width, xs = samples.filter((s) => s.score >= from && (to >= 100 ? s.score <= 100 : s.score < to)), rs = xs.map((s) => s.r).filter((v): v is number => v !== null);
    out.push({ from, to, n: xs.length, observedWinRate: xs.length ? round(xs.filter((s) => s.won).length / xs.length) : null, averageR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null, meanScore: xs.length ? round(xs.reduce((a, s) => a + s.score, 0) / xs.length, 2) : null });
  }
  return out;
}
/** Predicted-versus-actual comparison over all samples (descriptive; says nothing about calibration by itself). */
export const comparePredictedActual = (samples: readonly Sample[], width = DEFAULT_CALIBRATION_POLICY.binWidth): Bin[] => binsOf(samples, width);

export function evaluateCalibration(samples: readonly Sample[], policy: CalibrationPolicy = DEFAULT_CALIBRATION_POLICY, modelVersion = CONFIDENCE_MODEL_VERSION): CalibrationRun {
  const valid = samples.filter((s) => Number.isFinite(s.score) && s.score >= 0 && s.score <= 100), oos = valid.filter((s) => s.outOfSample);
  const bins = binsOf(oos, policy.binWidth), reasons: string[] = [];
  const base = { calibrationVersion: CALIBRATION_VERSION, modelVersion, sampleSize: valid.length, outOfSampleSize: oos.length, outOfSample: oos.length > 0, bins };
  if (valid.length < samples.length) reasons.push("some samples had an invalid score and were ignored");
  if (oos.length === 0) return { ...base, brierScore: null, status: "UNCALIBRATED", reasons: [...reasons, "no out-of-sample outcomes exist"] };
  const used = bins.filter((b) => b.n > 0);
  if (oos.length < policy.minOutOfSample) return { ...base, brierScore: null, status: "CALIBRATING", reasons: [...reasons, `only ${oos.length} out-of-sample outcomes (minimum ${policy.minOutOfSample})`] };
  const thin = used.filter((b) => b.n < policy.minPerBin);
  if (thin.length) reasons.push(`bins with fewer than ${policy.minPerBin} outcomes: ${thin.map((b) => `${b.from}-${b.to}`).join(", ")}`);
  const solid = used.filter((b) => b.n >= policy.minPerBin);
  for (let i = 1; i < solid.length; i++) if ((solid[i]!.observedWinRate as number) < (solid[i - 1]!.observedWinRate as number) - policy.monotoneTolerance) reasons.push(`observed win rate falls between bins ${solid[i - 1]!.from}-${solid[i - 1]!.to} and ${solid[i]!.from}-${solid[i]!.to}`);
  if (solid.length < 3) reasons.push("fewer than three populated bins: the score range is not covered");
  // Brier of the bin-rate mapping on the out-of-sample set (a calibration quality figure, not a promise)
  const rate = (score: number): number | null => bins.find((b) => score >= b.from && (b.to >= 100 ? score <= 100 : score < b.to))?.observedWinRate ?? null;
  const sq = oos.map((s) => { const p = rate(s.score); return p === null ? null : (p - (s.won ? 1 : 0)) ** 2; }).filter((v): v is number => v !== null);
  const brier = sq.length ? round(sq.reduce((a, b) => a + b, 0) / sq.length) : null;
  const ok = reasons.length === 0 && solid.length >= 3;
  return { ...base, brierScore: brier, status: ok ? "CALIBRATED" : "CALIBRATING", reasons: ok ? ["out-of-sample evidence is sufficient and monotone"] : reasons };
}
/** The only way a probability can leave this package: a CALIBRATED run and a populated bin. Otherwise null. */
export function calibratedProbability(score: number, run: CalibrationRun | null): number | null {
  if (!run || run.status !== "CALIBRATED" || !run.outOfSample) return null;
  const b = run.bins.find((x) => score >= x.from && (x.to >= 100 ? score <= 100 : score < x.to));
  return b && b.n >= DEFAULT_CALIBRATION_POLICY.minPerBin ? b.observedWinRate : null;
}
