import { createHash } from "node:crypto";
import { CONFIDENCE_MODEL_VERSION } from "@twins/confidence";
import { makeTransactionReadOnly, withUser, candidateFunnelCounts, claimFunnelCounts, evidenceFingerprint, findSnapshotByEvidence, insertSnapshot, latestAttributions, latestSnapshot, listDecisionRows, researchReportsForDecisions, type AttributionRow, type Db, type EvidenceFingerprint, type SnapshotRow } from "@twins/database";
import { ATTRIBUTION_VERSION } from "./attribution";
import { AGENT_ANALYTICS_VERSION } from "./agents";
import { ANALYTICS_REPORT_VERSION, buildAnalyticsReport, type AnalyticsReport } from "./analytics";
import { CALIBRATION_PIPELINE_VERSION, runCalibration } from "./calibration";
import { analysisSettingsOf, OUTCOME_LEARNING_VERSION, type OutcomeLearningConfig } from "./config";
import { DECISION_QUALITY_VERSION } from "./decisionQuality";
import { DRIFT_MONITOR_VERSION } from "./drift";
import { FUNNEL_VERSION } from "./funnel";
import { INSIGHT_ENGINE_VERSION } from "./insights";
import { METRICS_VERSION } from "./metrics";

/**
 * Reproducible analytics snapshots (Stage 08 A2). Every input of the analytics is read inside ONE read-only REPEATABLE READ transaction, so the attributions, decisions, research packages, positions and pipeline counts it uses all describe the same
 * instant of the database. From those inputs alone (never the wall clock, never an external feed) a report is derived deterministically, and stored with the hashes that identify exactly what it was built from:
 *   evidence_hash  the user's evidence + the analysis settings + the algorithm versions        -> "is this snapshot still current for this user?"
 *   input_hash     the evidence hash + the platform-level pipeline counts                      -> one row per distinct set of inputs (concurrent identical requests converge on it)
 * A snapshot is never edited; a later state of the evidence is a new snapshot. The report's "as of" instant is the newest record of the evidence, so the same evidence always reproduces the same report, byte for byte.
 */
