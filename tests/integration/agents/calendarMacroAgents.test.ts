/**
 * The Market Calendar and Macro/Global agents (market-calendar-v1, macro-global-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 3). Synthetic risk decisions and
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
  createProductionRegistry, DEFAULT_AGENT_RULES, getLatestAgentAssessment, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, type AgentEvent, type EconomicCalendarProvider, type HolidayCalendarProvider, type InstrumentRecord,
  type MacroContextProvider,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { at, economicCalendar, event, holidayCalendar, macroProvider, snapshot } from "../../support/calendarMacroFixtures";
import { NOW } from "../../support/agentFixtures";
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
const CM = ["macro-global-v1", "market-calendar-v1"];
// Task 3 scope: calendar + macro are required, the Task 2 agents are switched off here (covered by productionAgents.test.ts); the "all four" test enables everything.
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: CM.join(",") }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "instrument-verification-v1", "liquidity-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1", "market-context-v1"] };
const ALL4 = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "instrument-verification-v1,macro-global-v1,market-calendar-v1,signal-integrity-v1" }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "liquidity-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "technical-structure-v1", "market-context-v1"] };
const clock = (d: Date = NOW) => ({ now: () => d, sleep: async () => undefined });

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); state = inMemoryStateSource(); configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 }); });
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));
const synthetic: IntelligenceResolver = async (req) => ({ ...(validIntelligence() as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(randomUUID()).digest("hex") });
const slow = <T extends object>(p: T, ms: number, methods: string[]): T => {
  const o = { ...p } as Record<string, unknown>;
  for (const m of methods) { const f = (p as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!; o[m] = async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, ms)); return f.apply(p, a); }; }
  return o as T;
};

interface Made { id: string; symbol: string }
/** A synthetic decision whose signal was sent one minute before the fixed engine clock. */
async function make(o: { instrumentType?: string; expiry?: string | null; strike?: number | null; optionType?: string | null; side?: "BUY" | "SELL" } = {}): Promise<Made> {
  const symbol = `CM${sfx()}`.toUpperCase().replace(/[0-9]/g, (d) => String.fromCharCode(71 + Number(d)));
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
}
interface Providers { holidayCalendar?: HolidayCalendarProvider | null; economicCalendar?: EconomicCalendarProvider | null; macroProvider?: MacroContextProvider | null }
const registry = (p: Providers = {}) => createProductionRegistry({
  rules: DEFAULT_AGENT_RULES, holidayCalendar: p.holidayCalendar === undefined ? holidayCalendar() : p.holidayCalendar, economicCalendar: p.economicCalendar === undefined ? economicCalendar() : p.economicCalendar,
  macroProvider: p.macroProvider === undefined ? macroProvider() : p.macroProvider,
});
const run = async (d: Made, p: Providers = {}, o: { config?: typeof ENGINE; at?: Date; emit?: (e: AgentEvent) => void } = {}) => {
  const out = await runAgentEngine(db(), d.id, { registry: registry(p), config: o.config ?? ENGINE, ...(o.emit ? { emit: o.emit } : {}), ...clock(o.at) });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const codes = async (runId: string, agent: string) => (await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = $2", [runId, agent])).map((r) => r["code"] as string);

describe("clean conditions: both agents run in parallel, persist and approve nothing", () => {
  it("an open market with calm macro context: both SUPPORTIVE, run IN PARALLEL, outputs validated and persisted, assessment SUPPORTIVE, not halted", async () => {
    const d = await make();
    const live = await counts(LIVE);
    const events: AgentEvent[] = [];
    const out = await run(d, { holidayCalendar: slow(holidayCalendar(), 60, ["day"]), macroProvider: slow(macroProvider(), 60, ["context"]) }, { emit: (e) => events.push(e) });
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 2 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:macro-global-v1", "agent.started:market-calendar-v1"]); // both started before either finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(Object.keys(runs).sort()).toEqual(CM);
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(runs["market-calendar-v1"]!["output_snapshot"]).toMatchObject({ sessionState: "OPEN", minutesToClose: 355, eventsConsidered: 0, holidayCalendar: "synthetic-holidays", blockingCount: 0 });
    expect(runs["macro-global-v1"]!["output_snapshot"]).toMatchObject({ direction: "BULLISH", indexSymbol: "SYNTHIDX", trendPct: 2.0833, provider: "synthetic-macro", failedCodes: [] });
    expect((await q("select count(*)::int as n from agent_evidence_references where agent_run_id = any($1)", [Object.values(runs).map((r) => r["id"])]))[0]!["n"]).toBeGreaterThanOrEqual(5);
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id = any($1) group by 1,2 order by 1", [CM])).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["macro-global-v1@1.0.0", "market-calendar-v1@1.0.0"]);
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(CM);
    expect(await counts(LIVE)).toEqual(live); // nothing created; a supportive assessment approves nothing
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("all FOUR production agents run in one parallel level through the default required set", async () => {
    const d = await make();
    const ref = memoryInstrumentReference({ name: "synthetic", asOf: NOW.toISOString(), markets: ["NSE"], instruments: [{ market: "NSE", underlying: d.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true } satisfies InstrumentRecord] });
    const events: AgentEvent[] = [];
    const reg = createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: ref, holidayCalendar: slow(holidayCalendar(), 40, ["day"]), economicCalendar: economicCalendar(), macroProvider: slow(macroProvider(), 40, ["context"]) });
    const out = await runAgentEngine(db(), d.id, { registry: reg, config: ALL4, emit: (e) => events.push(e), ...clock() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 4 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).length).toBe(4);
    expect(must(await getLatestAgentAssessment(db(), d.id)).agents.map((a) => `${a.agentId}:${a.verdict}`)).toEqual(["instrument-verification-v1:SUPPORTIVE", "macro-global-v1:SUPPORTIVE", "market-calendar-v1:SUPPORTIVE", "signal-integrity-v1:SUPPORTIVE"]);
  });
});

describe("a BLOCKING verdict halts the flow at the existing halt point", () => {
  const blocked = async (d: Made, p: Providers, at?: Date) => {
    const live = await counts(LIVE);
    const out = await run(d, p, { ...(at ? { at } : {}) });
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, status: "COMPLETED" });
    expect(await counts(LIVE)).toEqual(live); // halting creates nothing: the decision stays PENDING
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    return out;
  };
  it("a weekend: the calendar agent BLOCKS while the macro agent still completes independently", async () => {
    const d = await make();
    const out = await blocked(d, {}, new Date("2025-01-04T05:00:00.000Z"));
    const a = must(await getLatestAgentAssessment(db(), d.id));
    expect(Object.fromEntries(a.agents.map((x) => [x.agentId, x.verdict]))).toMatchObject({ "market-calendar-v1": "BLOCKING" });
    expect(await codes(out.runId, "market-calendar-v1")).toContain("MARKET_WEEKEND");
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "market-calendar-v1" }], grantsApproval: false });
  });
  it("a holiday, a closed market and an unknown market BLOCK", async () => {
    expect(await codes((await blocked(await make(), {}, new Date("2025-03-14T05:00:00.000Z"))).runId, "market-calendar-v1")).toContain("MARKET_HOLIDAY");
    expect(await codes((await blocked(await make(), {}, new Date("2025-01-06T11:00:00.000Z"))).runId, "market-calendar-v1")).toContain("MARKET_CLOSED");
    const d = await make();
    // (the unknown market is exercised by configuring sessions that do not include NSE)
    const out = await runAgentEngine(db(), d.id, { registry: createProductionRegistry({ rules: { ...DEFAULT_AGENT_RULES, calendar: { ...DEFAULT_AGENT_RULES.calendar, sessions: { LSE: { utcOffsetMinutes: 0, open: "08:00", close: "16:30" } } } }, holidayCalendar: holidayCalendar(), economicCalendar: economicCalendar(), macroProvider: macroProvider() }), config: ENGINE, ...clock() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true });
    expect(await codes(out.runId, "market-calendar-v1")).toContain("MARKET_UNKNOWN");
  });
  it("a critical event inside the blackout BLOCKS; a high-impact event nearby halts as ADVERSE; a medium event only cautions", async () => {
    const out = await blocked(await make(), { economicCalendar: economicCalendar([event({ minutes: 30, impact: "CRITICAL", name: "Synthetic policy decision" })]) });
    expect(await codes(out.runId, "market-calendar-v1")).toContain("CRITICAL_EVENT_BLACKOUT");
    const high = await run(await make(), { economicCalendar: economicCalendar([event({ minutes: 60, impact: "HIGH" })]) });
    expect(high).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true }); // the default halt rule also stops ADVERSE assessments
    const medium = await run(await make(), { economicCalendar: economicCalendar([event({ minutes: 90, impact: "MEDIUM" })]) });
    expect(medium.halt).toBe(false);
    expect(await codes(medium.runId, "market-calendar-v1")).toContain("MEDIUM_IMPACT_EVENT");
  });
  it("an option expiring today only cautions; an expired one BLOCKS", async () => {
    const today = await run(await make({ instrumentType: "option", expiry: "2025-01-06", strike: 24500, optionType: "CE" }));
    expect(today.halt).toBe(false);
    expect(await codes(today.runId, "market-calendar-v1")).toContain("EXPIRY_DAY");
    const past = await blocked(await make({ instrumentType: "option", expiry: "2025-01-03", strike: 24500, optionType: "CE" }), {});
    expect(await codes(past.runId, "market-calendar-v1")).toContain("EXPIRY_PASSED");
  });
  it("extreme volatility and an imminent critical release BLOCK through the macro agent", async () => {
    const vol = await blocked(await make(), { macroProvider: macroProvider(snapshot({ volatilityIndex: { name: "SYNTHVIX", level: 45, changePct1d: 3 } })) });
    expect(await codes(vol.runId, "macro-global-v1")).toContain("VOLATILITY_EXTREME");
    const rel = await blocked(await make(), { macroProvider: macroProvider(snapshot({ releases: [event({ minutes: 20, impact: "CRITICAL" })] })) });
    expect(await codes(rel.runId, "macro-global-v1")).toContain("MACRO_RELEASE_IMMINENT");
  });
  it("a strong adverse macro context halts the flow as ADVERSE (BUY into a falling market) and a bearish signal in the same market does not", async () => {
    const falling = snapshot({ index: { symbol: "SYNTHIDX", level: 23700, previousClose: 23900, open: 23900, recentCloses: [24300, 24250, 24200, 24100, 24000] } });
    const buy = await run(await make(), { macroProvider: macroProvider(falling) });
    expect(buy).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(buy.runId, "macro-global-v1")).toContain("TREND_CONFLICT_STRONG");
    const sell = await run(await make({ side: "SELL" }), { macroProvider: macroProvider(falling) });
    expect(sell.halt).toBe(false);
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  const unavailable = async (d: Made, p: Providers, agent: string, code: string) => {
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    expect((await q("select status, verdict, confidence, error_code, error_message from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0]).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: code });
    return out;
  };
  it("no holiday calendar / no economic calendar / no macro provider configured => UNAVAILABLE => INCOMPLETE and halt (never a pass)", async () => {
    await unavailable(await make(), { holidayCalendar: null }, "market-calendar-v1", "HOLIDAY_CALENDAR_NOT_CONFIGURED");
    await unavailable(await make(), { economicCalendar: null }, "market-calendar-v1", "ECONOMIC_CALENDAR_NOT_CONFIGURED");
    await unavailable(await make(), { macroProvider: null }, "macro-global-v1", "MACRO_PROVIDER_NOT_CONFIGURED");
  });
  it("providers that throw, calendars that do not cover the date, malformed calendar data and stale macro context are UNAVAILABLE; the provider's message is never stored", async () => {
    const boom = (): never => { throw new Error(`down ${MARKER}`); };
    const a = await unavailable(await make(), { holidayCalendar: { name: "x", asOf: null, day: async () => boom() } }, "market-calendar-v1", "CALENDAR_PROVIDER_UNAVAILABLE");
    const b = await unavailable(await make(), { macroProvider: { name: "x", context: async () => boom() } }, "macro-global-v1", "MACRO_PROVIDER_UNAVAILABLE");
    for (const o of [a, b]) expect(JSON.stringify(await q("select error_message from agent_runs where orchestrator_run_id = $1", [o.runId]))).not.toContain(MARKER);
    await unavailable(await make(), { economicCalendar: economicCalendar([{ id: "x" }]) }, "market-calendar-v1", "CALENDAR_DATA_MALFORMED");
    await unavailable(await make(), { holidayCalendar: holidayCalendar({ markets: { NSE: { from: "2020-01-01", to: "2020-12-31", days: [] } } }) }, "market-calendar-v1", "HOLIDAY_CALENDAR_DATE_NOT_COVERED");
    await unavailable(await make(), { macroProvider: macroProvider(snapshot({ asOf: at(-3000) })) }, "macro-global-v1", "MACRO_CONTEXT_TOO_OLD");
    await unavailable(await make(), { macroProvider: macroProvider(snapshot({ index: null })) }, "macro-global-v1", "MACRO_INDEX_MISSING");
  });
  it("the kill switch refuses before either agent runs", async () => {
    const d = await make();
    state.set({ KILL_SWITCH_ACTIVE: true });
    const before = await counts(CHAINS);
    await expect(runAgentEngine(db(), d.id, { registry: registry(), config: ENGINE, ...clock() })).rejects.toMatchObject({ code: "safety_refused" });
    expect(await counts(CHAINS)).toEqual(before);
  });
});

describe("privacy, inertness and idempotency", () => {
  it("the marker text of the stored messages appears in no agent input, output, finding, evidence reference, synthesis or event; the inputs are the closed parsed-field set", async () => {
    const d = await make();
    const events: AgentEvent[] = [];
    const out = await run(d, { economicCalendar: economicCalendar([event({ minutes: 90, impact: "MEDIUM" })]) }, { emit: (e) => events.push(e) });
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    const calendarInput = must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = 'market-calendar-v1'", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(calendarInput).sort()).toEqual(["risk_decision", "signal_context"]); // only what the contract declares
    const macroInput = must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = 'macro-global-v1'", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(macroInput).sort()).toEqual(["risk_decision", "signal_features", "source_intelligence"]);
  });
  it("is idempotent for the same decision, configuration and clock without re-running the providers", async () => {
    const d = await make();
    let calls = 0;
    const m = macroProvider();
    const counting = { ...m, context: async (x: Parameters<MacroContextProvider["context"]>[0]) => { calls += 1; return m.context(x); } };
    const first = await run(d, { macroProvider: counting });
    const again = await run(d, { macroProvider: counting });
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(calls).toBe(1);
  });
  it("makes no external network call: fetch is never used and the guard records no blocked connection while the agents run", async () => {
    const d = await make();
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { seen.push(String(a[0])); throw new Error("fetch must not be used"); }) as typeof fetch;
    try { await run(d, { economicCalendar: economicCalendar([event({ minutes: 90, impact: "MEDIUM" })]) }); } finally { globalThis.fetch = real; }
    expect(seen).toEqual([]);
  });
});
