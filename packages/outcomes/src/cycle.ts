import { countClosedWithoutFinal, hasPaperActivity, latestCalibrationRun, finishJobRun, insertAttribution, insertInsight, latestAttributionForPosition, loadAttributionFacts, positionsNeedingAttribution, startJobRun, storeCalibrationRun, usersWithPaperActivity, type AttributionRow, type Db } from "@twins/database";
import { CONFIDENCE_MODEL_VERSION } from "@twins/confidence";
import { buildAttribution } from "./attribution";
import type { AnalyticsReport } from "./analytics";
import { runCalibration, type CalibrationOutcome } from "./calibration";
import type { OutcomeLearningConfig } from "./config";
import { generateInsights } from "./insights";
import { captureSnapshot, hashesOf, readSnapshotInputs, reportOf } from "./snapshot";

/**
 * The learning cycle (Stage 08 §9): ingest -> validate -> attribute -> aggregate -> analyse -> detect drift -> generate insights -> reconcile, as ONE bounded, leased, restartable job. It reads outcomes and writes ONLY outcome
 * attributions, insights, the shared calibration run log and its own run record. It imports nothing that can decide, size, approve, execute or change a limit, a weight, a strategy, a playbook or a permission, and a failure here can
 * never make a decision QUALIFIED or place an order. It needs no market feed: the analytics are computed from stored outcomes alone, from one consistent database snapshot, and stored as an immutable snapshot. Estimates for unexecuted decisions need price bars, which are not part of any stored input yet (G-32, Stage 10), so they report UNAVAILABLE.
 */
export const LEARNING_JOB = "learning-cycle";
/** `only` restricts the run to these users (staged roll-out and isolated tests); production leaves it unset. */
export interface LearningDeps { db: Db; config: OutcomeLearningConfig; only?: readonly string[]; now?: () => Date; log?: (event: string, fields: Record<string, unknown>) => void }
export interface LearningReport { skipped: "DISABLED" | "ALREADY_RUNNING" | null; runId: string | null; abandonedRuns: number; users: number; usersFailed: number; ingested: { final: number; partial: number; duplicates: number; unchanged: number }; insightsCreated: number; insightsExisting: number; reconciled: number; mismatches: number; calibration: { status: string; holdout: number } | null; snapshots: { created: number; existing: number }; closedWithoutFinal: number; failed: boolean }
export const emptyLearningReport = (): LearningReport => ({ skipped: null, runId: null, abandonedRuns: 0, users: 0, usersFailed: 0, ingested: { final: 0, partial: 0, duplicates: 0, unchanged: 0 }, insightsCreated: 0, insightsExisting: 0, reconciled: 0, mismatches: 0, calibration: null, snapshots: { created: 0, existing: 0 }, closedWithoutFinal: 0, failed: false });

export async function ingestOutcomes(db: Db, userId: string, batch: number): Promise<LearningReport["ingested"]> {
  const r = { final: 0, partial: 0, duplicates: 0, unchanged: 0 };
  for (const positionId of await positionsNeedingAttribution(db, userId, batch)) {
    const facts = await loadAttributionFacts(db, userId, positionId); if (!facts) continue;
    const prev = await latestAttributionForPosition(db, userId, positionId), next = buildAttribution(facts, prev);
    if (!next) { r.unchanged++; continue; }
    const id = await insertAttribution(db, userId, next);
    if (id === null) r.duplicates++; else if (next.finality === "FINAL") r.final++; else r.partial++;
  }
  return r;
}
/** Re-derives each FINAL attribution from the position and its recorded outcome; a difference is reported (as a data-quality finding), never silently repaired. */
export async function reconcileOutcomes(db: Db, userId: string, records: readonly AttributionRow[], batch: number): Promise<{ checked: number; mismatches: string[] }> {
  const mismatches: string[] = []; let checked = 0;
  for (const rec of records.filter((x) => x.finality === "FINAL").slice(-batch)) {
    const f = await loadAttributionFacts(db, userId, rec.paperPositionId); if (!f || !f.outcome) { mismatches.push(`${rec.id}: the position or its recorded outcome is gone`); continue; }
    checked++;
    if (f.outcome.pnl !== rec.netPnl && Number(f.outcome.pnl) !== Number(rec.netPnl)) mismatches.push(`${rec.id}: net P&L ${rec.netPnl} differs from the recorded outcome ${f.outcome.pnl}`);
  }
  return { checked, mismatches };
}
/** Analyses a user from ONE consistent database snapshot (the same read the stored snapshots use). Nothing is stored here. */
export async function analyzeUser(d: LearningDeps, userId: string, _now: Date): Promise<{ report: AnalyticsReport; records: AttributionRow[]; calibration: CalibrationOutcome; samples: AttributionRow[] }> {
  const inputs = await readSnapshotInputs(d.db, userId), h = hashesOf(inputs.fingerprint, inputs.pipeline, d.config);
  return { report: reportOf(inputs, d.config, h.asOf), records: inputs.records, calibration: runCalibration(inputs.records, d.config.holdoutFraction), samples: inputs.records };
}

