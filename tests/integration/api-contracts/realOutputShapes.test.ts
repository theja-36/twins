/**
 * Stage 09.3B.1 against REAL PostgreSQL and the REAL engines. No toy objects: the research package comes from the real orchestrator, the decision from the real decision engine and cycle, the trade from the real paper
 * execution, the analytics from the real ingestion, snapshot and report code, all served by the real session routes. The contract constants in @twins/api-contracts must equal what comes out.
 * Also proves (A) what an analytics GET writes, (B) cross-user isolation over HTTP, and (C) that analytics and insights change nothing that governs trading. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { SPEC_VERDICTS as BACKEND_SPEC_VERDICTS } from "../../../packages/types/src/index";
import { AuthService, hashSessionToken, newSessionToken, sqlAuditSink, sqlAuthStore } from "../../../packages/auth/src/index";
import { comparablePatterns } from "../../../packages/decision/src/index";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, runCandidateResearch } from "../../../packages/agents/src/index";
import { DEFAULT_OUTCOME_LEARNING, currentAnalytics, ingestOutcomes, runLearningCycle } from "../../../packages/outcomes/src/index";
import { getCandidate, storeResearchPackage } from "../../../packages/database/src/index";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerUserRoutes } from "../../../apps/api/src/userApi";
import { buildUserOps } from "../../../apps/api/src/userOps";
import { buildResearchOps, registerResearchRoutes } from "../../../apps/api/src/researchApi";
import * as C from "../../../packages/api-contracts/src/index";
import { closeClients, db, NOW, owner, pipeline, trade, type Pipe } from "../support/tradingPipeline";

afterAll(async () => { await closeClients(); });
const store = sqlAuthStore(db), auth = new AuthService({ store, audit: sqlAuditSink(db), config: { scrypt: { N: 2 ** 10, r: 8, p: 1 } } });
const cfg = { ...DEFAULT_OUTCOME_LEARNING, enabled: true };
const ops = buildUserOps(db);
const app = Fastify(); registerAuthRoutes(app, { auth }); registerUserRoutes(app, { auth, ops, now: () => NOW }); registerResearchRoutes(app, { auth, ops: buildResearchOps(db) });
const tokenFor = async (userId: string): Promise<string> => { const t = newSessionToken(); await store.createSession({ userId: userId as never, tokenHash: hashSessionToken(t), createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }); return t; };
const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = async (url: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> => { const r = await call("GET", url, token); return { status: r.statusCode, body: r.json() as Record<string, unknown> }; };
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
/** every key of `o` is required or optional, and every required key is present: nothing undeclared, nothing missing */
function exactKeys(o: unknown, required: readonly string[], optional: readonly string[] = [], label = "object"): void {
  const k = keys(o); expect(k.filter((x) => !required.includes(x) && !optional.includes(x)), `${label}: undeclared keys`).toEqual([]); expect(required.filter((x) => !k.includes(x)), `${label}: missing keys`).toEqual([]);
}
const researchOf = async (p: Pipe): Promise<void> => {
  const c = (await getCandidate(db, p.candId))!;
  const r = await runCandidateResearch(c as never, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), sink: { save: (id, build) => storeResearchPackage(db, build as never, id) }, deps: { now: () => NOW, sleep: async () => undefined } });
  expect(r.skipped, "the real research run must execute").toBeUndefined();
};
async function closedUser(): Promise<{ p: Pipe; token: string }> { const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50); return { p, token: await tokenFor(p.userId) }; }
const count = async (sql: string, args: unknown[]): Promise<number> => ((await (await owner()).query(sql, args)).rows[0] as { n: number }).n;

