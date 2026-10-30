/**
 * Agent-engine observability against REAL PostgreSQL (Stage 5 / Task 9): the structured, redacted, bounded records of an engine run, built with the REAL structured logger. Synthetic decisions and fake
 * agents only: no external API, no LLM, no network, no real Telegram channel. The stored messages and a fake finding carry marker texts that must never reach a log record. Nothing here creates an
 * order, fill, position or card, and the observer changes no verdict, assessment or run.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { AgentRegistry, createRunObserver, loadAgentEngineConfig, runAgentEngine, type AgentDefinition, type ObservabilityLevel } from "../../../packages/agents/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { createRiskDecision, evaluateMarketRisk, evaluatePortfolioRisk, loadPortfolioConfig, sizeRiskDecision, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";
import { healthy, OPEN_NOW, syntheticProvider } from "../risk/gates";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const SIZE_CAPITAL = 1_000_000;
const CAPITAL = 1_000_000_000;
const MARKER = "SECRET-MESSAGE-TEXT-DO-NOT-LEAK";
const CHAINS = ["agent_definitions", "agent_orchestrator_runs", "agent_runs", "agent_findings", "agent_evidence_references", "agent_orchestrator_syntheses"];
const LIVE = ["orders", "fills", "positions", "risk_approval_cards", "risk_approvals", "decisions"];
const FINDING_MARKER = "SECRET-FINDING-TEXT-DO-NOT-LOG";

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const pfOpts = { config: openLimits(), capital: CAPITAL };

interface Stage { signalId: string; evidenceId: string; v1: string; sized: string; portfolio?: string; approved?: string; rejected?: string }
/** Builds a decision up to a stage: "pending" (unsized v1) | "sized" | "portfolio" | "approved" (all gates passed) | "market_rejected". */
async function make(stage: "pending" | "sized" | "portfolio" | "approved" | "market_rejected", symbol = `RA${sfx()}`.toUpperCase()): Promise<Stage & { head: string }> {
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: "equity" }).returning();
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const [msg] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: sfx(), messageTimestamp: new Date(), rawText: `${MARKER} BUY ${symbol} @ 100 SL 95`, rawPayload: { marker: MARKER } }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", telegramMessageId: must(msg).id, instrumentId: must(instrument).id, parserVersion: "ra-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ra-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol, side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false, intelligence: validIntelligence() }, evidenceReferences: { fixture: true },
  };
  const v1 = await createRiskDecision(db(), input);
  const base = { signalId: must(signal).id, evidenceId: must(ev).id, v1: v1.id, sized: v1.id };
  if (stage === "pending") return { ...base, head: v1.id };
  const sized = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
  if (stage === "sized") return { ...base, sized: sized.id, head: sized.id };
  const pf = await evaluatePortfolioRisk(db(), sized.id, pfOpts);
  if (stage === "portfolio") return { ...base, sized: sized.id, portfolio: pf.id, head: pf.id };
  const bad = stage === "market_rejected";
  const mk = await evaluateMarketRisk(db(), pf.id, { provider: syntheticProvider(healthy(OPEN_NOW, bad ? { bidQty: 1 } : {})), now: OPEN_NOW, capital: CAPITAL });
  return { ...base, sized: sized.id, portfolio: pf.id, ...(bad ? { rejected: mk.id } : { approved: mk.id }), head: mk.id };
}
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));

type Verdict = "SUPPORTIVE" | "NEUTRAL" | "CAUTION" | "ADVERSE" | "BLOCKING";
const fake = (id: string, verdict: Verdict, weight = 50): AgentDefinition => ({
  contract: {
    agentId: id, agentName: id, version: "1.0.0", requiredInputs: ["risk_decision"], optionalInputs: [],
    outputSchema: { fields: { checksRun: { type: "number", required: true }, blockingCount: { type: "number", required: true }, adverseCount: { type: "number", required: true }, cautionCount: { type: "number", required: true }, failedCodes: { type: "string[]", required: true }, truncatedFindings: { type: "boolean", required: true } } },
    timeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 0 }, weight, canBlock: true, advisoryOnly: false, dependsOn: [],
  },
  async run() {
    return { verdict, confidence: 100, findings: verdict === "SUPPORTIVE" || verdict === "NEUTRAL" ? [] : [{ code: "FAKE_FINDING", severity: "HIGH", summary: `${FINDING_MARKER} free-text finding` }], evidence: [{ kind: "risk_decision", ref: "risk_decision:fake" }],
      output: { checksRun: 1, blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false } };
  },
});
const clock = { now: () => new Date(), sleep: async () => undefined };
const registry = (...defs: AgentDefinition[]) => { const r = new AgentRegistry(); for (const d of defs) r.register(d); return r; };
const config = (required: string[]) => loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: required.join(",") });
const capture = () => { const records: LogRecord[] = []; return { records, log: createStructuredLogger((r) => records.push(r)) }; };
/** The same wiring as the worker's `agentEngineFor`. */
const observedRun = async (id: string, reg: AgentRegistry, cfg: ReturnType<typeof config>, level: ObservabilityLevel, log: ReturnType<typeof capture>["log"]) => {
  const observer = createRunObserver(log, { level }, { riskDecisionId: id });
  try {
    const result = await runAgentEngine(db(), id, { registry: reg, config: cfg, emit: observer.emit, ...clock });
    observer.completed(result);
    return result;
  } catch (error) { observer.failed(error); throw error; }
};
const must1 = <T,>(x: T | undefined): T => must(x);
const ours = (records: LogRecord[]) => records.filter((r) => r.event.startsWith("agent_engine."));

