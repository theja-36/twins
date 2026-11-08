/**
 * The two production agents (signal-integrity-v1, instrument-verification-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 2). Synthetic risk decisions, a synthetic
 * instrument reference and fake providers only: no live API, no LLM, no network, no real Telegram channel. The message rows carry a marker text that must never reach an agent input,
 * output, event or table. Nothing here creates an order, fill, position, approval card, approval or risk-decision version.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, getLatestAgentAssessment, type AgentEvent, type InstrumentRecord, type InstrumentReference,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
let state: InMemoryStateSource;
const db = () => handle.db;
const sfx = () => randomUUID().slice(0, 8);
const MARKER = "SECRET-MESSAGE-TEXT-DO-NOT-LEAK";
const CHAINS = ["agent_definitions", "agent_orchestrator_runs", "agent_runs", "agent_findings", "agent_evidence_references", "agent_orchestrator_syntheses"];
const AGENT_TABLES = CHAINS;
const LIVE = ["orders", "fills", "positions", "risk_approvals", "risk_approval_cards", "decisions", "claim_review_cards", "telegram_intake_outbox", "risk_decisions", "signals"];
// Task 2 scope: the two Task 2 agents are required; the Task 3 agents (calendar, macro) are switched off here and covered by calendarMacroAgents.test.ts
const OFF = ["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "macro-global-v1", "liquidity-v1", "market-calendar-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "technical-structure-v1", "market-context-v1"];
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "instrument-verification-v1,signal-integrity-v1" }), disabledAgents: OFF };

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); state = inMemoryStateSource(); configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 }); });
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));
const synthetic: IntelligenceResolver = async (req) => ({ ...(validIntelligence() as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(randomUUID()).digest("hex") });
const isoDay = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const rec = (o: Partial<InstrumentRecord> & Pick<InstrumentRecord, "underlying" | "instrumentType">): InstrumentRecord => ({ market: "NSE", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true, ...o });
const refOf = (instruments: InstrumentRecord[], delayMs = 0): InstrumentReference => {
  const base = memoryInstrumentReference({ name: "synthetic", asOf: new Date().toISOString(), markets: ["NSE"], instruments });
  const slow = async <T>(v: T): Promise<T> => { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return v; };
  return { ...base, supportsMarket: async (m) => slow(await base.supportsMarket(m)), underlyingKnown: async (m, u) => slow(await base.underlyingKnown(m, u)), lookup: async (x) => slow(await base.lookup(x)), listedExpiries: async (m, u, t) => slow(await base.listedExpiries(m, u, t)) };
};

interface Made { id: string; symbol: string; signalId: string; messageId: string }
/** A synthetic live decision: message (with marker text) + signal + VALID stop-loss evidence + PENDING decision + recorded source intelligence. */
async function make(o: { ageMinutes?: number; instrumentType?: string; expiry?: string | null; strike?: number | null; optionType?: string | null; edited?: boolean; entry?: number; stop?: number; targets?: number[] } = {}): Promise<Made> {
  const symbol = `PA${sfx()}`.toUpperCase().replace(/[0-9]/g, (d) => String.fromCharCode(71 + Number(d)));
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: o.instrumentType ?? "equity" }).returning();
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const at = new Date(Date.now() - (o.ageMinutes ?? 1) * 60_000);
  const ext = sfx();
  const [msg] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: ext, messageTimestamp: at, rawText: `${MARKER} BUY ${symbol} @ 100 SL 95`, rawPayload: { marker: MARKER } }).returning();
  if (o.edited) await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: `${ext}_e1`, originMessageId: ext, editDate: new Date(at.getTime() + 30_000), messageTimestamp: at, rawText: `${MARKER} edited`, rawPayload: {} });
  const entry = o.entry ?? 100, stop = o.stop ?? 95, targets = o.targets ?? [105, 110];
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", telegramMessageId: must(msg).id, instrumentId: must(instrument).id, parserVersion: "pa-test", direction: "buy", entryPrice: String(entry), stopLoss: String(stop), targets, signalTimestamp: at }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: String(stop), entryPrice: String(entry), riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `pa-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: o.instrumentType ?? "equity", market: "NSE", symbol,
    ...(o.expiry !== undefined ? { expiry: o.expiry } : {}), ...(o.strike !== undefined ? { strike: o.strike } : {}), ...(o.optionType !== undefined ? { optionType: o.optionType } : {}),
    side: "BUY", entryPrice: entry, stopLoss: stop, stopLossBasis: "price", target1: targets[0] ?? null, target2: targets[1] ?? null, decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { synthetic: true }, outputSnapshot: { stage: "risk_decision_foundation" },
  };
  const v1 = await createRiskDecision(db(), input);
  const v2 = await recordSourceIntelligence(db(), v1.id, { resolve: synthetic });
  return { id: v2.id, symbol, signalId: must(signal).id, messageId: must(msg).id };
}
const equityRef = (symbol: string) => refOf([rec({ underlying: symbol, instrumentType: "equity" })]);