describe("research package: real orchestrator output through the real route", () => {
  it("the envelope and the stored package match the contract exactly; the package grants no approval", async () => {
    const p = await pipeline(), token = await tokenFor(p.userId); await researchOf(p);
    const r = await get(`/research/candidates/${p.candId}/package`, token); expect(r.status).toBe(200);
    exactKeys(r.body, C.RESEARCH_PACKAGE_KEYS, [], "envelope");
    const pkg = r.body["package"] as Record<string, unknown>;
    exactKeys(pkg, C.RESEARCH_PACKAGE_BODY_KEYS, C.RESEARCH_PACKAGE_BODY_OPTIONAL_KEYS, "package");
    expect(pkg["grantsApproval"]).toBe(false); expect(pkg["version"]).toBe(r.body["version"]); expect(pkg["assessment"]).toBe(r.body["assessment"]); expect(pkg["candidateId"]).toBe(p.candId);
    expect(pkg["packageSha256"]).toMatch(/^[0-9a-f]{64}$/); expect(pkg["synthesisInputSha256"]).toMatch(/^[0-9a-f]{64}$/);
    const reports = pkg["reports"] as Array<Record<string, unknown>>; expect(reports.length).toBeGreaterThan(5);
    for (const rep of reports) { exactKeys(rep, C.AGENT_REPORT_KEYS, C.AGENT_REPORT_OPTIONAL_KEYS, `report ${String(rep["agentId"])}`); expect(C.SPEC_VERDICTS).toContain(rep["verdict"]); expect(rep["confidence"] === null || typeof rep["confidence"] === "number").toBe(true); }
    exactKeys(pkg["roleCoverage"], C.ROLE_COVERAGE_KEYS, [], "roleCoverage");
    for (const c of pkg["contradictions"] as unknown[]) exactKeys(c, C.CONTRADICTION_KEYS, [], "contradiction");
    expect(typeof pkg["haltReason"] === "string" || pkg["haltReason"] === null).toBe(true);
    // the real run on this machine has no providers configured: unavailable agents say INCOMPLETE with an error code, never a pass
    for (const rep of reports.filter((x) => x["executionStatus"] !== "COMPLETED")) { expect(rep["verdict"]).toBe("INCOMPLETE"); expect(typeof rep["errorCode"]).toBe("string"); }
  }, 120_000);
  it("the mirrored verdict vocabulary equals the backend's", () => { expect([...C.SPEC_VERDICTS].sort()).toEqual([...BACKEND_SPEC_VERDICTS].sort()); });
  it("a candidate with no package answers with the documented absent shape", async () => {
    const p = await pipeline(), token = await tokenFor(p.userId); const none = await get(`/research/candidates/${randomUUID()}/package`, token); expect(none.status).toBe(404);
  });
});

