/**
 * The Liquidity and Options Risk agents (liquidity-v1, options-risk-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 6). Synthetic risk decisions and
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
  createProductionRegistry, getLatestAgentAssessment, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, type AgentEvent, type AgentRulesConfig, type InstrumentRecord, type InstrumentQuote, type OptionChain, type OptionQuote, type OptionsChainProvider, type OptionsQuoteProvider, type QuoteProvider,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { economicCalendar, holidayCalendar, macroProvider } from "../../support/calendarMacroFixtures";
import { constituentSet, constituents, newsFeed, rulesWithNews } from "../../support/newsConstituentFixtures";
import { ohlc, uptrendBars } from "../../support/ohlcFixtures";
import { chains, goodChain, goodOption, goodQuote, optionQuotes, quotes, rulesWithQuotes } from "../../support/quoteFixtures";
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
const LO = ["liquidity-v1", "options-risk-v1"];
// Task 6 scope: liquidity + options risk are required, the earlier agents are switched off here (covered by their own files); the "all ten" test enables everything.
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: LO.join(",") }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "index-constituent-impact-v1", "instrument-verification-v1", "macro-global-v1", "market-calendar-v1", "news-sentiment-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1", "market-context-v1"] };
const ALL10 = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "index-constituent-impact-v1,instrument-verification-v1,liquidity-v1,macro-global-v1,market-calendar-v1,news-sentiment-v1,options-risk-v1,price-action-v1,signal-integrity-v1,technical-structure-v1" }), disabledAgents: ["historical-pattern-v1", "independent-challenger-v1", "market-context-v1"], maxConcurrency: 10 }; // the ten Task 2-6 production agents REQUIRED (concurrency raised from the default 4)
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
  const symbol = o.symbol ?? `LQ${randomLetters(8)}`;
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
}const OPT = { instrumentType: "option", expiry: "2025-01-30", strike: 24_500, optionType: "CE" } as const;
const optKey = (d: Made) => `NSE:${d.symbol}:2025-01-30:24500:CE`;
const chainKey = (d: Made) => `NSE:${d.symbol}:2025-01-30`;
interface Providers { quote?: QuoteProvider | null; option?: OptionsQuoteProvider | null; chain?: OptionsChainProvider | null }
/** Healthy providers for an option decision (entry premium 100, stop 95). */
const optionProviders = (d: Made, o: { quote?: Partial<InstrumentQuote>; option?: Partial<OptionQuote>; chain?: Partial<OptionChain> } = {}): Providers => ({
  quote: quotes(goodQuote({ bid: 99.5, ask: 100.5, last: 100, volume: 5000, avgVolume: 10_000, openInterest: 50_000, ...o.quote }), optKey(d)),
  option: optionQuotes(goodOption({ premium: 100, bid: 99.5, ask: 100.5, theta: -3, ...o.option }), optKey(d)), chain: chains(goodChain(o.chain), chainKey(d)),
});
const equityProviders = (d: Made, o: Partial<InstrumentQuote> = {}): Providers => ({ quote: quotes(goodQuote(o), `NSE:${d.symbol}`), option: null, chain: null });
const registry = (p: Providers, rules: AgentRulesConfig = rulesWithQuotes()) => createProductionRegistry({ rules, quoteProvider: p.quote ?? null, optionsQuoteProvider: p.option ?? null, optionsChainProvider: p.chain ?? null });
const run = async (d: Made, p: Providers, o: { emit?: (e: AgentEvent) => void; rules?: AgentRulesConfig } = {}) => {
  const out = await runAgentEngine(db(), d.id, { registry: registry(p, o.rules), config: ENGINE, ...(o.emit ? { emit: o.emit } : {}), ...clock() });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const codes = async (runId: string, agent: string) => (await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = $2", [runId, agent])).map((r) => r["code"] as string);
const verdictsOf = async (d: Made) => Object.fromEntries(must(await getLatestAgentAssessment(db(), d.id)).agents.map((x) => [x.agentId, x.verdict]));

describe("clean conditions: both agents run in parallel, persist and approve nothing", () => {
  it("a healthy option: both SUPPORTIVE, run IN PARALLEL, outputs validated and persisted, assessment SUPPORTIVE, not halted", async () => {
    const d = await make(OPT);
    const live = await counts(LIVE);
    const events: AgentEvent[] = [];
    const slow = (p: Providers): Providers => ({ ...p, quote: { ...(p.quote as QuoteProvider), quote: async (x) => { await new Promise((r) => setTimeout(r, 60)); return (p.quote as QuoteProvider).quote(x); } } });
    const out = await run(d, slow(optionProviders(d)), { emit: (e) => events.push(e) });
    expect(await verdictsOf(d)).toEqual({ "liquidity-v1": "SUPPORTIVE", "options-risk-v1": "SUPPORTIVE" });
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 2 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:liquidity-v1", "agent.started:options-risk-v1"]); // both started before either finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(Object.keys(runs).sort()).toEqual(LO);
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(runs["liquidity-v1"]!["output_snapshot"]).toMatchObject({ provider: "synthetic-quotes", instrumentType: "option", side: "BUY", spreadPct: 1, blockingCount: 0 });
    expect(runs["options-risk-v1"]!["output_snapshot"]).toMatchObject({ applicable: true, provider: "synthetic-option-quotes", optionType: "CE", strike: 24_500, premium: 100, iv: 15, blockingCount: 0 });
    expect((await q("select count(*)::int as n from agent_evidence_references where agent_run_id = any($1)", [Object.values(runs).map((r) => r["id"])]))[0]!["n"]).toBeGreaterThanOrEqual(4);
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id = any($1) group by 1,2 order by 1", [LO])).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["liquidity-v1@1.0.0", "options-risk-v1@1.0.0"]);
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(LO);
    expect(await counts(LIVE)).toEqual(live); // nothing created; a supportive assessment approves nothing
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });
  it("an equity signal: liquidity assesses it, options-risk is NEUTRAL and not applicable, nothing halts", async () => {
    const d = await make();
    const out = await run(d, equityProviders(d));
    expect(out.halt).toBe(false);
    expect(await verdictsOf(d)).toEqual({ "liquidity-v1": "SUPPORTIVE", "options-risk-v1": "NEUTRAL" });
    expect((await q("select output_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = 'options-risk-v1'", [out.runId]))[0]!["output_snapshot"]).toMatchObject({ applicable: false });
    expect(await codes(out.runId, "options-risk-v1")).toEqual(["NOT_AN_OPTION"]);
  });
  it("all TEN production agents run in one parallel level through the default required set", async () => {
    const d = await make();
    const ref = memoryInstrumentReference({ name: "synthetic", asOf: NOW.toISOString(), markets: ["NSE"], instruments: [{ market: "NSE", underlying: d.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true } satisfies InstrumentRecord] });
    const events: AgentEvent[] = [];
    const p = equityProviders(d);
    const reg = createProductionRegistry({
      rules: rulesWithNews({ constituent: { indexUnderlyings: [d.symbol] } }), instrumentReference: ref, holidayCalendar: holidayCalendar(), economicCalendar: economicCalendar(), macroProvider: macroProvider(), newsProvider: newsFeed(),
      constituentProvider: constituents(constituentSet({ index: d.symbol })), ohlcProvider: ohlc(uptrendBars(), { symbol: d.symbol }), quoteProvider: p.quote ?? null,
    });
    const out = await runAgentEngine(db(), d.id, { registry: reg, config: ALL10, emit: (e) => events.push(e), ...clock() });
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ status: "COMPLETED", agents: 10 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).length).toBe(10);
    expect((await q("select status from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => r["status"])).toEqual(Array(10).fill("COMPLETED"));
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
  it("an extreme bid/ask spread BLOCKS (liquidity); the options-risk agent still completes independently", async () => {
    const d = await make();
    const out = await blocked(d, equityProviders(d, { bid: 90, ask: 100, last: 95 }));
    expect((await verdictsOf(d))["liquidity-v1"]).toBe("BLOCKING");
    expect(await codes(out.runId, "liquidity-v1")).toContain("SPREAD_EXTREME");
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "liquidity-v1" }], grantsApproval: false });
  });
  it("no displayed depth on the side the signal needs BLOCKS (liquidity)", async () => {
    const d = await make();
    const out = await blocked(d, equityProviders(d, { askDepth: 0 }));
    expect(await codes(out.runId, "liquidity-v1")).toContain("NO_DEPTH");
  });
  it("an extreme implied volatility BLOCKS (options-risk) when configured that way by default; ADVERSE when configured", async () => {
    const d = await make(OPT);
    const hot = optionProviders(d, { option: { iv: 130, ivPrevious: 129 }, chain: { rows: [{ strike: 24_500, optionType: "CE", iv: 130, openInterest: 5000, volume: 100 }] } });
    const out = await blocked(d, hot);
    expect((await verdictsOf(d))["options-risk-v1"]).toBe("BLOCKING");
    expect(await codes(out.runId, "options-risk-v1")).toContain("IV_EXTREME");
    const d2 = await make(OPT);
    const soft = await run(d2, optionProviders(d2, { option: { iv: 130, ivPrevious: 129 }, chain: { rows: [{ strike: 24_500, optionType: "CE", iv: 130, openInterest: 5000, volume: 100 }] } }), { rules: rulesWithQuotes({ optionsRisk: { extremeSeverity: "ADVERSE" } }) });
    expect(soft).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
  });
  it("an expired contract and a premium already through the stop BLOCK (options-risk)", async () => {
    const d1 = await make({ ...OPT, expiry: "2025-01-03" });
    const key = `NSE:${d1.symbol}:2025-01-03:24500:CE`;
    const p1: Providers = { quote: quotes(goodQuote(), key), option: optionQuotes(goodOption({ premium: 100, bid: 99.5, ask: 100.5 }), key), chain: null };
    const out1 = await blocked(d1, p1);
    expect(await codes(out1.runId, "options-risk-v1")).toContain("OPTION_EXPIRED");
    const d2 = await make(OPT);
    const out2 = await blocked(d2, optionProviders(d2, { option: { premium: 90, bid: 89.5, ask: 90.5 } }));
    expect(await codes(out2.runId, "options-risk-v1")).toContain("PREMIUM_THROUGH_STOP");
  });
  it("poor liquidity and high-risk option profiles halt as ADVERSE (wide spread, poor open interest, near-expiry gamma)", async () => {
    const d1 = await make();
    const wide = await run(d1, equityProviders(d1, { bid: 98.5, ask: 100.5 }));
    expect(wide).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(wide.runId, "liquidity-v1")).toContain("SPREAD_WIDE");
    const d2 = await make(OPT);
    const poor = await run(d2, optionProviders(d2, { option: { openInterest: 20 } }));
    expect(poor).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(poor.runId, "options-risk-v1")).toContain("OPEN_INTEREST_POOR");
    const d3 = await make({ ...OPT, expiry: "2025-01-07" });
    const k3 = `NSE:${d3.symbol}:2025-01-07:24500:CE`;
    const gamma = await run(d3, { quote: quotes(goodQuote({ openInterest: 50_000 }), k3), option: optionQuotes(goodOption({ premium: 100, bid: 99.5, ask: 100.5, gamma: 0.0009 }), k3), chain: chains(goodChain(), `NSE:${d3.symbol}:2025-01-07`) });
    expect(gamma.halt).toBe(true);
    expect(await codes(gamma.runId, "options-risk-v1")).toContain("GAMMA_RISK_HIGH");
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  const unavailable = async (d: Made, p: Providers, o: { liquidity: string; option?: string }) => {
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    const row = async (agent: string) => (await q("select status, verdict, confidence, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0];
    expect(await row("liquidity-v1")).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: o.liquidity });
    if (o.option) expect(await row("options-risk-v1")).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: o.option });
    return out;
  };
  it("no providers configured => UNAVAILABLE => INCOMPLETE and halt (never a pass)", async () => {
    await unavailable(await make(OPT), {}, { liquidity: "QUOTE_PROVIDER_NOT_CONFIGURED", option: "OPTION_QUOTE_PROVIDER_NOT_CONFIGURED" });
  });
  it("a throwing provider, no quote, a stale quote and a malformed quote are UNAVAILABLE; the provider's message is never stored", async () => {
    const d = await make(OPT);
    const base = optionProviders(d);
    const a = await unavailable(d, { ...base, quote: { name: "x", quote: async () => { throw new Error(`down ${MARKER}`); } }, option: { name: "y", quote: async () => { throw new Error(`down ${MARKER}`); } } }, { liquidity: "QUOTE_PROVIDER_UNAVAILABLE", option: "OPTION_QUOTE_PROVIDER_UNAVAILABLE" });
    expect(JSON.stringify(await q("select error_message from agent_runs where orchestrator_run_id = $1", [a.runId]))).not.toContain(MARKER);
    const d2 = await make(OPT);
    await unavailable(d2, { quote: quotes(goodQuote(), "NSE:OTHER"), option: optionQuotes(goodOption(), "NSE:OTHER"), chain: null }, { liquidity: "QUOTE_NOT_AVAILABLE", option: "OPTION_QUOTE_NOT_AVAILABLE" });
    const d3 = await make(OPT);
    await unavailable(d3, optionProviders(d3, { quote: { asOf: new Date(NOW.getTime() - 3600_000).toISOString() }, option: { asOf: new Date(NOW.getTime() - 3600_000).toISOString() } }), { liquidity: "QUOTE_TOO_OLD", option: "OPTION_QUOTE_TOO_OLD" });
    const d4 = await make(OPT);
    await unavailable(d4, optionProviders(d4, { quote: { bid: 101, ask: 100 }, option: { iv: -1 } }), { liquidity: "QUOTE_MALFORMED", option: "OPTION_QUOTE_MALFORMED" });
  });
  it("a missing underlying price makes only options-risk UNAVAILABLE; the decision is INCOMPLETE and halts", async () => {
    const d = await make(OPT);
    const out = await run(d, optionProviders(d, { option: { underlyingPrice: null }, chain: { underlyingPrice: null } }));
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    expect((await q("select status, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = 'options-risk-v1'", [out.runId]))[0]).toMatchObject({ status: "UNAVAILABLE", error_code: "UNDERLYING_PRICE_UNAVAILABLE" });
    expect((await q("select status from agent_runs where orchestrator_run_id = $1 and agent_id = 'liquidity-v1'", [out.runId]))[0]).toMatchObject({ status: "COMPLETED" });
  });
  it("the kill switch refuses before either agent runs", async () => {
    const d = await make(OPT);
    state.set({ KILL_SWITCH_ACTIVE: true });
    const before = await counts(CHAINS);
    await expect(runAgentEngine(db(), d.id, { registry: registry(optionProviders(d)), config: ENGINE, ...clock() })).rejects.toMatchObject({ code: "safety_refused" });
    expect(await counts(CHAINS)).toEqual(before);
  });
});

