/**
 * The News/Sentiment and Index-Constituent Impact agents (news-sentiment-v1, index-constituent-impact-v1) through the REAL engine against REAL PostgreSQL (Stage 5 / Task 4). Synthetic risk decisions and
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
  createProductionRegistry, getLatestAgentAssessment, loadAgentEngineConfig, memoryInstrumentReference, runAgentEngine, type AgentEvent, type AgentRulesConfig, type ConstituentProvider, type InstrumentRecord,
  type MarketDataProvider, type NewsProvider, type SentimentProvider,
} from "../../../packages/agents/src/index";
import { assessApprovalEligibility, createRiskDecision, recordSourceIntelligence, type IntelligenceResolver, type RiskDecisionInput } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { economicCalendar, holidayCalendar, macroProvider } from "../../support/calendarMacroFixtures";
import { allChange, constituentRow, constituentSet, constituents, newsFeed, newsItem, quotes, rulesWithNews, sentimentFeed, aggregate } from "../../support/newsConstituentFixtures";
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
const NC = ["index-constituent-impact-v1", "news-sentiment-v1"];
// Task 4 scope: news + constituent are required, the earlier agents are switched off here (covered by their own files); the "all six" test enables everything.
const ENGINE = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: NC.join(",") }), disabledAgents: ["instrument-verification-v1", "macro-global-v1", "market-calendar-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1"] };
const ALL6 = { ...loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "index-constituent-impact-v1,instrument-verification-v1,macro-global-v1,market-calendar-v1,news-sentiment-v1,signal-integrity-v1" }), disabledAgents: ["price-action-v1", "technical-structure-v1"] }; // the six Task 2-4 agents REQUIRED
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
async function make(o: { symbol?: string; instrumentType?: string; expiry?: string | null; strike?: number | null; optionType?: string | null; side?: "BUY" | "SELL" } = {}): Promise<Made> {
  const symbol = o.symbol ?? `NC${randomLetters(8)}`;
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
interface Providers { news?: NewsProvider | null; sentiment?: SentimentProvider | null; constituents?: ConstituentProvider | null; market?: MarketDataProvider | null }
/** The decision's symbol is configured as the INDEX underlying so the constituent agent applies; its constituent set is the shared synthetic one. */
const rulesFor = (d: Made): AgentRulesConfig => rulesWithNews({ constituent: { indexUnderlyings: [d.symbol] } });
const set = (d: Made, changes?: Record<string, number>) => constituentSet({ index: d.symbol, ...(changes ? { changes } : {}) });
const registry = (d: Made, p: Providers = {}) => createProductionRegistry({
  rules: rulesFor(d), newsProvider: p.news === undefined ? newsFeed() : p.news, sentimentProvider: p.sentiment === undefined ? null : p.sentiment,
  constituentProvider: p.constituents === undefined ? constituents(set(d)) : p.constituents, marketDataProvider: p.market === undefined ? null : p.market,
});
const run = async (d: Made, p: Providers = {}, o: { emit?: (e: AgentEvent) => void } = {}) => {
  const out = await runAgentEngine(db(), d.id, { registry: registry(d, p), config: ENGINE, ...(o.emit ? { emit: o.emit } : {}), ...clock() });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const codes = async (runId: string, agent: string) => (await q("select f.code from agent_findings f join agent_runs r on r.id = f.agent_run_id where r.orchestrator_run_id = $1 and r.agent_id = $2", [runId, agent])).map((r) => r["code"] as string);
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("clean conditions: both agents run in parallel, persist and approve nothing", () => {
  it("supportive news and constituents: both SUPPORTIVE, run IN PARALLEL, outputs validated and persisted, assessment SUPPORTIVE, not halted", async () => {
    const d = await make();
    const live = await counts(LIVE);
    const events: AgentEvent[] = [];
    const item = newsItem({ symbols: [d.symbol], impact: "HIGH", publishedAt: minutesAgo(30) });
    const out = await run(d, { news: slow(newsFeed([item]), 60, ["items"]), constituents: slow(constituents(set(d)), 60, ["constituents"]) }, { emit: (e) => events.push(e) });
    expect(out).toMatchObject({ created: true, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, agents: 2 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).sort()).toEqual(["agent.started:index-constituent-impact-v1", "agent.started:news-sentiment-v1"]); // both started before either finished
    const runs = Object.fromEntries((await q("select * from agent_runs where orchestrator_run_id = $1", [out.runId])).map((r) => [r["agent_id"], r]));
    expect(Object.keys(runs).sort()).toEqual(NC);
    for (const r of Object.values(runs)) expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", agent_version: "1.0.0", attempts: 1, error_code: null });
    expect(runs["news-sentiment-v1"]!["output_snapshot"]).toMatchObject({ direction: "BULLISH", provider: "synthetic-news", itemsConsidered: 1, supportiveItems: 1, blockingCount: 0 });
    expect(runs["index-constituent-impact-v1"]!["output_snapshot"]).toMatchObject({ applicable: true, index: d.symbol, consideredCount: 10, weightedMovePct: 0.5, usableWeightShare: 1 });
    expect((await q("select count(*)::int as n from agent_evidence_references where agent_run_id = any($1)", [Object.values(runs).map((r) => r["id"])]))[0]!["n"]).toBeGreaterThanOrEqual(5);
    expect((await q("select agent_id, agent_version from agent_definitions where agent_id = any($1) group by 1,2 order by 1", [NC])).map((r) => `${r["agent_id"]}@${r["agent_version"]}`)).toEqual(["index-constituent-impact-v1@1.0.0", "news-sentiment-v1@1.0.0"]);
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", grants_approval: false });
    expect(syn["result"].contributions.map((c: { agentId: string }) => c.agentId).sort()).toEqual(NC);
    expect(await counts(LIVE)).toEqual(live); // nothing created; a supportive assessment approves nothing
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("all SIX production agents run in one parallel level through the default required set", async () => {
    const d = await make();
    const ref = memoryInstrumentReference({ name: "synthetic", asOf: NOW.toISOString(), markets: ["NSE"], instruments: [{ market: "NSE", underlying: d.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true } satisfies InstrumentRecord] });
    const events: AgentEvent[] = [];
    const reg = createProductionRegistry({
      rules: rulesFor(d), instrumentReference: ref, holidayCalendar: holidayCalendar(), economicCalendar: economicCalendar(), macroProvider: macroProvider(),
      newsProvider: slow(newsFeed(), 30, ["items"]), constituentProvider: slow(constituents(set(d)), 30, ["constituents"]),
    });
    const out = await runAgentEngine(db(), d.id, { registry: reg, config: { ...ALL6, maxConcurrency: 6 }, emit: (e) => events.push(e), ...clock() }); // (the default concurrency limit is 4)
    if (out.skipped) throw new Error("skipped");
    expect(out).toMatchObject({ status: "COMPLETED", halt: false, agents: 6 });
    const types = events.map((e) => `${e.type}:${e.agentId ?? ""}`);
    const firstFinish = types.findIndex((t) => t.startsWith("agent.finished"));
    expect(types.slice(0, firstFinish + 1).filter((t) => t.startsWith("agent.started")).length).toBe(6);
    const verdicts = Object.fromEntries(must(await getLatestAgentAssessment(db(), d.id)).agents.map((a) => [a.agentId, a.verdict]));
    expect(Object.keys(verdicts)).toHaveLength(6);
    expect(verdicts["news-sentiment-v1"]).toBe("NEUTRAL"); // fresh feed, no relevant news
    expect(verdicts["index-constituent-impact-v1"]).toBe("SUPPORTIVE");
  });
});

describe("a BLOCKING verdict halts the flow at the existing halt point", () => {
  const blocked = async (d: Made, p: Providers) => {
    const live = await counts(LIVE);
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_BLOCKED", halt: true, status: "COMPLETED" });
    expect(await counts(LIVE)).toEqual(live); // halting creates nothing: the decision stays PENDING
    expect(await assessApprovalEligibility(db(), d.id)).toMatchObject({ eligible: false });
    return out;
  };
  const neg = (o: Parameters<typeof newsItem>[0]) => newsItem({ sentimentLabel: "NEGATIVE", sentimentScore: -0.8, ...o });
  it("critical adverse news inside the near-term window BLOCKS (news agent); the constituent agent still completes independently", async () => {
    const d = await make();
    const out = await blocked(d, { news: newsFeed([neg({ symbols: [d.symbol], impact: "CRITICAL", publishedAt: minutesAgo(20) })]) });
    expect(Object.fromEntries(must(await getLatestAgentAssessment(db(), d.id)).agents.map((x) => [x.agentId, x.verdict]))).toMatchObject({ "news-sentiment-v1": "BLOCKING", "index-constituent-impact-v1": "SUPPORTIVE" });
    expect(await codes(out.runId, "news-sentiment-v1")).toContain("CRITICAL_ADVERSE_NEWS_NEAR_TERM");
    expect(must((await q("select result from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0])["result"]).toMatchObject({ blockers: [{ agentId: "news-sentiment-v1" }], grantsApproval: false });
  });
  it("a critical event on a heavy constituent BLOCKS (constituent agent)", async () => {
    const d = await make();
    const out = await blocked(d, { news: newsFeed([neg({ symbols: ["AAA"], impact: "CRITICAL", publishedAt: minutesAgo(20) })]) });
    expect(await codes(out.runId, "index-constituent-impact-v1")).toContain("CRITICAL_CONSTITUENT_EVENT");
  });
  it("strong adverse evidence halts as ADVERSE: high-impact adverse news, and a heavily negative weighted constituent move (a market-data quote overrides the record)", async () => {
    const d1 = await make();
    const news = await run(d1, { news: newsFeed([neg({ symbols: [d1.symbol], impact: "HIGH", publishedAt: minutesAgo(60) })]) });
    expect(news).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    const d2 = await make();
    const weighted = await run(d2, { market: quotes(allChange(-1.5)) });
    expect(weighted).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await codes(weighted.runId, "index-constituent-impact-v1")).toContain("WEIGHTED_IMPACT_AGAINST");
  });
  it("a strongly negative aggregate sentiment halts as ADVERSE and a supportive one does not", async () => {
    const d = await make();
    const adverse = await run(d, { sentiment: sentimentFeed({ [`NSE:${d.symbol}`]: aggregate(-0.8, { asOf: minutesAgo(10) }) }) });
    expect(adverse).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    const ok = await run(await make(), {});
    expect(ok.halt).toBe(false);
  });
});

describe("failures fail closed (the required agents' results must exist)", () => {
  const unavailable = async (d: Made, p: Providers, agent: string, code: string) => {
    const out = await run(d, p);
    expect(out).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", status: "INCOMPLETE", halt: true });
    expect((await q("select status, verdict, confidence, error_code from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0]).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, error_code: code });
    return out;
  };
  it("no news provider / no constituent provider configured => UNAVAILABLE => INCOMPLETE and halt (never a pass)", async () => {
    await unavailable(await make(), { news: null }, "news-sentiment-v1", "NEWS_PROVIDER_NOT_CONFIGURED");
    await unavailable(await make(), { constituents: null }, "index-constituent-impact-v1", "CONSTITUENT_PROVIDER_NOT_CONFIGURED");
  });
  it("providers that throw, malformed data, a feed that is too old, missing constituent coverage and an index mismatch are UNAVAILABLE; the provider's message is never stored", async () => {
    const boom = (): never => { throw new Error(`down ${MARKER}`); };
    const a = await unavailable(await make(), { news: { name: "x", asOf: null, items: async () => boom() } }, "news-sentiment-v1", "NEWS_PROVIDER_UNAVAILABLE");
    const d = await make();
    const b = await unavailable(d, { constituents: { name: "x", knowsIndex: async () => true, constituents: async () => boom() } }, "index-constituent-impact-v1", "CONSTITUENT_PROVIDER_UNAVAILABLE");
    for (const o of [a, b]) expect(JSON.stringify(await q("select error_message from agent_runs where orchestrator_run_id = $1", [o.runId]))).not.toContain(MARKER);
    await unavailable(await make(), { news: newsFeed([{ id: "x" }]) }, "news-sentiment-v1", "NEWS_DATA_MALFORMED");
    await unavailable(await make(), { news: newsFeed([], { asOf: minutesAgo(3000) }) }, "news-sentiment-v1", "NEWS_FEED_TOO_OLD");
    const m = await make();
    await unavailable(m, { constituents: constituents(constituentSet({ index: m.symbol, rows: [constituentRow("AAA", { index: m.symbol })] })) }, "index-constituent-impact-v1", "CONSTITUENT_COVERAGE_INSUFFICIENT");
    const mm = await make();
    await unavailable(mm, { constituents: constituents(constituentSet({ index: "OTHERINDEX" })) }, "index-constituent-impact-v1", "INDEX_NOT_COVERED");
    const mm2 = await make();
    await unavailable(mm2, { constituents: { name: "x", knowsIndex: async () => true, constituents: async () => constituentSet({ index: "OTHERINDEX" }) } }, "index-constituent-impact-v1", "INDEX_UNDERLYING_MISMATCH");
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
    const out = await run(d, { news: newsFeed([newsItem({ symbols: [d.symbol], impact: "MEDIUM", sentimentLabel: "NEGATIVE", sentimentScore: -0.7, publishedAt: minutesAgo(40) })]) }, { emit: (e) => events.push(e) });
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const input = must((await q("select input_snapshot from agent_orchestrator_runs where id = $1", [out.runId]))[0])["input_snapshot"];
    expect(Object.keys(input).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence", "stop_loss_validation"]);
    for (const agent of NC) {
      const own = must((await q("select input_snapshot from agent_runs where orchestrator_run_id = $1 and agent_id = $2", [out.runId, agent]))[0])["input_snapshot"];
      expect(Object.keys(own).sort()).toEqual(["risk_decision", "signal_context", "signal_features", "source_intelligence"]);
    }
  });
  it("is idempotent for the same decision, configuration and clock without re-running the providers", async () => {
    const d = await make();
    let calls = 0;
    const n = newsFeed();
    const counting: NewsProvider = { ...n, items: async (x) => { calls += 1; return n.items(x); } };
    const first = await run(d, { news: counting });
    const again = await run(d, { news: counting });
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(calls).toBe(2); // once per agent (both use the news provider), none on the repeat
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
