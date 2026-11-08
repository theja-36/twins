/**
 * Outcome-learning settings (Stage 08). DISABLED by default; strict parsing (a malformed value throws at start-up). The minimum sample sizes are statistical-integrity floors, not tuning knobs: they cannot be set below their
 * floor, and the 200 out-of-sample minimum for calibration is the Stage 06 requirement and is NOT configurable here at all.
 */
export const OUTCOME_LEARNING_VERSION = "outcome-learning-v1";
export interface OutcomeLearningConfig { enabled: boolean; intervalMs: number; leaseMs: number; batchPositions: number; minSample: number; minDriftWindow: number; holdoutFraction: number; maxUsersPerRun: number }
export const MIN_SAMPLE_FLOOR = 30;
export const DEFAULT_OUTCOME_LEARNING: OutcomeLearningConfig = { enabled: false, intervalMs: 300_000, leaseMs: 600_000, batchPositions: 200, minSample: MIN_SAMPLE_FLOOR, minDriftWindow: MIN_SAMPLE_FLOOR, holdoutFraction: 0.4, maxUsersPerRun: 200 };
export function loadOutcomeLearningConfig(env: Record<string, string | undefined> = process.env): OutcomeLearningConfig {
  const d = DEFAULT_OUTCOME_LEARNING;
  const b = env["TWINS_LEARNING_ENABLED"];
  if (b !== undefined && b !== "" && b !== "true" && b !== "false") throw new Error('TWINS_LEARNING_ENABLED must be exactly "true" or "false"');
  const num = (n: string, def: number, lo: number, hi: number, int: boolean): number => { const v = env[n]; if (v === undefined || v === "") return def; const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi || (int && !Number.isInteger(x))) throw new Error(`${n} must be ${int ? "an integer" : "a number"} between ${lo} and ${hi}`); return x; };
  return { enabled: b === "true", intervalMs: num("TWINS_LEARNING_INTERVAL_MS", d.intervalMs, 10_000, 86_400_000, true), leaseMs: num("TWINS_LEARNING_LEASE_MS", d.leaseMs, 30_000, 3_600_000, true), batchPositions: num("TWINS_LEARNING_BATCH", d.batchPositions, 1, 500, true),
    minSample: num("TWINS_LEARNING_MIN_SAMPLE", d.minSample, MIN_SAMPLE_FLOOR, 10_000, true), minDriftWindow: num("TWINS_LEARNING_MIN_DRIFT_WINDOW", d.minDriftWindow, MIN_SAMPLE_FLOOR, 10_000, true), holdoutFraction: num("TWINS_LEARNING_HOLDOUT_FRACTION", d.holdoutFraction, 0.2, 0.6, false), maxUsersPerRun: num("TWINS_LEARNING_MAX_USERS", d.maxUsersPerRun, 1, 1000, true) };
}