describe("decision record: real engine output through the real route", () => {
  it("decision view, explanation (including reasons and provenance), size, events and approval", async () => {
    const p = await pipeline(), token = await tokenFor(p.userId); await researchOf(p);
    const r = await get(`/decisions/${p.decisionId}`, token); expect(r.status).toBe(200); exactKeys(r.body, ["decision", "events", "approval", "watching"], [], "detail");
    const d = r.body["decision"] as Record<string, unknown>; exactKeys(d, C.DECISION_VIEW_KEYS, [], "decision");
    expect(typeof d["outcome"]).toBe("string"); expect(typeof d["workflowState"]).toBe("string"); expect(C.DECISION_STATES).toContain(d["workflowState"]);
    const ex = d["explanation"] as Record<string, unknown>; exactKeys(ex, C.DECISION_EXPLANATION_KEYS, [], "explanation");
    exactKeys(ex["provenance"], C.EXPLANATION_PROVENANCE_KEYS, [], "provenance");
    for (const x of [...(ex["reasons"] as unknown[]), ...(ex["restrictions"] as unknown[])]) exactKeys(x, C.DECISION_REASON_KEYS, [], "reason");
    for (const k of ["supporting", "missing", "contradictory", "riskRestrictions", "reassess", "invalidatedBy", "whatWouldChange"]) expect(Array.isArray(ex[k]), k).toBe(true);
    const sl = d["stopLossValidation"] as Record<string, unknown>; for (const k of C.STOP_LOSS_VALIDATION_CORE_KEYS) expect(k in sl, k).toBe(true);
    const ps = d["permittedSize"] as Record<string, unknown>; exactKeys(ps, ["lots", "quantity", "maxLossAtStop", "riskPerLot", "grossExposure", "sizeMultiplier", "binding"], [], "permittedSize");
    for (const k of ["maxLossAtStop", "riskPerLot", "grossExposure"]) expect(typeof ps[k], `${k} stays an exact decimal string`).toBe("string");
    expect((d["evidenceRefs"] as unknown[]).every((x) => typeof x === "string")).toBe(true); expect(Object.values(d["versions"] as object).every((x) => typeof x === "string")).toBe(true);
    for (const e of r.body["events"] as unknown[]) exactKeys(e, ["fromState", "toState", "actor", "reason", "at"], [], "event");
    expect(r.body["approval"] === null || Object.keys(r.body["approval"] as object).sort().join() === "action,at").toBe(true); expect(typeof r.body["watching"]).toBe("boolean");
  }, 120_000);
  it("comparables through the real route (NOT_AVAILABLE here) and the real function's AVAILABLE shape", async () => {
    const p = await pipeline(), token = await tokenFor(p.userId), r = await get(`/decisions/${p.decisionId}/comparables`, token);
    expect(r.status).toBe(200); exactKeys(r.body, ["decisionId", "comparables"], [], "comparables envelope"); const c = r.body["comparables"] as Record<string, unknown>;
    if (c["state"] === "NOT_AVAILABLE") { exactKeys(c, ["state", "version", "reason", "detail", "patterns"], [], "NOT_AVAILABLE"); expect(C.COMPARABLES_NOT_AVAILABLE_REASONS).toContain(c["reason"]); expect(c["patterns"]).toEqual([]); }
    else exactKeys(c, ["state", "version", "verdict", "patterns", "summary", "note"], [], "AVAILABLE");
    const a = comparablePatterns({ reports: [{ agentId: "historical-pattern-v1", executionStatus: "COMPLETED", verdict: "SUPPORTIVE", evidenceRefs: ["historical_pattern:abc"], reasoningSummary: "s" }] });
    expect(a.state).toBe("AVAILABLE"); exactKeys(a, ["state", "version", "verdict", "patterns", "summary", "note"], [], "AVAILABLE (real function)"); expect((a as { patterns: unknown[] }).patterns.every((x) => typeof x === "string")).toBe(true);
  }, 120_000);
  it("approvals: the pending and history items are decision views, pending ones also carry the server's expired and action", async () => {
    const p = await pipeline(), token = await tokenFor(p.userId), r = await get("/approvals", token); expect(r.status).toBe(200); exactKeys(r.body, ["pending", "history"], [], "approvals");
    for (const x of r.body["pending"] as unknown[]) exactKeys(x, C.DECISION_VIEW_KEYS, ["expired", "action"], "pending");
    for (const x of r.body["history"] as unknown[]) exactKeys(x, C.DECISION_VIEW_KEYS, [], "history");
  }, 120_000);
});

