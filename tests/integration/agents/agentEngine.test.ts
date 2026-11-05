/**
 * Agent engine against REAL PostgreSQL (Stage 5 / Task 1). FAKE agents and synthetic risk decisions only: no research agent exists, no LLM or network is used. The engine writes
 * only its six append-only, hash-chained tables, creates no risk-decision version, approval, card, order, fill or position, and a synthesis can never grant approval.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { AgentRegistry, getLatestAgentAssessment, runAgentEngine, runAgentEngineShadow, SHADOW_TIMEOUT_MS, type AgentRunResult } from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createPendingRiskDecisionForSignal, listRiskDecisions, recordSourceIntelligence, type IntelligenceResolver } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { randomLetters } from "../../support/randomLetters";
import { answer, config, delay, fakeAgent } from "../../support/fakeAgents";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
let state: InMemoryStateSource;
const db = () => handle.db;
const CHAINS = ["agent_definitions", "agent_orchestrator_runs", "agent_runs", "agent_findings", "agent_evidence_references", "agent_orchestrator_syntheses"];
const LIVE = ["orders", "fills", "positions", "risk_approvals", "risk_approval_cards", "decisions", "claim_review_cards", "telegram_intake_outbox", "risk_decisions", "signals"];

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 });
  state = inMemoryStateSource();
  configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));
const synthetic: IntelligenceResolver = async (req) => ({ ...(validIntelligence() as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(randomUUID()).digest("hex") });

/** A synthetic risk decision (PENDING, then its source-intelligence version): the context the engine is run against. */
async function makeDecision(): Promise<string> {
  const [instrument] = await db().insert(schema.instruments).values({ symbol: `AG${randomLetters(8)}`, exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "ag-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [105, 110], signalTimestamp: new Date("2025-01-06T00:00:00Z") }).returning();
  await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" });
  const pending = await createPendingRiskDecisionForSignal(db(), must(signal).id);
  if (pending.skipped) throw new Error("no decision");
  return (await recordSourceIntelligence(db(), pending.id, { resolve: synthetic })).id;
}
const registryOf = (...defs: ReturnType<typeof fakeAgent>[]): AgentRegistry => { const r = new AgentRegistry(); for (const d of defs) r.register(d); return r; };
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;
const TREND = (id: string) => `trend_${id}`;

describe("disabled by default: nothing changes", () => {
  it("returns immediately and touches neither the database nor the runtime state", async () => {
    state.failWith(new Error("down")); // would refuse if consulted
    const r = await runAgentEngine(untouchable, randomUUID(), { registry: registryOf(fakeAgent("agent_a", answer())), config: config({ enabled: false }) });
    expect(r).toEqual({ skipped: "ENGINE_DISABLED" });
  });
});

describe("fail closed before anything runs", () => {
  it("the kill switch, disabled intake or an unreadable runtime state refuse; no agent runs and nothing is written", async () => {
    const id = await makeDecision();
    let executed = 0;
    const reg = registryOf(fakeAgent("agent_a", () => { executed += 1; return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }));
    const before = await counts([...CHAINS, "risk_decisions"]);
    for (const set of [() => state.set({ KILL_SWITCH_ACTIVE: true }), () => state.set({ INTAKE_ENABLED: false }), () => state.failWith(new Error("down"))]) {
      set();
      await expect(runAgentEngine(db(), id, { registry: reg, config: config() })).rejects.toMatchObject({ code: "safety_refused" });
      state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null);
    }
    expect(executed).toBe(0);
    expect(await counts([...CHAINS, "risk_decisions"])).toEqual(before);
    await expect(runAgentEngine(db(), randomUUID(), { registry: reg, config: config() })).rejects.toMatchObject({ code: "not_found" });
  });
  it("a mis-wired graph (cycle / missing dependency) throws instead of running", async () => {
    const id = await makeDecision();
    const cyc = registryOf(fakeAgent("agent_a", answer(), { dependsOn: ["agent_b"] }), fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }));
    await expect(runAgentEngine(db(), id, { registry: cyc, config: config() })).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
  });
});