export async function runLearningCycle(d: LearningDeps): Promise<LearningReport> {
  const out = emptyLearningReport();
  if (!d.config.enabled) return { ...out, skipped: "DISABLED" };
  const now = (d.now ?? (() => new Date()))();
  const run = await startJobRun(d.db, LEARNING_JOB, d.config.leaseMs, now);
  if (!run.started) return { ...out, skipped: "ALREADY_RUNNING" };
  out.runId = run.id; out.abandonedRuns = run.abandoned;
  const pooled: AttributionRow[] = [];
  try {
    const candidates = d.only ? [...d.only] : await usersWithPaperActivity(d.db, d.config.maxUsersPerRun), users: string[] = [];
    for (const u of candidates) if (await hasPaperActivity(d.db, u).catch(() => true)) users.push(u); // users with nothing to learn from cost one cheap query
    out.users = users.length;
    for (const userId of users) {
      try {
        const ing = await ingestOutcomes(d.db, userId, d.config.batchPositions);
        out.ingested.final += ing.final; out.ingested.partial += ing.partial; out.ingested.duplicates += ing.duplicates; out.ingested.unchanged += ing.unchanged;
        out.closedWithoutFinal += await countClosedWithoutFinal(d.db, userId);
        const cap = await captureSnapshot({ db: d.db, config: d.config, now: () => now, ...(d.log ? { log: d.log } : {}) }, userId, "LEARNING_CYCLE"), report = cap.view.report, records = cap.inputs.records; // ONE consistent read, stored as an immutable snapshot
        if (cap.created) out.snapshots.created++; else out.snapshots.existing++;
        pooled.push(...records);
        const rec = await reconcileOutcomes(d.db, userId, records, d.config.batchPositions); out.reconciled += rec.checked; out.mismatches += rec.mismatches.length;
        for (const i of generateInsights(report, records, d.config.minSample)) { if (await insertInsight(d.db, userId, i)) out.insightsCreated++; else out.insightsExisting++; }
        if (rec.mismatches.length) { const dq = generateInsights(report, records, d.config.minSample).find((x) => x.kind === "DATA_QUALITY"); if (dq) { const extra = { ...dq, insightKey: `${dq.insightKey}:recon:${rec.mismatches.length}`, subject: "reconciliation mismatch", severity: "WARNING" as const, statement: `Reconciliation found ${rec.mismatches.length} attribution(s) that no longer match their recorded outcome: ${rec.mismatches.slice(0, 5).join("; ")}. Nothing was changed; a correction needs a reasoned new version.`, metrics: { mismatches: rec.mismatches }, recommendation: "REVIEW" as const }; if (await insertInsight(d.db, userId, extra)) out.insightsCreated++; } }
      } catch (e) { out.usersFailed++; d.log?.("learning.user_failed", { errorName: e instanceof Error ? e.name : "Error" }); }
    }
    // calibration is pooled over all users' own records as anonymous (score, win, time) samples; only the aggregate run is stored, and only when it changed
    const cal = runCalibration(pooled, d.config.holdoutFraction), last = await latestCalibrationRun(d.db, CONFIDENCE_MODEL_VERSION);
    out.calibration = { status: cal.status, holdout: cal.holdoutSize };
    if (!last || last.status !== cal.run.status || last.sampleSize !== cal.run.sampleSize) await storeCalibrationRun(d.db, { modelVersion: CONFIDENCE_MODEL_VERSION, sampleSize: cal.run.sampleSize, outOfSample: cal.run.outOfSample, bins: cal.run.bins, brierScore: cal.run.brierScore, status: cal.run.status });
    await finishJobRun(d.db, run.id, "COMPLETED", out, null, (d.now ?? (() => new Date()))());
  } catch (e) {
    out.failed = true; const kind = e instanceof Error ? e.name : "Error";
    await finishJobRun(d.db, run.id, "FAILED", out, kind, new Date()).catch(() => undefined);
    d.log?.("learning.cycle_failed", { errorName: kind });
  }
  return out;
}