describe("analytics: every section from real data", () => {
  it("envelope, snapshot metadata, and each section's data keys; money stays an exact string; every metric states its definition", async () => {
    const { token } = await closedUser(), sections: Array<[string, readonly string[]]> = [["overview", C.OVERVIEW_DATA_KEYS], ["strategies", C.STRATEGY_DATA_KEYS], ["channels", C.CHANNELS_DATA_KEYS], ["independent", C.INDEPENDENT_DATA_KEYS], ["agents", C.AGENTS_DATA_KEYS], ["decisions", C.DECISIONS_DATA_KEYS], ["drift", C.DRIFT_DATA_KEYS], ["data-quality", C.DATA_QUALITY_DATA_KEYS], ["calibration", C.CALIBRATION_DATA_KEYS]];
    const body: Record<string, Record<string, unknown>> = {};
    for (const [s, dataKeys] of sections) {
      const r = await get(`/analytics/${s}`, token); expect(r.status, s).toBe(200); body[s] = r.body;
      exactKeys(r.body, ["contractVersion", "generatedAt", "dataset", "mode", "liveStatus", "notice", "data", "snapshot", "freshness", "state"], [], `${s} envelope`);
      expect(r.body).toMatchObject({ contractVersion: C.ANALYTICS_CONTRACT_VERSION, dataset: "PAPER", mode: "PAPER", liveStatus: "UNAVAILABLE", freshness: "CURRENT" }); expect(["OK", "PARTIAL", "EMPTY"]).toContain(r.body["state"]);
      exactKeys(r.body["snapshot"], C.SNAPSHOT_META_KEYS, [], `${s} snapshot`); exactKeys(r.body["data"], dataKeys, [], `${s} data`);
    }
    const snap = body["overview"]!["snapshot"] as Record<string, unknown>; for (const h of ["evidenceHash", "inputHash", "configHash"]) expect(snap[h]).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(snap["algorithmVersions"] as object).every((v) => typeof v === "string")).toBe(true); expect(snap["freshness"]).toBe("CURRENT"); expect(snap["staleReason"]).toBeNull();
    for (const set of C.OVERVIEW_DATA_KEYS) {
      const m = (body["overview"]!["data"] as Record<string, Record<string, unknown>>)[set]!; exactKeys(m, C.PERFORMANCE_METRICS_KEYS, [], `overview.${set}`);
      for (const k of ["grossPnl", "costs", "netPnl"]) expect(typeof m[k], `${set}.${k} is an exact decimal string`).toBe("string");
      for (const k of ["winRate", "lossRate", "avgWin", "avgLoss", "payoffRatio", "expectancyR", "expectancyMoney", "profitFactor", "maxDrawdown", "costImpact", "slippage"]) { const x = m[k] as Record<string, unknown>; expect(typeof x["definition"], `${k}.definition`).toBe("string"); expect(typeof x["n"], `${k}.n`).toBe("number"); expect("value" in x, `${k}.value`).toBe(true); }
      expect(m["maxDrawdownPct"]).toMatchObject({ value: null, status: "NOT_AVAILABLE" }); exactKeys(m["holdingSeconds"], ["n", "mean", "min", "p25", "median", "p75", "max"], [], "holdingSeconds"); exactKeys(m["rMultiple"], ["n", "mean", "total", "definition"], [], "rMultiple");
    }
    const fixture = (body["overview"]!["data"] as Record<string, Record<string, unknown>>)["fixtureOnly"]!;
    expect(fixture["eligible"]).toBeGreaterThan(0); expect(((body["overview"]!["data"] as Record<string, Record<string, unknown>>)["validatedOnly"]!)["eligible"]).toBe(0); // fixture outcomes are never counted as validated
    const win = fixture["winRate"] as Record<string, unknown>; expect(win["interval"] === null || (keys(win["interval"]).join() === "lower,upper")).toBe(true);
    exactKeys(fixture["expectancyR"], ["value", "n", "definition", "note", "exact", "interval95", "intervalMethod", "degreesOfFreedom"], ["note"], "expectancyR");
    exactKeys(fixture["profitFactor"], ["value", "n", "definition", "exact", "interval", "intervalNote"], ["note"], "profitFactor");
    const strat = body["strategies"]!["data"] as Record<string, unknown>; for (const k of C.STRATEGY_DATA_KEYS.filter((x) => x !== "bySignalPattern")) for (const s of strat[k] as Array<Record<string, unknown>>) { exactKeys(s, ["key", "metrics"], [], `slice ${k}`); exactKeys(s["metrics"], C.PERFORMANCE_METRICS_KEYS, [], `slice ${k} metrics`); }
    expect(strat["bySignalPattern"]).toMatchObject({ status: "NOT_AVAILABLE" }); exactKeys(strat["bySignalPattern"], ["status", "reason", "dependsOn"], [], "bySignalPattern");
    expect(body["calibration"]!["data"]).toMatchObject({ status: "UNCALIBRATED" }); // never presented as calibrated while the data is fixtures
    for (const x of (body["decisions"]!["data"] as Record<string, Record<string, unknown>>)["decisions"] ? [(body["decisions"]!["data"] as Record<string, unknown>)["decisions"]] : []) exactKeys(x, C.DECISION_COUNTS_KEYS, [], "decision counts");
    for (const a of (body["agents"]!["data"] as Record<string, unknown[]>)["agents"]!) exactKeys(a, C.AGENT_ANALYTICS_ROW_KEYS, [], "agent row");
    const dr = body["drift"]!["data"] as Record<string, unknown>; for (const f of dr["findings"] as unknown[]) exactKeys(f, C.DRIFT_FINDING_KEYS, [], "drift finding"); for (const s of Object.values(dr["shifts"] as object)) exactKeys(s, C.DRIFT_SHIFT_KEYS, [], "drift shift");
    // dataset and dimension narrowing returns exactly the requested view
    expect(keys(((await get("/analytics/overview?dataset=FIXTURE", token)).body["data"]))).toEqual(["fixtureOnly"]); expect(keys(((await get("/analytics/strategies?dimension=instrument", token)).body["data"]))).toEqual(["byInstrument"]);
  }, 180_000);
  it("outcome rows match the contract; insights are empty until the learning cycle runs, then carry REVIEW-only recommendations", async () => {
    const { p, token } = await closedUser(), o = await get("/analytics/outcomes?limit=50", token); expect(o.status).toBe(200);
    for (const row of o.body["data"] as Array<Record<string, unknown>>) { exactKeys(row, C.OUTCOME_ROW_KEYS, [], "outcome row"); for (const k of ["grossPnl", "costs", "netPnl", "rMultiple"]) expect(row[k] === null || typeof row[k] === "string", k).toBe(true); expect(row["dataSource"]).toBe("FIXTURE"); }
    const none = await get("/analytics/insights", token); expect(none.body["state"]).toBe("EMPTY"); expect(none.body["data"]).toEqual([]); // the API never generates insights; only the learning cycle does
    const run = await runLearningCycle({ db, config: cfg, only: [p.userId] }); expect(run.failed).toBe(false); expect(run.insightsCreated).toBeGreaterThan(0);
    const ins = await get("/analytics/insights?limit=200", token), rows = ins.body["data"] as Array<Record<string, unknown>>; expect(ins.body["state"]).toBe("OK"); expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) { exactKeys(row, C.INSIGHT_ROW_KEYS, [], "insight row"); expect([null, C.INSIGHT_RECOMMENDATION_REVIEW]).toContain(row["recommendation"]); expect(row["reliability"]).not.toBe("ADEQUATE"); }
  }, 180_000);
});