describe("a full orchestration is recorded, append-only", () => {
  it("persists the orchestrator run, agent runs, findings, evidence references, registry snapshots and the synthesis - and grants no approval", async () => {
    const id = await makeDecision();
    const live = await counts(LIVE);
    const reg = registryOf(
      fakeAgent(TREND("a"), answer("SUPPORTIVE", 80, { findings: [{ code: "TREND_UP", severity: "INFO", summary: "uptrend", detail: { slope: 1.5, label: "up" } }], evidence: [{ kind: "scorecard", ref: "scorecard:abc", sha256: "a".repeat(64) }], output: { note: "n1" } }), { requiredInputs: ["risk_decision", "source_intelligence"] }),
      fakeAgent(TREND("b"), answer("NEUTRAL", 60), { weight: 30, dependsOn: [TREND("a")], requiredInputs: ["signal_features"] }),
      fakeAgent("agent_slow", async () => { await delay(300); return { verdict: "SUPPORTIVE", confidence: 90, findings: [], evidence: [], output: {} }; }, { timeoutMs: 60 }),
      fakeAgent("agent_broken", () => { throw new Error(`leaky ${"123456789"}:${"C".repeat(35)}`); }, { retry: { maxAttempts: 2, backoffMs: 0 } }),
    );
    const events: string[] = [];
    const out = await runAgentEngine(db(), id, { registry: reg, config: config({ requiredAgents: [TREND("a")] }), emit: (e) => events.push(e.type) });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ created: true, riskDecisionId: id, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 4 });
    expect(events[0]).toBe("orchestrator.started");

    const [run] = await q("select * from agent_orchestrator_runs where id = $1", [out.runId]);
    expect(run).toMatchObject({ risk_decision_id: id, trigger: "WORKER_PIPELINE", status: "COMPLETED", created_by: "service:agent-engine" });
    expect(run!["agent_set"].map((a: { agentId: string }) => a.agentId)).toEqual([TREND("a"), TREND("b"), "agent_broken", "agent_slow"].sort());
    expect(run!["config"]).toMatchObject({ requiredAgents: [TREND("a")], maxConcurrency: 4 });
    expect(run!["input_snapshot"]).toHaveProperty("risk_decision");
    expect(run!["input_snapshot"]).toHaveProperty("source_intelligence.status", "VALID");
    expect(run!["input_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run!["input_snapshot"])).not.toMatch(/rawText|raw_text|BUY [A-Z]+ @/);

    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(runs[TREND("a")]).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1 });
    expect(Number(runs[TREND("a")]!["confidence"])).toBe(80);
    expect(runs[TREND("a")]!["output_snapshot"]).toEqual({ note: "n1" });
    expect(runs[TREND("b")]).toMatchObject({ status: "COMPLETED", verdict: "NEUTRAL" });
    expect(runs["agent_slow"]).toMatchObject({ status: "TIMEOUT", verdict: "UNAVAILABLE", confidence: null, error_code: "AGENT_TIMEOUT" });
    expect(runs["agent_broken"]).toMatchObject({ status: "FAILED", error_code: "AGENT_ERROR", attempts: 2 });
    expect(runs["agent_broken"]!["error_message"]).not.toContain("123456789"); // redacted before storage
    expect(runs[TREND("a")]!["definition_id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs[TREND("a")]!["input_snapshot_ref"]).toMatch(/^[0-9a-f]{64}$/);

    const findings = await q("select * from agent_findings where agent_run_id = $1", [runs[TREND("a")]!["id"]]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "TREND_UP", severity: "INFO", ordinal: 0, detail: { slope: 1.5, label: "up" } });
    const evidence = await q("select * from agent_evidence_references where agent_run_id = $1", [runs[TREND("a")]!["id"]]);
    expect(evidence[0]).toMatchObject({ kind: "scorecard", ref: "scorecard:abc", ref_sha256: "a".repeat(64) });

    const [syn] = await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false, algorithm_version: "research-synthesis-v2" });
    expect(syn!["result"]).toMatchObject({ grantsApproval: false, unavailableOptional: ["agent_broken", "agent_slow"] });
    expect(syn!["synthesis_input"].agents.map((a: { agentId: string }) => a.agentId)).toEqual([TREND("a"), TREND("b"), "agent_broken", "agent_slow"].sort());
    expect((await q("select count(*)::int as n from agent_definitions where agent_id = any($1)", [[TREND("a"), TREND("b"), "agent_slow", "agent_broken"]]))[0]!["n"]).toBeGreaterThanOrEqual(4);

    // no risk-decision version, approval, card, order, fill, position or legacy decision was created; the decision is untouched and not eligible
    expect(await counts(LIVE)).toEqual(live);
    expect((await listRiskDecisions(db(), { signalId: undefined, limit: 1 })).length).toBeGreaterThan(0);
    expect(await assessApprovalEligibility(db(), id)).toMatchObject({ eligible: false });
    const latest = must(await getLatestAgentAssessment(db(), id));
    expect(latest).toMatchObject({ runId: out.runId, assessment: "RESEARCH_SUPPORTIVE", status: "COMPLETED" });
    expect(latest.agents.map((a) => a.status)).toEqual(["FAILED", "TIMEOUT", "COMPLETED", "COMPLETED"]);
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("is idempotent: the same decision version, agent set, configuration and inputs resolve to the same run WITHOUT re-running any agent", async () => {
    const id = await makeDecision();
    let calls = 0;
    const reg = registryOf(fakeAgent("agent_a", () => { calls += 1; return { verdict: "SUPPORTIVE", confidence: 90, findings: [], evidence: [], output: {} }; }));
    const first = await runAgentEngine(db(), id, { registry: reg, config: config() });
    const rows = await counts(CHAINS);
    const again = await runAgentEngine(db(), id, { registry: reg, config: config() });
    if (first.skipped || again.skipped) throw new Error("skipped");
    expect(again).toMatchObject({ created: false, runId: first.runId, assessment: first.assessment });
    expect(calls).toBe(1);
    expect(await counts(CHAINS)).toEqual(rows);
    // a different configuration or agent version is a different run
    const other = await runAgentEngine(db(), id, { registry: reg, config: config({ maxConcurrency: 2 }) });
    if (other.skipped) throw new Error("skipped");
    expect(other).toMatchObject({ created: true });
    expect(other.runId).not.toBe(first.runId);
    expect(calls).toBe(2);
  });

  it("concurrent identical requests record exactly one run", async () => {
    const id = await makeDecision();
    const reg = registryOf(fakeAgent("agent_a", async () => { await delay(30); return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }));
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => runAgentEngine(db(), id, { registry: reg, config: config() })));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(Number(must(await q("select count(*)::int as n from agent_orchestrator_runs where risk_decision_id = $1", [id]))[0]!["n"])).toBe(1);
  });
});

