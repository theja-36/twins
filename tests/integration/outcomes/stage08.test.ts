/**
 * Stage 08 against REAL PostgreSQL (migration 0039 and the outcome-learning path): attribution of closed paper positions, partial / final / corrected versions, append-only records, owner isolation, the leased learning job,
 * idempotent insights and the calibration log. Fixture providers only, so every outcome here is FIXTURE-backed and the tests also prove that nothing built on it is reported as validated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { attributionHistory, finishJobRun, insertAttribution, insertInsight, latestAttributionForPosition, latestAttributions, latestCalibrationRun, listInsights, listJobRuns, loadAttributionFacts, getPositionForDecision, startJobRun, type NewAttribution } from "../../../packages/database/src/index";
import { DEFAULT_OUTCOME_LEARNING, LEARNING_JOB, buildAttribution, buildCorrection, ingestOutcomes, runLearningCycle, analyzeUser } from "../../../packages/outcomes/src/index";
import { storeResearchPackage, researchReportsForDecisions } from "../../../packages/database/src/index";
import { closeClients, db, finish, getDecision, newUser, owner, pipeline, session, trade } from "../support/tradingPipeline";

afterAll(async () => { await closeClients(); });
const cfg = { ...DEFAULT_OUTCOME_LEARNING, enabled: true };
const CONF = "confidence-strength-v1";
/** The store reports database errors through drizzle's "Failed query" wrapper; the database's own message is on the cause. */
async function dbError(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  const m = `${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`;
  expect(m).toMatch(re);
}