describe("clean signals: both agents SUPPORTIVE, recorded, nothing approved", () => {
  it("an equity signal runs through the real engine: both agents run IN PARALLEL, outputs are validated and persisted, the assessment is SUPPORTIVE and the flow is not halted", async () => {
    const d = await make();
    const live = await counts(LIVE);
    const events: AgentEvent[] = [];
    const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: d.symbol, instrumentType: "equity" })], 60) }); // 4 lookups x 60 ms
    const out = await runAgentEngine(db(), d.id, { registry, config: ENGINE, emit: (e) => events.push(e) });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 2 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:instrument-verification-v1", "agent.started:signal-integrity-v1"]); // both started before either finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(Object.keys(runs).sort()).toEqual(["instrument-verification-v1", "signal-integrity-v1"]);
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(Number(runs["signal-integrity-v1"]!["confidence"])).toBe(90);
    expect(runs["signal-integrity-v1"]!["output_snapshot"]).toMatchObject({ blockingCount: 0, failedCodes: [], truncatedFindings: false });
    expect(runs["instrument-verification-v1"]!["output_snapshot"]).toMatchObject({ contractFound: true, referenceName: "synthetic" });
    expect((await q("select count(*)::int as n from agent_evidence_references where agent_run_id = any($1)", [Object.values(runs).map((r) => r["id"])]))[0]!["n"]).toBeGreaterThanOrEqual(4);
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id in ('signal-integrity-v1','instrument-verification-v1') group by 1,2 order by 1")).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["instrument-verification-v1@1.0.0", "signal-integrity-v1@1.0.0"]);
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(["instrument-verification-v1", "signal-integrity-v1"]);
    // the decision is untouched and a supportive assessment approves nothing
    expect(await counts(LIVE)).toEqual(live);
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("a valid option contract with a future expiry is SUPPORTIVE", async () => {
    const expiry = isoDay(20);
    const d = await make({ instrumentType: "option", expiry, strike: 24500, optionType: "CE", entry: 120, stop: 110, targets: [130, 140] });
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: d.symbol, instrumentType: "option", expiry, strike: 24500, optionType: "CE", lotSize: 75 })]) }), config: ENGINE });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", halt: false });
    expect(must((await getLatestAgentAssessment(db(), d.id))).agents.map((a) => a.verdict)).toEqual(["SUPPORTIVE", "SUPPORTIVE"]);
  });
});