describe("fail closed on missing results; blocking is honoured; the flow halts but never approves", () => {
  it("a missing required agent result => RESEARCH_INCOMPLETE and halt", async () => {
    const id = await makeDecision();
    const out = await runAgentEngine(db(), id, { registry: registryOf(fakeAgent("agent_a", () => { throw new Error("down"); }), fakeAgent("agent_b", answer("SUPPORTIVE", 90))), config: config({ requiredAgents: ["agent_a"] }) });
    expect(out).toMatchObject({ status: "INCOMPLETE", assessment: "RESEARCH_INCOMPLETE", halt: true });
    const absent = await runAgentEngine(db(), id, { registry: registryOf(fakeAgent("agent_b", answer("SUPPORTIVE", 90))), config: config({ requiredAgents: ["agent_nope"] }) });
    expect(absent).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true });
    expect((await q("select status, error_code from agent_runs where agent_id = 'agent_nope' order by created_at desc limit 1"))[0]).toMatchObject({ status: "SKIPPED", error_code: "REQUIRED_AGENT_NOT_REGISTERED" });
  });
  it("an enabled engine with no agents at all is INCOMPLETE and halts (never silently passes)", async () => {
    const out = await runAgentEngine(db(), await makeDecision(), { registry: new AgentRegistry(), config: config() });
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true });
  });
  it("a BLOCKING agent => RESEARCH_BLOCKED and halt, with the blocker recorded", async () => {
    const out = await runAgentEngine(db(), await makeDecision(), { registry: registryOf(fakeAgent("agent_guard", answer("BLOCKING", 95, { findings: [{ code: "HARD_STOP", severity: "CRITICAL", summary: "stop" }] }), { canBlock: true }), fakeAgent("agent_b", answer("SUPPORTIVE", 90))), config: config() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
    expect((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]!["result"]).toMatchObject({ blockers: [{ agentId: "agent_guard", findingCodes: ["HARD_STOP"] }], grantsApproval: false });
  });
  it("a supportive assessment does not halt, and which assessments halt is configurable", async () => {
    const id = await makeDecision();
    const reg = registryOf(fakeAgent("agent_a", answer("CAUTION", 90, {}), { weight: 100 }));
    expect(await runAgentEngine(db(), id, { registry: reg, config: config() })).toMatchObject({ assessment: "RESEARCH_CAUTION", halt: false });
    expect(await runAgentEngine(db(), id, { registry: reg, config: config({ haltOn: ["RESEARCH_CAUTION"] }) })).toMatchObject({ assessment: "RESEARCH_CAUTION", halt: true });
  });
});