describe("outcome attribution", () => {
  it("a closed paper position is attributed once, FINAL, with its provenance, costs, holding time and behaviour; ingestion is idempotent", async () => {
    const p = await pipeline(); await trade(p, "close");
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!; expect(pos.status).toBe("CLOSED");
    const first = await ingestOutcomes(db, p.userId, 50);
    expect(first.final).toBeGreaterThanOrEqual(1);
    const again = await ingestOutcomes(db, p.userId, 50);
    expect(again.final + again.partial).toBe(0);
    const hist = await attributionHistory(db, p.userId, pos.id); expect(hist.map((h) => `${h.version}:${h.finality}`)).toEqual(["1:FINAL"]);
    const a = hist[0]!;
    expect(a).toMatchObject({ mode: "PAPER", dataSource: "FIXTURE", candidateSource: "INDEPENDENT", setup: "BREAKOUT", detectorVersion: "opportunity-setups-v1", timeframeSeconds: 900, instrument: p.u, exitReason: "STOP_HIT", decisionId: p.decisionId, candidateId: p.candId });
    expect(a.outcomeId).not.toBeNull(); expect(a.closedAt).not.toBeNull(); expect(a.holdingSeconds).not.toBeNull(); expect(a.dataQuality).toContain("FIXTURE_PRICES");
    expect(a.missing).toEqual(expect.arrayContaining(["mae_mfe", "slippage_reference_price"])); expect(Number(a.costs)).toBeGreaterThan(0);
    expect(Number(a.grossPnl) - Number(a.costs)).toBeCloseTo(Number(a.netPnl), 1); expect(a.trade).toMatchObject({ stopHit: true });
    const raw = await owner();
    const { rows } = await raw.query("select o.pnl, o.mode, a.net_pnl from trade_outcomes o join outcome_attributions a on a.outcome_id = o.id where a.paper_position_id = $1", [pos.id]);
    expect(rows).toHaveLength(1); expect(rows[0].mode).toBe("PAPER"); expect(Number(rows[0].pnl)).toBeCloseTo(Number(rows[0].net_pnl), 2);
  });
  it("an open position with a partial exit is PARTIAL (never final); closing it adds a FINAL version that names it; only the latest counts", async () => {
    const p = await pipeline(); await trade(p, "partial");
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!; expect(pos.status).toBe("OPEN");
    await ingestOutcomes(db, p.userId, 50);
    let latest = (await latestAttributionForPosition(db, p.userId, pos.id))!;
    expect(latest).toMatchObject({ version: 1, finality: "PARTIAL", outcomeId: null, exitPrice: null, rMultiple: null, closedAt: null });
    expect((await latestAttributions(db, p.userId, { finality: "FINAL", limit: 100 })).some((r) => r.paperPositionId === pos.id)).toBe(false);
    await finish();
    await ingestOutcomes(db, p.userId, 50);
    const hist = await attributionHistory(db, p.userId, pos.id);
    expect(hist.map((h) => `${h.version}:${h.finality}`)).toEqual(["1:PARTIAL", "2:FINAL"]); expect(hist[1]).toMatchObject({ supersedesId: hist[0]!.id }); expect(hist[1]!.correctionReason).toMatch(/position closed/);
    latest = (await latestAttributionForPosition(db, p.userId, pos.id))!; expect(latest.finality).toBe("FINAL");
    expect((await latestAttributions(db, p.userId, { limit: 100 })).filter((r) => r.paperPositionId === pos.id)).toHaveLength(1);
  });
  it("records are append-only and a correction is a reasoned new version; the database refuses edits, re-pointing, FINAL -> PARTIAL, gaps and duplicates", async () => {
    const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50);
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!, v1 = (await latestAttributionForPosition(db, p.userId, pos.id))!, raw = await owner();
    await expect(raw.query("update outcome_attributions set net_pnl = 1 where id = $1", [v1.id])).rejects.toThrow(/append-only/);
    await expect(raw.query("delete from outcome_attributions where id = $1", [v1.id])).rejects.toThrow(/append-only/);
    await expect(raw.query("truncate outcome_attributions")).rejects.toThrow(/append-only/);
    const facts = (await loadAttributionFacts(db, p.userId, pos.id))!;
    expect(buildAttribution(facts, v1)).toBeNull();                                      // a FINAL record is never silently rewritten
    const fixed = buildCorrection({ ...facts, position: { ...facts.position, realizedCosts: String(Number(facts.position.realizedCosts) + 5) } }, v1, "the fee schedule used for this paper trade was corrected")!;
    expect(fixed).toMatchObject({ version: 2, supersedesId: v1.id, finality: "FINAL" });
    expect(await insertAttribution(db, p.userId, fixed)).not.toBeNull();
    expect(await insertAttribution(db, p.userId, fixed)).toBeNull();                       // idempotent: the same version again inserts nothing
    const hist = await attributionHistory(db, p.userId, pos.id); expect(hist.map((h) => h.version)).toEqual([1, 2]); expect((await latestAttributionForPosition(db, p.userId, pos.id))!.version).toBe(2);
    const next = (over: Partial<NewAttribution>): NewAttribution => ({ ...fixed, version: 3, supersedesId: hist[1]!.id, correctionReason: "correction: another reasoned change", ...over });
    await dbError(() => insertAttribution(db, p.userId, next({ finality: "PARTIAL", outcomeId: null, closedAt: null, exitPrice: null, rMultiple: null, holdingSeconds: null, exitReason: null })), /FINAL outcome cannot be replaced|final_check/);
    await dbError(() => insertAttribution(db, p.userId, next({ version: 5, supersedesId: hist[1]!.id })), /must follow and name the previous version/);
    await dbError(() => insertAttribution(db, p.userId, next({ supersedesId: hist[0]!.id })), /must follow and name the previous version/);
    await dbError(() => insertAttribution(db, p.userId, next({ instrument: "OTHER" })), /cannot change which position/);
    await dbError(() => insertAttribution(db, p.userId, next({ correctionReason: "short" })), /version_check/);
    await expect(raw.query("insert into outcome_attributions (id, user_id, account_id, paper_position_id, decision_id, candidate_id, version, finality, mode, data_source, candidate_source, instrument, side, quantity, entry_price, decided_at, opened_at) select gen_random_uuid(), user_id, account_id, paper_position_id, decision_id, candidate_id, 1, 'PARTIAL', mode, data_source, candidate_source, instrument, side, quantity, entry_price, decided_at, opened_at from outcome_attributions where id = $1", [v1.id])).rejects.toThrow(/already has an attribution|position_version_unique/);
    await expect(raw.query("insert into outcome_attributions (id, user_id, account_id, paper_position_id, decision_id, candidate_id, version, finality, mode, data_source, candidate_source, instrument, side, quantity, entry_price, decided_at, opened_at) select gen_random_uuid(), user_id, account_id, paper_position_id, decision_id, candidate_id, 2, 'PARTIAL', 'LIVE', data_source, candidate_source, instrument, side, quantity, entry_price, decided_at, opened_at from outcome_attributions where id = $1", [v1.id])).rejects.toThrow();
  });
  it("paper only: a LIVE attribution is impossible while no live execution exists, and FINAL needs the recorded outcome", async () => {
    const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50);
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!, v1 = (await latestAttributionForPosition(db, p.userId, pos.id))!;
    await dbError(() => insertAttribution(db, p.userId, { ...v1, version: 2, supersedesId: v1.id, correctionReason: "correction: pretend this was live", mode: "LIVE" }), /paper_only_check|mode_check|cannot change which position/);
    await dbError(() => insertAttribution(db, p.userId, { ...v1, version: 2, supersedesId: v1.id, correctionReason: "correction: remove the recorded outcome", outcomeId: null }), /final_check/);
    await dbError(() => insertAttribution(db, p.userId, { ...v1, version: 2, supersedesId: v1.id, correctionReason: "correction: a final result with no exit", exitPrice: null }), /final_check/);
  });
});

