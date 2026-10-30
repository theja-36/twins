/**
 * The Historical Pattern and Independent Challenger agents (historical-pattern-v1, independent-challenger-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 7). Synthetic risk decisions and
 * fake in-memory providers only: no external API, no LLM, no network, no real Telegram channel. The engine clock is fixed (Monday 2025-01-06 09:35 IST) so session logic is deterministic.
 * The stored messages carry a marker text that must never reach an agent input, output, event or table. Nothing here creates an order, fill, position, approval card, approval or
 * risk-decision version.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  AgentRegistry, createProductionRegistry, getLatestAgentAssessment, historicalPatternAgent, independentChallengerAgent, liquidityAgent, signalIntegrityAgent, type AgentDefinition, type OutcomeDistribution, type PatternMatch, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, type AgentEvent, type AgentRulesConfig, type InstrumentRecord, type HistoricalOutcomeProvider, type HistoricalPatternProvider, type OhlcProvider,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { economicCalendar, holidayCalendar, macroProvider } from "../../support/calendarMacroFixtures";
import { constituentSet, constituents, newsFeed, rulesWithNews } from "../../support/newsConstituentFixtures";
import { ohlc, uptrendBars } from "../../support/ohlcFixtures";
import { goodQuote, quotes } from "../../support/quoteFixtures";
import { FEATURES, keysOf, outcome, pattern, rulesWithHistory, trendingBars } from "../../support/agentHistoryFixtures";
import { NOW } from "../../support/agentFixtures";
import { randomLetters } from "../../support/randomLetters";
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
const LIVE = ["orders", "fills", "positions", "risk_approvals", "risk_approval_cards", "decisions", "claim_review_cards", "telegram_intake_outbox", "risk_decisions", "signals"];
const clock = (d: Date = NOW) => ({ now: () => d, sleep: async () => undefined });

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); state = inMemoryStateSource(); configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 }); });
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));
const synthetic: IntelligenceResolver = async (req) => ({ ...(validIntelligence() as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(randomUUID()).digest("hex") });

interface Made { id: string; symbol: string }
/** A synthetic decision whose signal was sent one minute before the fixed engine clock. */
async function make(o: { symbol?: string; instrumentType?: string; expiry?: string | null; strike?: number | null; optionType?: string | null; side?: "BUY" | "SELL" } = {}): Promise<Made> {
  const symbol = o.symbol ?? `HC${randomLetters(8)}`;
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: o.instrumentType ?? "equity" }).returning();
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const sentAt = new Date(NOW.getTime() - 60_000);
  const [msg] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: sfx(), messageTimestamp: sentAt, rawText: `${MARKER} BUY ${symbol} @ 100 SL 95`, rawPayload: { marker: MARKER } }).returning();
  const side = o.side ?? "BUY";
  const entry = 100, stop = side === "BUY" ? 95 : 105, targets = side === "BUY" ? [105, 110] : [95, 90];
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", telegramMessageId: must(msg).id, instrumentId: must(instrument).id, parserVersion: "cm-test", direction: side.toLowerCase(), entryPrice: String(entry), stopLoss: String(stop), targets, signalTimestamp: sentAt }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: String(stop), entryPrice: String(entry), riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `cm-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: o.instrumentType ?? "equity", market: "NSE", symbol,
    ...(o.expiry !== undefined ? { expiry: o.expiry } : {}), ...(o.strike !== undefined ? { strike: o.strike } : {}), ...(o.optionType !== undefined ? { optionType: o.optionType } : {}),
    side, entryPrice: entry, stopLoss: stop, stopLossBasis: "price", target1: targets[0] ?? null, target2: targets[1] ?? null, decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { synthetic: true }, outputSnapshot: { stage: "risk_decision_foundation" },
  };
  const v1 = await createRiskDecision(db(), input);
  const v2 = await recordSourceIntelligence(db(), v1.id, { resolve: synthetic });
  return { id: v2.id, symbol };
}const HC = ["historical-pattern-v1", "independent-challenger-v1", "liquidity-v1", "signal-integrity-v1"];
// Task 7 scope: the challenger reads every agent that is registered, so this file registers a small, real research set (signal integrity, liquidity, historical pattern) plus the challenger; the "all twelve" test uses the production registry.
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: HC.join(",") }), disabledAgents: [] as string[] };
const ALL12 = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), maxConcurrency: 12 }; // the real default path: all twelve production agents REQUIRED
const LIVE_TABLES = LIVE;