describe("a BLOCKING verdict halts the flow at the existing halt point", () => {
  const registryFor = (d: Made, extra: InstrumentRecord[] = []) => createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: d.symbol, instrumentType: "equity" }), ...extra]) });
  it("a stale signal: signal-integrity BLOCKS, the instrument agent still completes independently, the assessment is RESEARCH_BLOCKED and halt is true", async () => {
    const d = await make({ ageMinutes: 600 });
    const live = await counts(LIVE);
    const out = await runAgentEngine(db(), d.id, { registry: registryFor(d), config: ENGINE });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, status: "COMPLETED" });
    const a = must(await getLatestAgentAssessment(db(), d.id));
    expect(Object.fromEntries(a.agents.map((x) => [x.agentId, x.verdict]))).toEqual({ "instrument-verification-v1": "SUPPORTIVE", "signal-integrity-v1": "BLOCKING" });
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "signal-integrity-v1", findingCodes: ["SIGNAL_STALE"] }], grantsApproval: false });
    expect(await counts(LIVE)).toEqual(live); // halting creates nothing: the decision simply stays PENDING
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
  });
  it("a superseded message revision BLOCKS (revision state comes from the stored revision rows)", async () => {
    const d = await make({ edited: true });
    const out = await runAgentEngine(db(), d.id, { registry: registryFor(d), config: ENGINE });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
    expect((await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = 'signal-integrity-v1'", [out.runId])).map((r) => r["code"])).toContain("REVISION_SUPERSEDED");
  });
  it("an expired contract BLOCKS (instrument verification)", async () => {
    const d = await make({ instrumentType: "option", expiry: "2020-01-30", strike: 24500, optionType: "CE", entry: 120, stop: 90, targets: [150] });
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: d.symbol, instrumentType: "option", expiry: "2020-01-30", strike: 24500, optionType: "CE", lotSize: 75 })]) }), config: ENGINE });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
    const a = must(await getLatestAgentAssessment(db(), d.id));
    expect(a.agents.find((x) => x.agentId === "instrument-verification-v1")?.verdict).toBe("BLOCKING");
    expect((await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1", [out.runId])).map((r) => r["code"])).toContain("EXPIRY_IN_PAST");
  });
  it("an unknown underlying and an option without a lot size BLOCK", async () => {
    const unknown = await make();
    expect(await runAgentEngine(db(), unknown.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: "SOMETHINGELSE", instrumentType: "equity" })]) }), config: ENGINE })).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
    const expiry = isoDay(15);
    const nolot = await make({ instrumentType: "option", expiry, strike: 24500, optionType: "CE", entry: 120, stop: 90, targets: [150] });
    const out = await runAgentEngine(db(), nolot.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: refOf([rec({ underlying: nolot.symbol, instrumentType: "option", expiry, strike: 24500, optionType: "CE", lotSize: null })]) }), config: ENGINE });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
  });
  it("incoherent levels (a stop above a BUY entry) BLOCK before any deeper research", async () => {
    const d = await make({ stop: 105 });
    expect(await runAgentEngine(db(), d.id, { registry: registryFor(d), config: ENGINE })).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  it("a failing instrument reference => FAILED run, required result missing => RESEARCH_INCOMPLETE and halt; the signal agent is unaffected", async () => {
    const d = await make();
    const broken: InstrumentReference = { ...equityRef(d.symbol), supportsMarket: async () => { throw new Error(`down ${MARKER}`); } };
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: broken }), config: ENGINE, sleep: async () => undefined });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(runs["instrument-verification-v1"]).toMatchObject({ status: "FAILED", verdict: "UNAVAILABLE", confidence: null, error_code: "INSTRUMENT_REFERENCE_ERROR", attempts: 2 });
    expect(runs["instrument-verification-v1"]!["error_message"]).not.toContain(MARKER); // the provider's message is never stored
    expect(runs["signal-integrity-v1"]).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE" });
  });
  it("no instrument reference configured => UNAVAILABLE => INCOMPLETE and halt (never a pass)", async () => {
    const d = await make();
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: null }), config: ENGINE });
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true });
    expect((await q("select status, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = 'instrument-verification-v1'", [must(out.skipped ? undefined : out).runId]))[0]).toMatchObject({ status: "UNAVAILABLE", error_code: "INSTRUMENT_REFERENCE_NOT_CONFIGURED" });
  });
  it("a disabled required agent is a missing result => INCOMPLETE", async () => {
    const d = await make();
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: equityRef(d.symbol) }), config: { ...ENGINE, disabledAgents: [...OFF, "signal-integrity-v1"], requiredAgents: ENGINE.requiredAgents.filter((x) => x !== "signal-integrity-v1").concat([]) } });
    expect(out).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE" }); // not required once removed from the required list: its absence is an explicit configuration choice
    const strict = await runAgentEngine(db(), (await make()).id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: null }), config: { ...ENGINE, disabledAgents: [...OFF, "signal-integrity-v1"], requiredAgents: ["instrument-verification-v1", "signal-integrity-v1"] } });
    expect(strict).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true });
  });
  it("the kill switch refuses before either agent runs", async () => {
    const d = await make();
    state.set({ KILL_SWITCH_ACTIVE: true });
    const before = await counts(AGENT_TABLES);
    await expect(runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: equityRef(d.symbol) }), config: ENGINE })).rejects.toMatchObject({ code: "safety_refused" });
    expect(await counts(AGENT_TABLES)).toEqual(before);
  });
});

describe("privacy: no raw message text anywhere", () => {
  it("the marker text of the stored messages appears in no agent input, output, finding, evidence reference, synthesis or event", async () => {
    const d = await make({ edited: true, ageMinutes: 600 }); // exercises findings, revisions and a block
    const events: AgentEvent[] = [];
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: equityRef(d.symbol) }), config: ENGINE, emit: (e) => events.push(e) });
    if (out.skipped) throw new Error("skipped");
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of AGENT_TABLES) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    expect(input["signal_context"]).toMatchObject({ messageLinked: true, revision: { known: true, state: "superseded", otherVersions: 1 } });
  });
});

describe("the engine stays inert for everything else", () => {
  it("is idempotent for the same decision and configuration without re-running the agents, and records the production agents' contracts", async () => {
    const d = await make();
    let lookups = 0;
    const base = equityRef(d.symbol);
    const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: { ...base, lookup: async (x) => { lookups += 1; return base.lookup(x); } } });
    const first = await runAgentEngine(db(), d.id, { registry, config: ENGINE });
    const again = await runAgentEngine(db(), d.id, { registry, config: ENGINE });
    if (first.skipped || again.skipped) throw new Error("skipped");
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(lookups).toBe(1);
    expect((await q("select contract from agent_definitions where agent_id = 'signal-integrity-v1' limit 1"))[0]!["contract"]).toMatchObject({ canBlock: true, advisoryOnly: false, weight: 60, requiredInputs: ["risk_decision", "stop_loss_validation", "signal_features", "signal_context"] });
  });
  it("the default engine configuration requires both production agents, and a disabled engine never touches the database", async () => {
    expect(ENGINE.requiredAgents).toEqual(["instrument-verification-v1", "signal-integrity-v1"]);
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;
    expect(await runAgentEngine(untouchable, randomUUID(), { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: loadAgentEngineConfig({}) })).toEqual({ skipped: "ENGINE_DISABLED" });
  });
});