describe("the records are immutable, tamper-evident and cannot grant approval", () => {
  it("refuses update, delete and truncate on every agent table", async () => {
    const c = await pool.connect();
    try {
      for (const t of CHAINS) for (const sql of [`update ${t} set created_by = 'service:x'`, `delete from ${t}`, `truncate ${t}`]) {
        const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
        expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code);
      }
    } finally { c.release(); }
  });
  it("the database refuses a synthesis that grants approval and an incoherent agent run", async () => {
    const id = await makeDecision();
    const out = await runAgentEngine(db(), id, { registry: registryOf(fakeAgent("agent_a", answer("NEUTRAL", 50))), config: config() });
    if (out.skipped) throw new Error("skipped");
    const hx = (): string => (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);
    const c = await pool.connect();
    try {
      const approve = await c.query(`insert into agent_orchestrator_syntheses (orchestrator_run_id, assessment, algorithm_version, synthesis_input, synthesis_input_sha256, result, grants_approval, created_by) values ($1, 'RESEARCH_SUPPORTIVE', 'x', '{}', $2, '{}', true, 'service:itest')`, [out.runId, hx()]).then(() => null, (x: { code?: string; constraint?: string }) => x);
      expect(approve).toMatchObject({ code: "23514", constraint: "agent_orchestrator_syntheses_no_approval_check" });
      const bad = await c.query(`insert into agent_runs (orchestrator_run_id, agent_id, agent_version, status, verdict, confidence, attempts, input_snapshot_ref, input_snapshot, output_snapshot, started_at, completed_at, duration_ms, created_by) values ($1, 'agent_zz', '1.0.0', 'COMPLETED', 'UNAVAILABLE', 50, 1, $2, '{}', '{}', now(), now(), 0, 'service:itest')`, [out.runId, hx()]).then(() => null, (x: { code?: string; constraint?: string }) => x);
      expect(bad).toMatchObject({ code: "23514", constraint: "agent_runs_coherence_check" });
      const noErr = await c.query(`insert into agent_runs (orchestrator_run_id, agent_id, agent_version, status, verdict, attempts, input_snapshot_ref, input_snapshot, output_snapshot, started_at, completed_at, duration_ms, created_by) values ($1, 'agent_zy', '1.0.0', 'FAILED', 'UNAVAILABLE', 1, $2, '{}', '{}', now(), now(), 0, 'service:itest')`, [out.runId, hx()]).then(() => null, (x: { code?: string }) => x);
      expect(noErr?.code).toBe("23514"); // a failed run must carry an error code
    } finally { c.release(); }
  });
});

describe("runs against results", () => {
  it("the stored run results match the in-memory ones (spot check through the read model)", async () => {
    const id = await makeDecision();
    const out = await runAgentEngine(db(), id, { registry: registryOf(fakeAgent("agent_a", answer("ADVERSE", 99), { weight: 100 })), config: config() });
    if (out.skipped) throw new Error("skipped");
    expect(out.assessment).toBe("RESEARCH_ADVERSE");
    expect(out.halt).toBe(true);
    const stored: Pick<AgentRunResult, "status" | "verdict">[] = (await q("select status, verdict from agent_runs where orchestrator_run_id = $1", [out.runId])) as never;
    expect(stored).toEqual([{ status: "COMPLETED", verdict: "ADVERSE" }]);
  });
});