describe("privacy, inertness and idempotency", () => {
  it("the marker text of the stored messages appears in no agent input, output, finding, evidence reference, synthesis or event; each agent receives only its declared inputs", async () => {
    const d = await make(OPT);
    const events: AgentEvent[] = [];
    const out = await run(d, optionProviders(d), { emit: (e) => events.push(e) });
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    for (const agent of LO) {
      const own = must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0])["input_snapshot"];
      expect(Object.keys(own).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence"]);
    }
  });
  it("is idempotent for the same decision, configuration and clock without re-running the providers", async () => {
    const d = await make(OPT);
    let calls = 0;
    const p = optionProviders(d);
    const counting: Providers = { ...p, quote: { ...(p.quote as QuoteProvider), quote: async (x) => { calls += 1; return (p.quote as QuoteProvider).quote(x); } } };
    const first = await run(d, counting);
    const again = await run(d, counting);
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(calls).toBe(1); // once for the liquidity agent, none on the repeat
  });
  it("makes no external network call: fetch is never used while the agents run", async () => {
    const d = await make(OPT);
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { seen.push(String(a[0])); throw new Error("fetch must not be used"); }) as typeof fetch;
    try { await run(d, optionProviders(d)); } finally { globalThis.fetch = real; }
    expect(seen).toEqual([]);
  });
});