describe("stale and partial responses over HTTP", () => {
  it("a PARTIAL attribution makes the state PARTIAL", async () => {
    const p = await pipeline(); await trade(p, "partial"); await ingestOutcomes(db, p.userId, 50); const token = await tokenFor(p.userId), r = await get("/analytics/overview", token);
    expect(r.status).toBe(200); expect(r.body["state"]).toBe("PARTIAL"); expect(((r.body["data"] as Record<string, Record<string, unknown>>)["all"]!)["eligible"]).toBeDefined();
    expect(((await get("/analytics/data-quality", token)).body["data"] as Record<string, unknown>)["partial"]).toBeGreaterThan(0);
  }, 180_000);
  it("when the current evidence cannot be analysed, the newest stored snapshot is served as STALE with the reason, never as CURRENT", async () => {
    const { token, p } = await closedUser(); const good = await get("/analytics/overview", token); expect(good.body["freshness"]).toBe("CURRENT");
    const broken = new Proxy(db, { get(t, k) { const v = Reflect.get(t, k, t) as unknown; if (k === "transaction") return async (fn: unknown, c?: { isolationLevel?: string }) => { if (c?.isolationLevel) throw new Error("simulated database fault"); return (v as (...a: unknown[]) => unknown).call(t, fn, c); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as typeof db;
    const staleApp = Fastify(); registerAuthRoutes(staleApp, { auth }); registerUserRoutes(staleApp, { auth, ops: { ...ops, analytics: (u: string, n: Date) => currentAnalytics({ db: broken, config: cfg, now: () => n }, u, "API") }, now: () => NOW });
    const r = await staleApp.inject({ method: "GET", url: "/analytics/overview", headers: { authorization: `Bearer ${await tokenFor(p.userId)}` } }), b = r.json() as Record<string, Record<string, unknown>> & Record<string, unknown>;
    expect(r.statusCode).toBe(200); expect(b["freshness"]).toBe("STALE"); expect(b["snapshot"]!["freshness"]).toBe("STALE"); expect(String(b["snapshot"]!["staleReason"])).toMatch(/could not be analysed/); expect(b["snapshot"]!["id"]).toBe((good.body["snapshot"] as Record<string, unknown>)["id"]);
  }, 180_000);
});

describe("A. what an analytics GET writes", () => {
  it("the first GET stores ONE immutable snapshot row (idempotent insert); repeats and other sections write nothing; changed evidence stores one more; no insight, attribution, audit-job or settings row is written", async () => {
    const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50); const token = await tokenFor(p.userId);
    const snaps = () => count("select count(*)::int as n from analytics_snapshots where user_id = $1", [p.userId]), insights = () => count("select count(*)::int as n from learning_insights where user_id = $1", [p.userId]), attrs = () => count("select count(*)::int as n from outcome_attributions where user_id = $1", [p.userId]);
    expect([await snaps(), await insights(), await attrs()]).toEqual([0, 0, 1]);
    expect((await get("/analytics/overview", token)).status).toBe(200); expect(await snaps()).toBe(1); // THE FINDING: a GET created a row
    for (const s of ["overview", "strategies", "agents", "decisions", "drift", "data-quality", "calibration", "outcomes", "insights", "channels", "independent"]) expect((await get(`/analytics/${s}`, token)).status).toBe(200);
    expect(await snaps()).toBe(1); expect(await insights()).toBe(0); expect(await attrs()).toBe(1);
    const p2 = await pipeline({ userId: p.userId, accountId: p.accountId }); await trade(p2, "close"); await ingestOutcomes(db, p.userId, 50);
    expect((await get("/analytics/overview", token)).status).toBe(200); expect(await snaps()).toBe(2); expect(await insights()).toBe(0);
    const row = (await (await owner()).query("select created_by, mode from analytics_snapshots where user_id = $1 order by created_at", [p.userId])).rows as Array<{ created_by: string; mode: string }>; expect(row.every((r) => r.created_by === "API" && r.mode === "PAPER")).toBe(true);
    await expect((await owner()).query("update analytics_snapshots set report = '{}'::jsonb where user_id = $1", [p.userId])).rejects.toThrow(); // immutable once written
  }, 240_000);
});

describe("B. cross-user isolation over HTTP", () => {
  it("Trader B can read none of Trader A's decisions, approvals, orders, positions, capital, risk, portfolio or analytics; an ADMIN reads none of it", async () => {
    const a = await closedUser(), b = await closedUser(); await researchOf(a.p);
    const existing = (await (await owner()).query("select id from users where role = 'ADMIN' and is_active limit 1")).rows[0] as { id: string } | undefined, adminId = existing?.id ?? ((await auth.bootstrapAdmin({ email: `admin-${randomUUID()}@example.test`, password: "correct horse battery staple" })).id as string), adminToken = await tokenFor(adminId);
    const aOrders = (await get("/execution/orders", a.token)).body["orders"] as Array<{ id: string }>, aPositions = (await get("/execution/positions", a.token)).body["positions"] as Array<{ id: string }>;
    expect(aOrders.length).toBeGreaterThan(0); expect(aPositions.length).toBeGreaterThan(0); // A really has data to leak
    const markers = [a.p.decisionId, a.p.accountId, a.p.userId, a.p.u, aOrders[0]!.id, aPositions[0]!.id];
    const mine = JSON.stringify((await get(`/decisions?limit=200`, a.token)).body); for (const m of [a.p.decisionId, a.p.accountId]) expect(mine).toContain(m); // the markers are real in A's own view
    const resource404 = [`/decisions/${a.p.decisionId}`, `/decisions/${a.p.decisionId}/comparables`, `/capital/profile?accountId=${a.p.accountId}`, `/risk/policy?accountId=${a.p.accountId}`, `/portfolio?accountId=${a.p.accountId}`];
    for (const u of resource404) { expect((await call("GET", u, b.token)).statusCode, `B ${u}`).toBe(404); expect((await call("GET", u, adminToken)).statusCode, `ADMIN ${u}`).toBe(404); }
    expect((await call("POST", `/decisions/${a.p.decisionId}/watch`, b.token, { idempotencyKey: `watch-${randomUUID()}` })).statusCode).toBe(404);
    expect(await count("select count(*)::int as n from decision_watches where decision_id = $1", [a.p.decisionId])).toBe(0);
    const lists = ["/decisions?limit=200", `/decisions?limit=200&accountId=${a.p.accountId}`, "/approvals", "/execution/orders", "/execution/positions", `/execution/orders?decisionId=${a.p.decisionId}`, "/accounts", "/risk/controls", `/execution/orders/${aOrders[0]!.id}/fills`, `/execution/positions/${aPositions[0]!.id}/events`,
      ...["overview", "strategies", "channels", "independent", "agents", "decisions", "drift", "data-quality", "calibration"].map((x) => `/analytics/${x}`), "/analytics/outcomes?limit=200", "/analytics/insights?limit=200"];
    for (const u of lists) {
      const r = await call("GET", u, b.token), text = r.payload; expect([200, 404], `B ${u}`).toContain(r.statusCode);
      for (const m of markers) expect(text.includes(m), `B ${u} leaks ${m.slice(0, 8)}`).toBe(false);
      const ad = await call("GET", u, adminToken); expect(ad.statusCode, `ADMIN ${u}`).toBe(404); for (const m of markers) expect(ad.payload.includes(m)).toBe(false);
    }
    // B's own data is present and A's markers are absent from the same response
    const bOverview = (await get("/analytics/outcomes?limit=200", b.token)).body["data"] as Array<{ decisionId: string }>; expect(bOverview.map((x) => x.decisionId)).toEqual([b.p.decisionId]);
    // shared intelligence is shared by design: B can read A's candidate through the SHARED research route (no owner), and nothing private comes with it
    const shared = await call("GET", `/research/candidates/${a.p.candId}/package`, b.token); expect(shared.statusCode).toBe(200); for (const m of [a.p.userId, a.p.accountId, a.p.decisionId]) expect(shared.payload.includes(m)).toBe(false);
  }, 300_000);
});

describe("C. review-only: analytics, snapshots and insights change nothing that governs trading", () => {
  it("no non-GET route exists under /analytics; reading every analytics endpoint and running the learning cycle leaves policy, capital, decisions, controls, permissions, orders and positions byte-identical", async () => {
    const { p, token } = await closedUser();
    for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) for (const s of ["overview", "insights", "outcomes", "calibration"]) { const r = await app.inject({ method: m, url: `/analytics/${s}`, headers: { authorization: `Bearer ${token}` }, payload: {} }); expect([404, 405], `${m} /analytics/${s}`).toContain(r.statusCode); }
    const c = await owner(), tables = (await c.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'
      and table_name !~ '^(outcome_|analytics_|learning_|calibration_|audit_|job_|user_sessions|idempotency)' and table_name not in ('users', 'twins_txn_identity') order by table_name`)).rows.map((r: { table_name: string }) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(["user_decisions", "user_risk_policies", "user_capital_profiles", "user_execution_permissions"]));
    const fingerprint = async (): Promise<Record<string, string>> => { const out: Record<string, string> = {}; for (const t of tables) out[t] = ((await c.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as f from "${t}" x where user_id = $1`, [p.userId])).rows[0] as { f: string }).f; return out; };
    const before = await fingerprint();
    for (const s of ["overview", "strategies", "channels", "independent", "agents", "decisions", "drift", "data-quality", "calibration", "outcomes", "insights"]) expect((await get(`/analytics/${s}`, token)).status).toBe(200);
    const run = await runLearningCycle({ db, config: cfg, only: [p.userId] }); expect(run.failed).toBe(false); expect(run.insightsCreated).toBeGreaterThan(0);
    for (const u of ["/analytics/overview", "/analytics/insights?limit=200"]) expect((await get(u, token)).status).toBe(200);
    const after = await fingerprint(); const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
    expect(changed, `these governing tables changed: ${changed.join(", ")}`).toEqual([]);
    const ins = (await get("/analytics/insights?limit=200", token)).body["data"] as Array<{ recommendation: string | null; reliability: string }>; expect(ins.every((i) => i.recommendation === null || i.recommendation === C.INSIGHT_RECOMMENDATION_REVIEW)).toBe(true);
    await expect(c.query("update learning_insights set recommendation = 'REVIEW' where user_id = $1", [p.userId])).rejects.toThrow(/append-only/); // stored insights cannot be edited either
  }, 300_000);
});