describe("shadow mode (HB-06): evaluates and reports, persists nothing, never halts", () => {
  it("returns the assessment with a would-halt flag and writes NOTHING (no agent table, no decision, card, approval, order, fill or position)", async () => {
    const id = await makeDecision();
    const reg = registryOf(fakeAgent("agent_a", answer("ADVERSE", 90), { weight: 80 }));
    const watched = [...CHAINS, ...LIVE];
    const before = await counts(watched);
    const r = await runAgentEngineShadow(db(), id, { registry: reg, config: config({ enabled: false, shadow: true, requiredAgents: ["agent_a"] }) });
    expect(r).toMatchObject({ riskDecisionId: id, status: "COMPLETED", assessment: "RESEARCH_ADVERSE", wouldHalt: true, agents: [{ agentId: "agent_a", status: "COMPLETED", verdict: "ADVERSE", confidence: 90 }] });
    expect(await counts(watched)).toEqual(before);
    expect(await getLatestAgentAssessment(db(), id)).toBeUndefined();
  });
  it("a supportive result reports wouldHalt false; an incomplete one (required agent missing) reports INCOMPLETE and would halt", async () => {
    const id = await makeDecision();
    const ok = await runAgentEngineShadow(db(), id, { registry: registryOf(fakeAgent("agent_a", answer("SUPPORTIVE", 90))), config: config({ enabled: false, shadow: true, requiredAgents: ["agent_a"] }) });
    expect(ok).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", wouldHalt: false });
    const missing = await runAgentEngineShadow(db(), id, { registry: registryOf(fakeAgent("agent_a", answer("SUPPORTIVE", 90))), config: config({ enabled: false, shadow: true, requiredAgents: ["agent_a", "agent_missing"] }) });
    expect(missing).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", wouldHalt: true });
  });
  it("is a no-op unless shadow is on, and refuses to run next to the enforcing engine", async () => {
    expect(await runAgentEngineShadow(untouchable, randomUUID(), { registry: registryOf(fakeAgent("agent_a", answer())), config: config({ enabled: false, shadow: false }) })).toEqual({ skipped: "SHADOW_OFF" });
    expect(await runAgentEngineShadow(untouchable, randomUUID(), { registry: registryOf(fakeAgent("agent_a", answer())), config: config({ enabled: true, shadow: true }) })).toEqual({ skipped: "ENGINE_ENFORCING" });
  });
  it("is bounded in time (F1 finding 1): a hung evaluation comes back as SHADOW_TIMEOUT instead of stalling the caller", async () => {
    const id = await makeDecision();
    const cfg = config({ enabled: false, shadow: true, requiredAgents: ["agent_a"] });
    const hung = registryOf(fakeAgent("agent_a", (() => new Promise(() => undefined)) as never));
    const t0 = Date.now();
    expect(await runAgentEngineShadow(db(), id, { registry: hung, config: cfg, shadowTimeoutMs: 100 })).toEqual({ skipped: "SHADOW_ERROR", errorCode: "SHADOW_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(SHADOW_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(SHADOW_TIMEOUT_MS).toBeLessThanOrEqual(10000);
    expect(await runAgentEngineShadow(db(), id, { registry: registryOf(fakeAgent("agent_a", answer("SUPPORTIVE", 90))), config: cfg, shadowTimeoutMs: 5000 })).toMatchObject({ assessment: expect.any(String) });
  });
  it("never throws: a refused runtime state, an unknown decision and a mis-wired registry come back as skipped values", async () => {
    const id = await makeDecision();
    const cfg = config({ enabled: false, shadow: true, requiredAgents: ["agent_a"] });
    const reg = registryOf(fakeAgent("agent_a", answer()));
    state.set({ KILL_SWITCH_ACTIVE: true });
    expect(await runAgentEngineShadow(db(), id, { registry: reg, config: cfg })).toMatchObject({ skipped: "SHADOW_REFUSED" });
    state.set({ KILL_SWITCH_ACTIVE: false });
    expect(await runAgentEngineShadow(db(), randomUUID(), { registry: reg, config: cfg })).toMatchObject({ skipped: "SHADOW_ERROR" });
    expect(await runAgentEngineShadow(db(), id, { registry: registryOf(fakeAgent("agent_a", answer(), { dependsOn: ["agent_nope"] })), config: cfg })).toMatchObject({ skipped: "SHADOW_ERROR" });
  });
});