/** Dynamic providers: the engine derives the real pattern keys from the stored decision, so these answer for whatever level-4 key is asked. */
const dynPatterns = (mk: (key: string, level: number) => PatternMatch = (key, level) => pattern({ keyText: key, level }), name = "synthetic-patterns"): HistoricalPatternProvider => ({
  name, asOf: null, patterns: async ({ keys }) => [mk(keys[3] as string, 4)],
});
const dynOutcomes = (mk: (key: string) => OutcomeDistribution = (key) => outcome({ keyText: key })): HistoricalOutcomeProvider => ({ name: "synthetic-outcomes", outcomes: async ({ keyText }) => mk(keyText) });
interface Providers { patterns?: HistoricalPatternProvider | null; outcomes?: HistoricalOutcomeProvider | null; ohlc?: OhlcProvider | null; extra?: AgentDefinition[]; rules?: AgentRulesConfig }
const registry = (d: Made, p: Providers = {}): AgentRegistry => {
  const rules = p.rules ?? rulesWithHistory();
  const r = new AgentRegistry();
  r.register(signalIntegrityAgent(rules));
  r.register(liquidityAgent(rules, quotes(goodQuote(), `NSE:${d.symbol}`), null));
  r.register(historicalPatternAgent(rules, p.patterns === undefined ? dynPatterns() : p.patterns, p.outcomes === undefined ? dynOutcomes() : p.outcomes, p.ohlc === undefined ? ohlc(trendingBars(), { symbol: d.symbol }) : p.ohlc, null));
  for (const e of p.extra ?? []) r.register(e);
  r.register(independentChallengerAgent(rules, r.snapshot().map((c) => c.agentId)));
  return r;
};
const run = async (d: Made, p: Providers = {}, o: { emit?: (e: AgentEvent) => void; config?: typeof ENGINE } = {}) => {
  const out = await runAgentEngine(db(), d.id, { registry: registry(d, p), config: o.config ?? ENGINE, ...(o.emit ? { emit: o.emit } : {}), ...clock() });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const codes = async (runId: string, agent: string) => (await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = $2", [runId, agent])).map((r) => r["code"] as string);
const verdictsOf = async (d: Made) => Object.fromEntries(must(await getLatestAgentAssessment(db(), d.id)).agents.map((x) => [x.agentId, x.verdict]));
/** A research agent that records the WRONG direction for the signal (to prove the challenger notices a mis-wired result). */
const wrongWay: AgentDefinition = {
  contract: { agentId: "mis-wired-v1", agentName: "mis-wired", version: "1.0.0", requiredInputs: ["risk_decision"], optionalInputs: [], outputSchema: { fields: { checksRun: { type: "number", required: true }, blockingCount: { type: "number", required: true }, adverseCount: { type: "number", required: true }, cautionCount: { type: "number", required: true }, failedCodes: { type: "string[]", required: true }, truncatedFindings: { type: "boolean", required: true }, direction: { type: "string" } } }, timeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 10, canBlock: false, advisoryOnly: false, dependsOn: [] },
  async run() { return { verdict: "NEUTRAL", confidence: 60, findings: [], evidence: [{ kind: "risk_decision", ref: "risk_decision:x" }], output: { checksRun: 1, blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false, direction: "BEARISH" } }; },
};
void FEATURES; void keysOf;

describe("clean conditions: independent agents run in parallel, the challenger afterwards, nothing is approved", () => {
  it("supportive history: all supportive, outputs validated and persisted, the challenger runs AFTER its dependencies, assessment SUPPORTIVE, not halted", async () => {
    const d = await make();
    const live = await counts(LIVE_TABLES);
    const events: AgentEvent[] = [];
    const slow: HistoricalPatternProvider = { ...dynPatterns(), patterns: async (x) => { await new Promise((r) => setTimeout(r, 60)); return dynPatterns().patterns(x); } };
    const out = await run(d, { patterns: slow }, { emit: (e) => events.push(e) });
    expect(await verdictsOf(d)).toEqual({ "historical-pattern-v1": "SUPPORTIVE", "independent-challenger-v1": "SUPPORTIVE", "liquidity-v1": "SUPPORTIVE", "signal-integrity-v1": "SUPPORTIVE" });
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 4 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:historical-pattern-v1", "agent.started:liquidity-v1", "agent.started:signal-integrity-v1"]); // the independent agents run in parallel
    const chStart = types.indexOf("agent.started:independent-challenger-v1");
    for (const id of ["historical-pattern-v1", "liquidity-v1", "signal-integrity-v1"]) expect(types.indexOf(`agent.finished:${id}`), id).toBeLessThan(chStart); // the challenger starts only after every dependency finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(runs["historical-pattern-v1"]!["output_snapshot"]).toMatchObject({ patternProvider: "synthetic-patterns", patternLevel: 4, sampleSize: 120, entered: 100, wins: 65, winRate: 0.65, currentRegime: "TRENDING", blockingCount: 0 });
    expect(runs["independent-challenger-v1"]!["output_snapshot"]).toMatchObject({ expectedDirection: "BULLISH", dependencyCount: 3, assessedCount: 3, supportiveAgents: 3, adverseAgents: 0, blockingCount: 0 });
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id = any($1) group by 1,2 order by 1", [HC.slice(0, 2)])).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["historical-pattern-v1@1.0.0", "independent-challenger-v1@1.0.0"]);
    expect(must((await q("select contract from agent_definitions where agent_id = 'independent-challenger-v1' limit 1"))[0])["contract"]).toMatchObject({ weight: 30, canBlock: true, dependsOn: ["historical-pattern-v1", "liquidity-v1", "signal-integrity-v1"] });
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(HC);
    expect(await counts(LIVE_TABLES)).toEqual(live); // nothing created; a supportive assessment approves nothing
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("all TWELVE production agents run through the default required set: eleven independent agents in one level, the challenger after them", async () => {
    const d = await make();
    const ref = memoryInstrumentReference({ name: "synthetic", asOf: NOW.toISOString(), markets: ["NSE"], instruments: [{ market: "NSE", underlying: d.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true } satisfies InstrumentRecord] });
    const events: AgentEvent[] = [];
    const reg = createProductionRegistry({
      rules: rulesWithNews({ constituent: { indexUnderlyings: [d.symbol] } }), instrumentReference: ref, holidayCalendar: holidayCalendar(), economicCalendar: economicCalendar(), macroProvider: macroProvider(), newsProvider: newsFeed(),
      constituentProvider: constituents(constituentSet({ index: d.symbol })), ohlcProvider: ohlc(uptrendBars(), { symbol: d.symbol }), quoteProvider: quotes(goodQuote(), `NSE:${d.symbol}`),
      historicalPatternProvider: dynPatterns(), historicalOutcomeProvider: dynOutcomes(),
    });
    const out = await runAgentEngine(db(), d.id, { registry: reg, config: ALL12, emit: (e) => events.push(e), ...clock() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ status: "COMPLETED", agents: 12 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).length).toBe(11);
    const chStart = types.indexOf("agent.started:independent-challenger-v1");
    expect(types.slice(0, chStart).filter((t) => t.startsWith("agent.finished")).length).toBe(11);
    expect((await q("select status from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => r["status"])).toEqual(Array(12).fill("COMPLETED"));
    expect((await q("select output_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = 'independent-challenger-v1'", [out.runId]))[0]!["output_snapshot"]).toMatchObject({ dependencyCount: 11 });
  });
});

describe("a BLOCKING verdict halts the flow at the existing halt point", () => {
  const blocked = async (d: Made, p: Providers) => {
    const live = await counts(LIVE_TABLES);
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, status: "COMPLETED" });
    expect(await counts(LIVE_TABLES)).toEqual(live); // halting creates nothing: the decision stays PENDING
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    return out;
  };
  it("a critical adverse pattern BLOCKS (historical-pattern) when configured; by default it halts as ADVERSE; the challenger still completes", async () => {
    const crit = dynOutcomes((key) => outcome({ keyText: key, wins: 8, losses: 92, netExpectancyR: -0.5, netExpectancyLowerBoundR: -0.7 }));
    const d1 = await make();
    const adverse = await run(d1, { outcomes: crit });
    expect(adverse).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(adverse.runId, "historical-pattern-v1")).toContain("HISTORICAL_CRITICAL_ADVERSE");
    const d2 = await make();
    const out = await blocked(d2, { outcomes: crit, rules: rulesWithHistory({ historical: { criticalSeverity: "BLOCKING" } }) });
    expect((await verdictsOf(d2))["historical-pattern-v1"]).toBe("BLOCKING");
    expect((await verdictsOf(d2))["independent-challenger-v1"]).toBeDefined();
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ grantsApproval: false });
  });
  it("strong adverse history halts as ADVERSE (the win-rate upper bound below 35% with a non-positive expectancy)", async () => {
    const d = await make();
    const out = await run(d, { outcomes: dynOutcomes((key) => outcome({ keyText: key, wins: 15, losses: 85, netExpectancyR: -0.3, netExpectancyLowerBoundR: -0.45 })) });
    expect(out).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(out.runId, "historical-pattern-v1")).toContain("WIN_RATE_ADVERSE");
    expect(await codes(out.runId, "independent-challenger-v1")).toContain("AGENT_CONTRADICTION");
  });
  it("the challenger BLOCKS on a critical contradiction of the recorded results (a result with the wrong direction)", async () => {
    const d = await make();
    const out = await blocked(d, { extra: [wrongWay] });
    expect((await verdictsOf(d))["independent-challenger-v1"]).toBe("BLOCKING");
    expect(await codes(out.runId, "independent-challenger-v1")).toContain("DIRECTION_INCOHERENT");
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "independent-challenger-v1" }] });
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  const incomplete = async (d: Made, p: Providers, code: string) => {
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    expect((await q("select status, verdict, confidence, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = 'historical-pattern-v1'", [out.runId]))[0]).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: code });
    // the challenger never reasons over a missing result
    expect((await q("select status, verdict, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = 'independent-challenger-v1'", [out.runId]))[0]).toMatchObject({ status: "SKIPPED", verdict: "UNAVAILABLE", error_code: "DEPENDENCY_NOT_COMPLETED" });
    return out;
  };
  it("no providers => UNAVAILABLE => the challenger is SKIPPED => INCOMPLETE and halt (never a pass)", async () => { await incomplete(await make(), { patterns: null }, "PATTERN_PROVIDER_NOT_CONFIGURED"); await incomplete(await make(), { outcomes: null }, "OUTCOME_PROVIDER_NOT_CONFIGURED"); });
  it("a throwing provider, an insufficient sample and stale data are UNAVAILABLE; the provider's message is never stored", async () => {
    const d = await make();
    const a = await incomplete(d, { patterns: { name: "x", asOf: null, patterns: async () => { throw new Error(`down ${MARKER}`); } } }, "PATTERN_PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(await q("select error_message from agent_runs where orchestrator_run_id = $1", [a.runId]))).not.toContain(MARKER);
    await incomplete(await make(), { patterns: dynPatterns((key, level) => pattern({ keyText: key, level, sampleSize: 5 })) }, "INSUFFICIENT_SAMPLE");
    await incomplete(await make(), { patterns: dynPatterns((key, level) => pattern({ keyText: key, level, asOf: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() })), outcomes: dynOutcomes((key) => outcome({ keyText: key, asOf: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() })) }, "HISTORICAL_DATA_TOO_OLD");
    await incomplete(await make(), { patterns: dynPatterns((key, level) => pattern({ keyText: key, level, regimeMix: { TRENDING: 2, RANGE: 0 } })) }, "PATTERN_DATA_MALFORMED");
  });
  it("the kill switch refuses before any agent runs", async () => {
    const d = await make();
    state.set({ KILL_SWITCH_ACTIVE: true });
    const before = await counts(CHAINS);
    await expect(runAgentEngine(db(), d.id, { registry: registry(d), config: ENGINE, ...clock() })).rejects.toMatchObject({ code: "safety_refused" });
    expect(await counts(CHAINS)).toEqual(before);
  });
});

describe("privacy, inertness and idempotency", () => {
  it("the marker text of the stored messages appears in no agent input, output, finding, evidence reference, synthesis or event; each agent receives only its declared inputs", async () => {
    const d = await make();
    const events: AgentEvent[] = [];
    const out = await run(d, {}, { emit: (e) => events.push(e) });
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    const own = async (agent: string) => Object.keys(must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0])["input_snapshot"]).sort();
    expect(await own("historical-pattern-v1")).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence"]);
    expect(await own("independent-challenger-v1")).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
  });
  it("is idempotent for the same decision, configuration and clock without re-running the providers", async () => {
    const d = await make();
    let calls = 0;
    const base = dynPatterns();
    const counting: HistoricalPatternProvider = { ...base, patterns: async (x) => { calls += 1; return base.patterns(x); } };
    const first = await run(d, { patterns: counting });
    const again = await run(d, { patterns: counting });
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(calls).toBe(1);
  });
  it("makes no external network call: fetch is never used while the agents run", async () => {
    const d = await make();
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { seen.push(String(a[0])); throw new Error("fetch must not be used"); }) as typeof fetch;
    try { await run(d); } finally { globalThis.fetch = real; }
    expect(seen).toEqual([]);
  });
});