describe("engine run records (real engine, real logger)", () => {
  it("summary level: ONE record per run with the status counts, verdict distribution, halt reason and per-agent durations; nothing but codes and numbers", async () => {
    const m = await make("pending");
    const c = capture();
    const out = await observedRun(m.v1, registry(fake("agent_ok", "SUPPORTIVE"), fake("agent_bad", "ADVERSE", 60), fake("agent_mid", "CAUTION", 20)), config(["agent_ok", "agent_bad", "agent_mid"]), "summary", c.log);
    expect(out).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true, haltReasonCode: "HALT_ADVERSE_VETO", created: true });
    const r = ours(c.records);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ event: "agent_engine.run.completed", level: "warn", riskDecisionId: m.v1, runId: out.runId, created: true, status: "COMPLETED", assessment: "RESEARCH_ADVERSE", halt: true, haltReasonCode: "HALT_ADVERSE_VETO", agents: 3, timedOut: 0, notCompleted: 0, failedAttempts: 0 });
    expect(r[0]!["verdictDistribution"]).toEqual({ SUPPORTIVE: 1, ADVERSE: 1, CAUTION: 1 }); expect(r[0]!["statusCounts"]).toEqual({ COMPLETED: 3 });
    expect((r[0]!["agentList"] as Array<Record<string, unknown>>).map((a) => a["agentId"])).toEqual(expect.arrayContaining(["agent_ok", "agent_bad", "agent_mid"]));
    for (const a of r[0]!["agentList"] as Array<Record<string, unknown>>) expect(a).toMatchObject({ status: "COMPLETED", attempts: 1, errorCode: null, durationMs: expect.any(Number) });
  });
  it("agents level adds the run start and one record per agent; debug adds agent starts", async () => {
    const m = await make("pending");
    const a = capture();
    await observedRun(m.v1, registry(fake("agent_ok", "SUPPORTIVE")), config(["agent_ok"]), "agents", a.log);
    expect(ours(a.records).map((x) => x.event)).toEqual(["agent_engine.run.started", "agent_engine.agent.finished", "agent_engine.run.completed"]);
    const m2 = await make("pending");
    const d = capture();
    await observedRun(m2.v1, registry(fake("agent_ok", "SUPPORTIVE")), config(["agent_ok"]), "debug", d.log);
    expect(ours(d.records).map((x) => x.event)).toEqual(["agent_engine.run.started", "agent_engine.agent.started", "agent_engine.agent.finished", "agent_engine.run.completed"]);
    expect(ours(d.records).find((x) => x.event === "agent_engine.run.completed")).toMatchObject({ level: "info", halt: false, haltReasonCode: "NO_HALT" });
  });
  it("a required agent that does not complete is visible: INCOMPLETE with the halt reason", async () => {
    const m = await make("pending");
    const c = capture();
    const out = await observedRun(m.v1, registry(fake("agent_ok", "SUPPORTIVE")), config(["agent_ok", "ghost_agent"]), "agents", c.log);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true, haltReasonCode: "HALT_REQUIRED_AGENT_MISSING" });
    const done = ours(c.records).find((x) => x.event === "agent_engine.run.completed")!;
    expect(done).toMatchObject({ level: "warn", status: "INCOMPLETE", haltReasonCode: "HALT_REQUIRED_AGENT_MISSING", notCompleted: 1 });
    expect(ours(c.records).some((x) => x.event === "agent_engine.agent.finished" && x["status"] === "SKIPPED")).toBe(true);
  });
  it("the halt reason code is on the result for every path, including a stored result returned again (one info record, no agent events)", async () => {
    const m = await make("pending");
    const reg = registry(fake("agent_ok", "BLOCKING"));
    const cfg = config(["agent_ok"]);
    const c = capture();
    const first = await observedRun(m.v1, reg, cfg, "agents", c.log);
    expect(first).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, haltReasonCode: "HALT_BLOCKING_VERDICT" });
    const again = await observedRun(m.v1, reg, cfg, "agents", c.log);
    expect(again).toMatchObject({ created: false, runId: first.runId, haltReasonCode: "HALT_BLOCKING_VERDICT" });
    const reused = ours(c.records).filter((x) => x.event === "agent_engine.run.reused");
    expect(reused).toHaveLength(1); expect(reused[0]).toMatchObject({ level: "info", runId: first.runId, halt: true, haltReasonCode: "HALT_BLOCKING_VERDICT" });
    const m2 = await make("pending");
    expect(await observedRun(m2.v1, registry(fake("agent_ok", "NEUTRAL")), config(["agent_ok"]), "errors", capture().log)).toMatchObject({ assessment: "RESEARCH_NEUTRAL", halt: false, haltReasonCode: "NO_HALT" });
  });
  it("observing changes nothing: the same evaluation run without an observer is the same stored run", async () => {
    const m = await make("pending");
    const reg = registry(fake("agent_ok", "CAUTION")), cfg = config(["agent_ok"]);
    const first = await observedRun(m.v1, reg, cfg, "debug", capture().log);
    const plain = await runAgentEngine(db(), m.v1, { registry: reg, config: cfg, ...clock });
    expect(plain).toMatchObject({ created: false, runId: first.runId, assessment: first.assessment, halt: first.halt });
  });
});

