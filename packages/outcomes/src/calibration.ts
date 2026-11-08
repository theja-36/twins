import { CONFIDENCE_MODEL_VERSION, evaluateCalibration, type CalibrationRun, type Sample } from "@twins/confidence";
import type { AttributionRow } from "@twins/database";
import { classOf, isEligible } from "./metrics";

/**
 * Calibration evidence (M15-06). Builds the samples the Stage 06 calibration procedure needs and runs it UNCHANGED: confidence stays UNCALIBRATED / CALIBRATING until at least 200 valid OUT-OF-SAMPLE outcomes exist (that
 * floor lives in @twins/confidence and is not configurable), the win rate must rise with the score across populated score groups, and only then could a probability be read from a score. A raw strength score is never a probability.
 * Validity rules: FINAL records only; fixture-backed records are excluded (never mixed into a supposedly validated set); a record needs a confidence score recorded BEFORE the position opened (look-ahead is excluded and counted);
 * records with an outcome mismatch are excluded. Samples are ordered by closing time; the most recent fraction is the held-out (out-of-sample) set, the earlier part the fit set used only for a stability check.
 */
export const CALIBRATION_PIPELINE_VERSION = "calibration-pipeline-v1";
export interface CalibrationDataset { fit: Sample[]; holdout: Sample[]; excluded: Record<string, number> }
export function buildCalibrationDataset(records: readonly AttributionRow[], holdoutFraction: number, mode: "PAPER" | "LIVE" = "PAPER"): CalibrationDataset {
  const excluded: Record<string, number> = {}, ex = (k: string): void => { excluded[k] = (excluded[k] ?? 0) + 1; };
  const ok: AttributionRow[] = [];
  for (const r of records) {
    if (r.mode !== mode) continue;
    if (!isEligible(r)) { ex("NOT_FINAL"); continue; }
    if (r.dataSource === "FIXTURE") { ex("FIXTURE_DATA"); continue; }
    if (r.confidenceScore === null || r.confidenceAt === null) { ex("NO_CONFIDENCE_SCORE"); continue; }
    if (r.confidenceAt.getTime() > r.openedAt.getTime() || r.dataQuality.includes("CONFIDENCE_RECORDED_AFTER_OPEN")) { ex("LOOKAHEAD"); continue; }
    if (r.dataQuality.includes("OUTCOME_PNL_MISMATCH")) { ex("OUTCOME_MISMATCH"); continue; }
    ok.push(r);
  }
  ok.sort((a, b) => (a.closedAt as Date).getTime() - (b.closedAt as Date).getTime() || (a.id < b.id ? -1 : 1));
  const cut = Math.floor(ok.length * (1 - holdoutFraction));
  const mk = (r: AttributionRow, oos: boolean): Sample => ({ score: r.confidenceScore as number, won: classOf(r) === "WIN", r: r.rMultiple === null ? null : Number(r.rMultiple), outOfSample: oos, at: (r.closedAt as Date).toISOString() });
  return { fit: ok.slice(0, cut).map((r) => mk(r, false)), holdout: ok.slice(cut).map((r) => mk(r, true)), excluded };
}
export interface CalibrationOutcome { pipelineVersion: string; run: CalibrationRun; fitSize: number; holdoutSize: number; excluded: Record<string, number>; stability: { comparedBands: number; unstableBands: string[] }; status: CalibrationRun["status"]; reasons: string[] }
export function runCalibration(records: readonly AttributionRow[], holdoutFraction: number, mode: "PAPER" | "LIVE" = "PAPER"): CalibrationOutcome {
  const ds = buildCalibrationDataset(records, holdoutFraction, mode);
  const run = evaluateCalibration([...ds.fit, ...ds.holdout], undefined, CONFIDENCE_MODEL_VERSION); // the Stage 06 procedure, with its own thresholds
  // stability: the held-out win rate per score band must agree with the earlier (fit) period; a band that moved by more than 15 points is unstable
  const band = (s: Sample): number => Math.min(4, Math.floor(s.score / 20)), rate = (xs: Sample[]): { n: number; w: number }[] => Array.from({ length: 5 }, (_, b) => { const g = xs.filter((s) => band(s) === b); return { n: g.length, w: g.filter((s) => s.won).length }; });
  const a = rate(ds.fit), h = rate(ds.holdout), unstable: string[] = []; let compared = 0;
  for (let b = 0; b < 5; b++) if ((a[b] as { n: number }).n >= 20 && (h[b] as { n: number }).n >= 20) { compared++; if (Math.abs((a[b] as { w: number; n: number }).w / (a[b] as { n: number }).n - (h[b] as { w: number; n: number }).w / (h[b] as { n: number }).n) > 0.15) unstable.push(`${b * 20}-${b * 20 + 20}`); }
  const reasons = [...run.reasons];
  let status = run.status;
  if (status === "CALIBRATED" && unstable.length) { status = "CALIBRATING"; reasons.push(`win rate moved by more than 15 points between the fit and held-out periods in score bands ${unstable.join(", ")}`); }
  if (ds.fit.length + ds.holdout.length === 0) reasons.push("no valid, non-fixture outcome with a prior confidence score exists");
  return { pipelineVersion: CALIBRATION_PIPELINE_VERSION, run: { ...run, status }, fitSize: ds.fit.length, holdoutSize: ds.holdout.length, excluded: ds.excluded, stability: { comparedBands: compared, unstableBands: unstable }, status, reasons };
}