export const ANALYTICS_SNAPSHOT_VERSION = "analytics-snapshot-v1";
/** Stable JSON: object keys sorted, undefined dropped; the same value always renders to the same text. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return typeof x === "number" && !Number.isFinite(x) ? null : x;
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(norm);
    const o: Record<string, unknown> = {}; for (const k of Object.keys(x as object).sort()) { const val = (x as Record<string, unknown>)[k]; if (val !== undefined) o[k] = norm(val); }
    return o;
  };
  return JSON.stringify(norm(v));
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export function algorithmVersions(): Record<string, string> {
  return { snapshot: ANALYTICS_SNAPSHOT_VERSION, learning: OUTCOME_LEARNING_VERSION, report: ANALYTICS_REPORT_VERSION, metrics: METRICS_VERSION, attribution: ATTRIBUTION_VERSION, calibrationPipeline: CALIBRATION_PIPELINE_VERSION, confidenceModel: CONFIDENCE_MODEL_VERSION, drift: DRIFT_MONITOR_VERSION, agents: AGENT_ANALYTICS_VERSION, decisionQuality: DECISION_QUALITY_VERSION, funnel: FUNNEL_VERSION, insights: INSIGHT_ENGINE_VERSION };
}
/** Upper bound of rows read per source; reaching it is recorded in the snapshot (`complete: false`), never hidden. */
export const SNAPSHOT_ROW_LIMIT = 5000;
type Pipeline = { claims: Awaited<ReturnType<typeof claimFunnelCounts>>; telegram: Awaited<ReturnType<typeof candidateFunnelCounts>>; independent: Awaited<ReturnType<typeof candidateFunnelCounts>> };
export interface SnapshotInputs { records: AttributionRow[]; decisions: Awaited<ReturnType<typeof listDecisionRows>>; packages: Awaited<ReturnType<typeof researchReportsForDecisions>>; pipeline: Pipeline; fingerprint: EvidenceFingerprint; complete: boolean }
export interface SnapshotHashes { evidenceHash: string; inputHash: string; configHash: string; asOf: Date }
const asDb = (tx: unknown): Db => tx as Db;
/** Runs `fn` against ONE consistent, read-only database snapshot for `userId`. The user is bound first (a bind writes the identity row, which a read-only transaction cannot do), then the transaction is made READ ONLY before any data is read; REPEATABLE READ takes its snapshot at the bind statement. */
async function consistently<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withUser(db, userId, async (tx) => { await makeTransactionReadOnly(tx); return fn(asDb(tx)); }, { isolationLevel: "repeatable read" });
}
async function readPipeline(tx: Db): Promise<Pipeline> { return { claims: await claimFunnelCounts(tx), telegram: await candidateFunnelCounts(tx, "TELEGRAM"), independent: await candidateFunnelCounts(tx, "INDEPENDENT") }; }
export function hashesOf(fp: EvidenceFingerprint, pipeline: Pipeline, config: OutcomeLearningConfig): SnapshotHashes {
  const settings = analysisSettingsOf(config), configHash = sha256(canonicalJson({ settings, versions: algorithmVersions() }));
  const evidenceHash = sha256(canonicalJson({ evidence: fp, configHash }));
  const micros = Math.max(Number(fp.attributions.newestMicros || 0), Number(fp.decisions.newestMicros || 0));
  return { evidenceHash, inputHash: sha256(canonicalJson({ evidenceHash, pipeline })), configHash, asOf: new Date(Math.floor(micros / 1000)) };
}
/** Reads every input inside one consistent snapshot. */
export async function readSnapshotInputs(db: Db, userId: string): Promise<SnapshotInputs> {
  return consistently(db, userId, async (tx) => {
    const fingerprint = await evidenceFingerprint(tx, userId);
    const records = await latestAttributions(tx, userId, { mode: "PAPER", limit: SNAPSHOT_ROW_LIMIT }), decisions = await listDecisionRows(tx, userId, SNAPSHOT_ROW_LIMIT), packages = await researchReportsForDecisions(tx, userId, SNAPSHOT_ROW_LIMIT);
    return { records, decisions, packages, pipeline: await readPipeline(tx), fingerprint, complete: decisions.length < SNAPSHOT_ROW_LIMIT && packages.length < SNAPSHOT_ROW_LIMIT && fingerprint.attributions.count <= SNAPSHOT_ROW_LIMIT * 4 };
  });
}
/** The cheap check: the hashes of the CURRENT state, without loading any rows. */
export async function currentHashes(db: Db, userId: string, config: OutcomeLearningConfig): Promise<SnapshotHashes> {
  return consistently(db, userId, async (tx) => hashesOf(await evidenceFingerprint(tx, userId), await readPipeline(tx), config));
}
/** PURE: the report derived from the inputs. Deterministic: depends on nothing but the inputs, the settings and `asOf`. */
export function reportOf(i: SnapshotInputs, config: OutcomeLearningConfig, asOf: Date): AnalyticsReport {
  const s = analysisSettingsOf(config), tg = i.pipeline.telegram, ind = i.pipeline.independent;
  const raw = buildAnalyticsReport({ now: asOf, minSample: s.minSample, minDriftWindow: s.minDriftWindow, records: i.records, decisions: i.decisions, packages: i.packages, claimChannels: i.pipeline.claims, telegramCandidates: tg.candidates,
    independentStage: { candidates: ind.scanCandidates || ind.candidates, researched: ind.researched, byState: ind.byState, stateReasons: ind.stateReasons, scans: ind.scans }, hypothetical: new Map(), calibration: runCalibration(i.records, s.holdoutFraction) });
  return JSON.parse(canonicalJson(raw)) as AnalyticsReport; // exactly what storage would return, so a fresh build and a stored snapshot are identical
}
export interface SnapshotMeta { id: string; asOf: string; createdAt: string; verifiedAt: string; evidenceHash: string; inputHash: string; configHash: string; algorithmVersions: unknown; createdBy: string; freshness: "CURRENT" | "STALE"; staleReason: string | null; complete: boolean; maxAgeSeconds: number }
export interface AnalyticsView { report: AnalyticsReport; snapshot: SnapshotMeta }
export interface SnapshotDeps { db: Db; config: OutcomeLearningConfig; now?: () => Date; log?: (event: string, fields: Record<string, unknown>) => void }
const metaOf = (r: SnapshotRow, now: Date, freshness: "CURRENT" | "STALE", staleReason: string | null, maxAge: number): SnapshotMeta => ({ id: r.id, asOf: r.asOf.toISOString(), createdAt: r.createdAt.toISOString(), verifiedAt: now.toISOString(), evidenceHash: r.evidenceHash, inputHash: r.inputHash, configHash: r.configHash, algorithmVersions: r.algorithmVersions, createdBy: r.createdBy, freshness, staleReason, complete: (r.watermarks as { complete?: boolean } | null)?.complete !== false, maxAgeSeconds: maxAge });
/** Builds (from one consistent read) and stores the snapshot of the user's current evidence. Idempotent: identical inputs give the existing row. */
export async function captureSnapshot(d: SnapshotDeps, userId: string, createdBy: "API" | "LEARNING_CYCLE" | "OPERATOR"): Promise<{ view: AnalyticsView; inputs: SnapshotInputs; created: boolean }> {
  const now = (d.now ?? (() => new Date()))(), inputs = await readSnapshotInputs(d.db, userId), h = hashesOf(inputs.fingerprint, inputs.pipeline, d.config), report = reportOf(inputs, d.config, h.asOf);
  const stored = await insertSnapshot(d.db, userId, { mode: "PAPER", asOf: h.asOf, evidenceHash: h.evidenceHash, inputHash: h.inputHash, algorithmVersions: algorithmVersions(), config: analysisSettingsOf(d.config), configHash: h.configHash, watermarks: { evidence: inputs.fingerprint, pipeline: inputs.pipeline, rows: { attributions: inputs.records.length, decisions: inputs.decisions.length, packages: inputs.packages.length, limit: SNAPSHOT_ROW_LIMIT }, complete: inputs.complete }, report, reportSha256: sha256(canonicalJson(report)), createdBy });
  return { view: { report: stored.snapshot.report as AnalyticsReport, snapshot: metaOf(stored.snapshot, now, "CURRENT", null, d.config.snapshotMaxAgeSeconds) }, inputs, created: stored.created };
}
/**
 * The analytics the API serves: the stored snapshot for the user's CURRENT evidence. A snapshot is current when it was built from the same evidence, settings and algorithm versions and is not older than the configured age (the pipeline counts it
 * also reports are platform-level and age independently). Otherwise it is rebuilt first. If the rebuild itself fails, the newest stored snapshot is returned marked STALE with the reason, never as current; with none, the error propagates.
 */