describe("failures are recorded", () => {
  it("a refusal (kill switch) is an error record with its code, before any agent runs", async () => {
    const m = await make("pending");
    source.set({ KILL_SWITCH_ACTIVE: true });
    const c = capture();
    const before = await counts(["agent_orchestrator_runs"]);
    await expect(observedRun(m.v1, registry(fake("agent_ok", "SUPPORTIVE")), config(["agent_ok"]), "errors", c.log)).rejects.toMatchObject({ code: "safety_refused" });
    const r = ours(c.records);
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ level: "error", event: "agent_engine.run.failed", riskDecisionId: m.v1, errorCode: "safety_refused", completedAgents: 0 });
    expect(await counts(["agent_orchestrator_runs"])).toEqual(before);
  });
  it("a mis-wired engine (a required dependency that is disabled) is an error record, not a silent skip", async () => {
    const m = await make("pending");
    const c = capture();
    const broken = fake("agent_b", "SUPPORTIVE"); (broken.contract as { dependsOn: string[] }).dependsOn = ["agent_missing"];
    await expect(observedRun(m.v1, registry(broken), config(["agent_b"]), "errors", c.log)).rejects.toMatchObject({ code: "DEPENDENCY_NOT_REGISTERED" });
    expect(ours(c.records)[0]).toMatchObject({ level: "error", event: "agent_engine.run.failed", errorCode: "DEPENDENCY_NOT_REGISTERED" });
  });
});

describe("privacy, inertness and bounded volume", () => {
  it("the stored message text and the free-text finding appear in NO log record, at any level; the database keeps the finding (the logs do not)", async () => {
    for (const level of ["errors", "summary", "agents", "debug"] as const) {
      const m = await make("pending");
      const c = capture();
      const out = await observedRun(m.v1, registry(fake("agent_bad", "ADVERSE", 60), fake("agent_ok", "SUPPORTIVE")), config(["agent_bad", "agent_ok"]), level, c.log);
      const text = JSON.stringify(c.records);
      expect(text, level).not.toContain("SECRET-MESSAGE"); expect(text, level).not.toContain(FINDING_MARKER); expect(text, level).not.toContain("free-text finding");
      expect(text, level).not.toContain("[redacted]"); // no field was masked by the logger: every field name is safe by construction
      if (level === "summary") expect((await q("select summary from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1", [out.runId]))[0]!["summary"]).toContain(FINDING_MARKER);
    }
  });
  it("volume is bounded: one record at the default level however many agents run", async () => {
    const m = await make("pending");
    const ids = Array.from({ length: 12 }, (_, i) => `agent_${String(i).padStart(2, "0")}`);
    const c = capture();
    await observedRun(m.v1, registry(...ids.map((id) => fake(id, "SUPPORTIVE", 10))), config(ids), "summary", c.log);
    expect(ours(c.records)).toHaveLength(1);
    const noisy = capture();
    const m2 = await make("pending");
    await observedRun(m2.v1, registry(...ids.map((id) => fake(id, "SUPPORTIVE", 10))), config(ids), "debug", noisy.log);
    expect(ours(noisy.records).length).toBe(1 + 1 + 12 + 12); // start, completed, one start and one finish per agent
  });
  it("creates no order, fill, position or card, makes no network call and keeps the audit chains intact", async () => {
    const m = await make("approved");
    const live = await counts(LIVE);
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { seen.push(String(a[0])); throw new Error("fetch must not be used"); }) as typeof fetch;
    try { await observedRun(m.v1, registry(fake("agent_ok", "SUPPORTIVE")), config(["agent_ok"]), "debug", capture().log); } finally { globalThis.fetch = real; }
    expect(seen).toEqual([]);
    expect(await counts(LIVE)).toEqual(live);
    for (const t of CHAINS) expect(Number(must1((await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%'`))[0])["n"]), t).toBe(0);
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });
});
