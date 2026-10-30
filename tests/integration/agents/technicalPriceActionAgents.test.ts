/**
 * The Technical Structure and Price-Action agents (technical-structure-v1, price-action-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 5). Synthetic risk decisions and
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
  createProductionRegistry, getLatestAgentAssessment, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, type AgentEvent, type AgentRulesConfig, type Candle, type InstrumentRecord, type LastPriceProvider, type OhlcProvider,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { economicCalendar, holidayCalendar, macroProvider } from "../../support/calendarMacroFixtures";
import { constituentSet, constituents, newsFeed, rulesWithNews } from "../../support/newsConstituentFixtures";
import { candle, fromCloses, lastPrice, ohlc, quiet, rulesWithOhlc, uptrendBars, wave } from "../../support/ohlcFixtures";
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
const TP = ["price-action-v1", "technical-structure-v1"];
// Task 5 scope: technical + price-action are required, the earlier agents are switched off here (covered by their own files); the "all eight" test enables everything.
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: TP.join(",") }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "instrument-verification-v1", "macro-global-v1", "market-calendar-v1", "liquidity-v1", "news-sentiment-v1", "options-risk-v1", "signal-integrity-v1"] };
const ALL8 = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "index-constituent-impact-v1,instrument-verification-v1,macro-global-v1,market-calendar-v1,news-sentiment-v1,price-action-v1,signal-integrity-v1,technical-structure-v1" }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "liquidity-v1", "options-risk-v1"], maxConcurrency: 8 }; // the eight Task 2-5 production agents REQUIRED (concurrency raised from the default 4)
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
  const symbol = o.symbol ?? `TP${randomLetters(8)}`;
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
interface Providers { ohlc?: OhlcProvider | null; price?: LastPriceProvider | null }
const registry = (d: Made, p: Providers = {}, rules: AgentRulesConfig = rulesWithOhlc()) => createProductionRegistry({
  rules, ohlcProvider: p.ohlc === undefined ? ohlc(uptrendBars(), { symbol: d.symbol }) : p.ohlc, lastPriceProvider: p.price === undefined ? null : p.price,
});
const run = async (d: Made, p: Providers = {}, o: { emit?: (e: AgentEvent) => void; rules?: AgentRulesConfig } = {}) => {
  const out = await runAgentEngine(db(), d.id, { registry: registry(d, p, o.rules), config: ENGINE, ...(o.emit ? { emit: o.emit } : {}), ...clock() });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const codes = async (runId: string, agent: string) => (await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = $2", [runId, agent])).map((r) => r["code"] as string);
const verdictsOf = async (d: Made) => Object.fromEntries(must(await getLatestAgentAssessment(db(), d.id)).agents.map((x) => [x.agentId, x.verdict]));

describe("clean conditions: both agents run in parallel, persist and approve nothing", () => {
  it("an aligned uptrend: both SUPPORTIVE, run IN PARALLEL, outputs validated and persisted, assessment SUPPORTIVE, not halted", async () => {
    const d = await make();
    const live = await counts(LIVE);
    const events: AgentEvent[] = [];
    const slowOhlc = ((): OhlcProvider => { const base = ohlc(uptrendBars(), { symbol: d.symbol }); return { ...base, candles: async (x) => { await new Promise((r) => setTimeout(r, 60)); return base.candles(x); } }; })();
    const out = await run(d, { ohlc: slowOhlc }, { emit: (e) => events.push(e) });
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 2 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:price-action-v1", "agent.started:technical-structure-v1"]); // both started before either finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(Object.keys(runs).sort()).toEqual(TP);
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(runs["technical-structure-v1"]!["output_snapshot"]).toMatchObject({ direction: "BULLISH", provider: "synthetic-ohlc", barsUsed: 70, regime: "TRENDING", blockingCount: 0 });
    expect(runs["price-action-v1"]!["output_snapshot"]).toMatchObject({ direction: "BULLISH", runLength: 3, runDirection: "UP", blockingCount: 0 });
    expect((await q("select count(*)::int as n from agent_evidence_references where agent_run_id = any($1)", [Object.values(runs).map((r) => r["id"])]))[0]!["n"]).toBeGreaterThanOrEqual(4);
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id = any($1) group by 1,2 order by 1", [TP])).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["price-action-v1@1.0.0", "technical-structure-v1@1.0.0"]);
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(TP);
    expect(await counts(LIVE)).toEqual(live); // nothing created; a supportive assessment approves nothing
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("all EIGHT production agents run in one parallel level through the default required set", async () => {
    const d = await make();
    const ref = memoryInstrumentReference({ name: "synthetic", asOf: NOW.toISOString(), markets: ["NSE"], instruments: [{ market: "NSE", underlying: d.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true } satisfies InstrumentRecord] });
    const events: AgentEvent[] = [];
    const reg = createProductionRegistry({
      rules: rulesWithNews({ constituent: { indexUnderlyings: [d.symbol] } }), instrumentReference: ref, holidayCalendar: holidayCalendar(), economicCalendar: economicCalendar(), macroProvider: macroProvider(), newsProvider: newsFeed(),
      constituentProvider: constituents(constituentSet({ index: d.symbol })), ohlcProvider: ohlc(uptrendBars(), { symbol: d.symbol }),
    });
    const out = await runAgentEngine(db(), d.id, { registry: reg, config: ALL8, emit: (e) => events.push(e), ...clock() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ status: "COMPLETED", agents: 8 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).length).toBe(8);
    const rows = await q("select agent_id, status from agent_runs where orchestrator_run_id = $1", [out.runId]);
    expect(rows.map((r) => r["status"])).toEqual(Array(8).fill("COMPLETED"));
  });
});

describe("a BLOCKING verdict halts the flow at the existing halt point", () => {
  const blocked = async (d: Made, p: Providers, rules?: AgentRulesConfig) => {
    const live = await counts(LIVE);
    const out = await run(d, p, rules ? { rules } : {});
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, status: "COMPLETED" });
    expect(await counts(LIVE)).toEqual(live); // halting creates nothing: the decision stays PENDING
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    return out;
  };
  it("price already through the stop-loss BLOCKS (technical structure); the price-action agent still completes independently", async () => {
    const d = await make(); // BUY with a stop of 95
    const out = await blocked(d, { ohlc: ohlc(fromCloses(wave(70, 120, -0.5)), { symbol: d.symbol }) });
    expect((await verdictsOf(d))["technical-structure-v1"]).toBe("BLOCKING");
    expect(await codes(out.runId, "technical-structure-v1")).toContain("PRICE_THROUGH_STOP");
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "technical-structure-v1" }], grantsApproval: false });
  });
  it("a critical reversal at the recent extreme BLOCKS (price action) when configured to BLOCKING; by default it halts as ADVERSE", async () => {
    const run4 = Array.from({ length: 4 }, (_, i) => { const o = 100 + 0.5 * i; return candle(o, o + 0.85, o - 0.35, o + 0.5); });
    const bars: Candle[] = [...quiet(60, 100), ...run4, candle(102, 102.4, 99, 99.5)];
    const d1 = await make();
    const adverse = await run(d1, { ohlc: ohlc(bars, { symbol: d1.symbol }) });
    expect(adverse).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect((await codes(adverse.runId, "price-action-v1")).some((c) => c.endsWith("_EXHAUSTION_AGAINST"))).toBe(true);
    const d2 = await make();
    const out = await blocked(d2, { ohlc: ohlc(bars, { symbol: d2.symbol }) }, rulesWithOhlc({ priceAction: { criticalReversal: "BLOCKING" } }));
    expect((await verdictsOf(d2))["price-action-v1"]).toBe("BLOCKING");
    expect((await codes(out.runId, "price-action-v1")).some((c) => c.endsWith("_EXHAUSTION_AGAINST"))).toBe(true);
  });
  it("strong adverse structure halts as ADVERSE (a breakdown below the prior range) and a gap against the direction halts as ADVERSE", async () => {
    const d1 = await make();
    const breakdown = await run(d1, { ohlc: ohlc([...quiet(60, 100), candle(100, 100.5, 96, 96.5)], { symbol: d1.symbol }) });
    expect(breakdown).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(breakdown.runId, "technical-structure-v1")).toContain("BREAKDOWN_AGAINST");
    const d2 = await make();
    const gap = await run(d2, { ohlc: ohlc([...quiet(60, 100), candle(98, 98.5, 97.5, 98)], { symbol: d2.symbol }) });
    expect(gap.halt).toBe(true);
    expect(await codes(gap.runId, "price-action-v1")).toContain("GAP_AGAINST_LARGE");
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  const unavailable = async (d: Made, p: Providers, code: string) => {
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    for (const agent of TP) expect((await q("select status, verdict, confidence, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0]).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: code });
    return out;
  };
  it("no OHLC provider configured => both UNAVAILABLE => INCOMPLETE and halt (never a pass)", async () => { await unavailable(await make(), { ohlc: null }, "OHLC_PROVIDER_NOT_CONFIGURED"); });
  it("a throwing provider, no candles, too little history, a snapshot that is too old and a symbol mismatch are UNAVAILABLE; the provider's message is never stored", async () => {
    const d = await make();
    const a = await unavailable(d, { ohlc: { name: "x", asOf: null, candles: async () => { throw new Error(`down ${MARKER}`); } } }, "OHLC_PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(await q("select error_message from agent_runs where orchestrator_run_id = $1", [a.runId]))).not.toContain(MARKER);
    const d2 = await make();
    await unavailable(d2, { ohlc: ohlc(uptrendBars(), { symbol: "SOMETHINGELSE" }) }, "OHLC_DATA_NOT_AVAILABLE");
    const d3 = await make();
    await unavailable(d3, { ohlc: ohlc(uptrendBars().slice(-20), { symbol: d3.symbol }) }, "OHLC_HISTORY_INSUFFICIENT");
    const d4 = await make();
    await unavailable(d4, { ohlc: ohlc(uptrendBars(), { symbol: d4.symbol, asOf: new Date(NOW.getTime() - 3000 * 60_000).toISOString() }) }, "OHLC_SNAPSHOT_TOO_OLD");
    const d5 = await make();
    await unavailable(d5, { ohlc: { name: "x", asOf: null, candles: async () => ({ symbol: "OTHER", intervalSeconds: 86_400, bars: uptrendBars().map((b, i) => ({ ...b, t: new Date(Date.parse("2025-01-06T03:45:00Z") - (69 - i) * 86_400_000).toISOString() })) }) } }, "OHLC_SYMBOL_MISMATCH");
  });
  it("the kill switch refuses before either agent runs", async () => {
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
    const out = await run(d, { price: lastPrice(112, new Date(NOW.getTime() - 60_000).toISOString(), d.symbol) }, { emit: (e) => events.push(e) });
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    for (const agent of TP) {
      const own = must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0])["input_snapshot"];
      expect(Object.keys(own).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence"]);
    }
  });
  it("is idempotent for the same decision, configuration and clock without re-running the providers", async () => {
    const d = await make();
    let calls = 0;
    const base = ohlc(uptrendBars(), { symbol: d.symbol });
    const counting: OhlcProvider = { ...base, candles: async (x) => { calls += 1; return base.candles(x); } };
    const first = await run(d, { ohlc: counting });
    const again = await run(d, { ohlc: counting });
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(calls).toBe(2); // once per agent, none on the repeat
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