export async function currentAnalytics(d: SnapshotDeps, userId: string, createdBy: "API" | "LEARNING_CYCLE" | "OPERATOR" = "API"): Promise<AnalyticsView & { created: boolean }> {
  const now = (d.now ?? (() => new Date()))(), maxMs = d.config.snapshotMaxAgeSeconds * 1000;
  try {
    const h = await currentHashes(d.db, userId, d.config), hit = await findSnapshotByEvidence(d.db, userId, h.evidenceHash);
    if (hit && (hit.inputHash === h.inputHash || now.getTime() - hit.createdAt.getTime() <= maxMs)) return { report: hit.report as AnalyticsReport, snapshot: metaOf(hit, now, "CURRENT", null, d.config.snapshotMaxAgeSeconds), created: false };
    const c = await captureSnapshot(d, userId, createdBy);
    return { ...c.view, created: c.created };
  } catch (e) {
    const last = await latestSnapshot(d.db, userId).catch(() => null);
    d.log?.("analytics.snapshot_unavailable", { errorName: e instanceof Error ? e.name : "Error", haveStale: !!last });
    if (!last) throw e;
    return { report: last.report as AnalyticsReport, snapshot: metaOf(last, now, "STALE", "the current evidence could not be analysed; this is the newest stored snapshot", d.config.snapshotMaxAgeSeconds), created: false };
  }
}