describe("isolation", () => {
  it("another user cannot see attributions or insights, and cannot attribute another user's position", async () => {
    const a = await pipeline(), b = await newUser(); await trade(a, "close"); await ingestOutcomes(db, a.userId, 50);
    const pos = (await getPositionForDecision(db, a.userId, a.decisionId))!, v1 = (await latestAttributionForPosition(db, a.userId, pos.id))!;
    const i = await insertInsight(db, a.userId, { insightKey: randomUUID(), kind: "PERFORMANCE", scope: "S", subject: "x", outcomeCount: 0, periodStart: null, periodEnd: null, provenance: {}, method: "m", algorithmVersion: "v", evidenceRefs: {}, reliability: "INSUFFICIENT_DATA", severity: "INFO", statement: "s", metrics: {}, limitations: ["l"], recommendation: null });
    expect(i).not.toBeNull();
    const sb = await session(b.userId);
    expect((await sb.query("select 1 from outcome_attributions where user_id = $1", [a.userId])).rows).toEqual([]);
    expect((await sb.query("select 1 from learning_insights where user_id = $1", [a.userId])).rows).toEqual([]);
    await dbError(() => insertAttribution(db, b.userId, { ...v1, userId: b.userId, accountId: b.accountId, version: 1, supersedesId: null, correctionReason: null }), /./);
    expect(await latestAttributions(db, b.userId, { limit: 50 })).toEqual([]);
    expect(await listInsights(db, b.userId, { limit: 50 })).toEqual([]);
  });
});

describe("insights are append-only, idempotent and bounded in vocabulary", () => {
  it("the database refuses a recommendation other than REVIEW, an ADEQUATE finding on a tiny sample, and any edit", async () => {
    const u = await newUser(), raw = await owner();
    const ins = (o: Record<string, unknown>) => raw.query("insert into learning_insights (id, user_id, insight_key, kind, scope, subject, outcome_count, provenance, method, algorithm_version, evidence_refs, reliability, severity, statement, metrics, limitations, recommendation) values (gen_random_uuid(), $1, $2, 'DRIFT', 's', 'x', $3, '{}', 'm', 'v', '{}', $4, 'INFO', 's', '{}', '[]', $5)", [u.userId, randomUUID(), o["n"] ?? 0, o["rel"] ?? "LOW", o["rec"] ?? null]);
    await ins({}); await ins({ rec: "REVIEW" });
    for (const rec of ["INCREASE_SIZE", "APPROVE", "ACTIVATE_STRATEGY", "DISABLE"]) await expect(ins({ rec }), rec).rejects.toThrow(/recommendation_check/);
    await expect(ins({ rel: "ADEQUATE", n: 5 })).rejects.toThrow(/adequate_check/); await ins({ rel: "ADEQUATE", n: 30 });
    await expect(raw.query("update learning_insights set statement = 'edited' where user_id = $1", [u.userId])).rejects.toThrow(/append-only/);
    const k = randomUUID(), base = { kind: "PERFORMANCE", scope: "S", subject: "x", outcomeCount: 0, periodStart: null, periodEnd: null, provenance: {}, method: "m", algorithmVersion: "v", evidenceRefs: {}, reliability: "INSUFFICIENT_DATA", severity: "INFO", statement: "s", metrics: {}, limitations: ["l"], recommendation: null } as const;
    expect(await insertInsight(db, u.userId, { ...base, insightKey: k })).not.toBeNull(); expect(await insertInsight(db, u.userId, { ...base, insightKey: k })).toBeNull();
  });
});

describe("the learning cycle", () => {
  it("is off by default; when on it ingests, analyses and writes insights once, and a re-run changes nothing", async () => {
    expect((await runLearningCycle({ db, config: DEFAULT_OUTCOME_LEARNING })).skipped).toBe("DISABLED");
    const p = await pipeline(); await trade(p, "close");
    const r1 = await runLearningCycle({ db, config: cfg, only: [p.userId] });
    expect(r1).toMatchObject({ skipped: null, failed: false }); expect(r1.runId).not.toBeNull(); expect(r1.ingested.final).toBeGreaterThanOrEqual(1); expect(r1.insightsCreated).toBeGreaterThan(0); expect(r1.mismatches).toBe(0);
    const r2 = await runLearningCycle({ db, config: cfg, only: [p.userId] });
    expect(r2.ingested.final + r2.ingested.partial).toBe(0); expect(r2.insightsCreated).toBe(0); expect(r2.insightsExisting).toBeGreaterThan(0);
    const runs = await listJobRuns(db, LEARNING_JOB, 5); expect(runs.slice(0, 2).map((r) => r.status)).toEqual(["COMPLETED", "COMPLETED"]);
    // everything is fixture-backed: nothing is called validated, and calibration stays uncalibrated
    const ins = await listInsights(db, p.userId, { limit: 200 });
    expect(r1.usersFailed, `user failures: ${JSON.stringify(r1)}`).toBe(0);
    const perf = ins.find((i) => i.kind === "PERFORMANCE" && i.subject === "all paper outcomes")!; expect(perf, `insights present: ${ins.map((i) => `${i.kind}|${i.subject}`).join(" ; ")}`).toBeDefined(); expect(perf.reliability).toMatch(/NOT_VALIDATED_FIXTURE|INSUFFICIENT_DATA/); expect((perf.provenance as { fixtureBacked: boolean }).fixtureBacked).toBe(true);
    expect(ins.find((i) => i.kind === "DATA_QUALITY")!.severity).toBe("WARNING");
    expect(ins.every((i) => i.recommendation === null || i.recommendation === "REVIEW")).toBe(true); expect(ins.some((i) => i.reliability === "ADEQUATE")).toBe(false);
    const cal = ins.find((i) => i.kind === "CALIBRATION")!; expect(["NOT_CALIBRATED", "UNAVAILABLE"]).toContain(cal.reliability);
    const run = await latestCalibrationRun(db, CONF); expect(run).not.toBeNull(); expect(run!.status).not.toBe("CALIBRATED");
  });
  it("insights reproduce from stored outcomes: re-analysing the same records gives the same insight keys", async () => {
    const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50);
    const x = await analyzeUser({ db, config: cfg }, p.userId, new Date("2031-01-06T06:00:00Z")), y = await analyzeUser({ db, config: cfg }, p.userId, new Date("2031-01-06T06:00:00Z"));
    const { generateInsights } = await import("../../../packages/outcomes/src/index");
    expect(generateInsights(x.report, x.records, 30).map((i) => i.insightKey)).toEqual(generateInsights(y.report, y.records, 30).map((i) => i.insightKey));
    expect(x.report.modes.LIVE).toMatchObject({ status: "UNAVAILABLE" }); expect(x.report.modes.PAPER.validatedOnly.eligible).toBe(0); expect(x.report.modes.PAPER.fixtureOnly.eligible).toBeGreaterThan(0);
  });
  it("jobs are single-flight and recoverable: a concurrent start is refused; a lapsed run is marked ABANDONED; a finished run is final", async () => {
    const job = `test-job-${randomUUID().slice(0, 8)}`, now = new Date();
    const first = await startJobRun(db, job, 60_000, now); expect(first.started).toBe(true);
    expect(await startJobRun(db, job, 60_000, now)).toEqual({ started: false, reason: "ALREADY_RUNNING" });
    const later = await startJobRun(db, job, 60_000, new Date(now.getTime() + 120_000)); expect(later).toMatchObject({ started: true, abandoned: 1 });
    const runs = await listJobRuns(db, job, 5); expect(runs.map((r) => r.status).sort()).toEqual(["ABANDONED", "RUNNING"]);
    if (later.started) await finishJobRun(db, later.id, "FAILED", { x: 1 }, "TestError", new Date());
    const raw = await owner();
    await expect(raw.query("update learning_job_runs set status = 'COMPLETED' where job = $1 and status = 'FAILED'", [job])).rejects.toThrow(/job run is final/);
    await expect(raw.query("delete from learning_job_runs where job = $1", [job])).rejects.toThrow(/append-only|cannot/);
    await expect(raw.query("insert into learning_job_runs (id, job, status, lease_until, finished_at) values (gen_random_uuid(), $1, 'COMPLETED', now(), now())", [job])).rejects.toThrow(/starts RUNNING/);
  });
  it("a failure while processing one user is isolated and counted; the cycle completes and the next run starts clean", async () => {
    const broken = Object.create(db, { transaction: { value: () => { throw new TypeError("boom"); } } }) as typeof db;
    const pp = await pipeline(); await trade(pp, "close");
    const bad = await runLearningCycle({ db: broken, config: cfg, only: [pp.userId] });
    expect(bad.failed || bad.usersFailed > 0).toBe(true);
    const ok = await runLearningCycle({ db, config: cfg, only: [pp.userId] }); expect(ok.failed).toBe(false); expect(ok.skipped).toBeNull();
    expect((await listJobRuns(db, LEARNING_JOB, 6)).every((r) => r.status !== "RUNNING")).toBe(true);
  });
});

describe("research packages are read as of the decision (G-41)", () => {
  it("agent analytics read the package the decision recorded, not a newer version stored afterwards", async () => {
    const p = await pipeline();
    const d = (await getDecision(db, p.userId, p.decisionId))!;
    expect(d.researchPackageId).not.toBeNull();
    const before = (await researchReportsForDecisions(db, p.userId, 50)).find((x) => x.candidateId === p.candId)!;
    expect(before.packageId).toBe(d.researchPackageId);
    const v2 = await storeResearchPackage(db, { candidateId: p.candId, agentResults: { packageVersion: "research-package-v1", candidateId: p.candId, reports: [], contradictions: [], missingRequired: ["later-agent"] }, assessment: "RESEARCH_CAUTION", haltReason: null });
    expect(v2.version).toBeGreaterThan(before.version);
    const after = (await researchReportsForDecisions(db, p.userId, 50)).find((x) => x.candidateId === p.candId)!;
    expect(after.packageId).toBe(d.researchPackageId); expect(after.version).toBe(before.version); expect(after.missingRequired).not.toContain("later-agent");
  });
  it("another user's decisions never bring their packages in", async () => {
    const a = await pipeline(), b = await pipeline();
    const mine = await researchReportsForDecisions(db, a.userId, 50);
    expect(mine.map((x) => x.candidateId)).toContain(a.candId); expect(mine.map((x) => x.candidateId)).not.toContain(b.candId);
  });
});

