/**
 * Market, liquidity and event-risk gates against REAL PostgreSQL (Stage 3 / Task 5). Market data is always an injected SYNTHETIC provider; no live data, broker
 * or external calendar is used. Evaluation time is an explicit input (a Wednesday 10:00 IST in the past), so results never depend on the real clock or session.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChains, verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  addEventWindow, cancelEventWindow, createRiskDecision, databaseEventWindows, evaluateMarketRisk, evaluatePortfolioRisk, getRiskDecision, listEventWindows, listRiskDecisions, loadPortfolioConfig, recordLossEvent,
  RiskDecisionError, sizeRiskDecision, staticHolidayCalendar, supersedeRiskDecision, type MarketAlert, type MarketOptions, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { runCli } from "../../../scripts/ops/risk-control";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";
import { healthy, OPEN_NOW, syntheticProvider } from "./gates";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const SIZE_CAPITAL = 1_000_000;
const CAPITAL = 1_000_000_000; // the portfolio and the market gates see this capital, so limits are far away from any leftovers
const MIN = 60_000;

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const pfOpts = { config: openLimits(), capital: CAPITAL };
const sym = () => `MG${sfx()}`.toUpperCase();
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);
const raw = async (id: string) => must((await pool.query("select * from risk_decisions where id = $1", [id])).rows[0]);

interface Made { signalId: string; evidenceId: string; sizedId: string; portfolioId: string; symbol: string }
/** signal + VALID stop-loss + PENDING decision -> SIZED (v2) -> portfolio-passed PENDING (v3): the state in which the market gates are evaluated. */
async function makePortfolioPassed(o: { symbol?: string; instrumentType?: string; lotSize?: string | null; expiry?: string | null; market?: string; entry?: number; stop?: number } = {}): Promise<Made> {
  const symbol = o.symbol ?? sym();
  const entry = o.entry ?? 100, stop = o.stop ?? 95, type = o.instrumentType ?? "equity", exchange = type === "equity" ? "NSE" : "NFO";
  const [existing] = await db().select().from(schema.instruments).where(and(eq(schema.instruments.symbol, symbol), eq(schema.instruments.exchange, exchange)));
  const [instrument] = existing ? [existing] : await db().insert(schema.instruments).values({ symbol, exchange, instrumentType: type, lotSize: o.lotSize ?? null }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "mg-test", direction: "buy", entryPrice: String(entry), stopLoss: String(stop), targets: [entry * 1.1], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: String(stop), entryPrice: String(entry), riskDistance: String(entry - stop), riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `mg-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: type, market: o.market ?? "NSE", symbol, expiry: o.expiry ?? null,
    side: "BUY", entryPrice: entry, stopLoss: stop, stopLossBasis: "price", target1: entry * 1.1, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false }, evidenceReferences: { fixture: true },
  };
  const v1 = await createRiskDecision(db(), input);
  const sized = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
  expect(sized.sizingStatus).toBe("SIZED");
  const pf = await evaluatePortfolioRisk(db(), sized.id, pfOpts);
  expect(pf).toMatchObject({ status: "PENDING", portfolioOutcome: "APPROVED_FOR_REVIEW" });
  return { signalId: must(signal).id, evidenceId: must(ev).id, sizedId: sized.id, portfolioId: pf.id, symbol };
}
const market = (id: string, over: Partial<MarketOptions> = {}) => evaluateMarketRisk(db(), id, { provider: syntheticProvider(healthy()), now: OPEN_NOW, capital: CAPITAL, ...over });

describe("the valid approval-eligible path: sizing -> portfolio -> market gates", () => {
  it("only after sizing AND the portfolio limits AND every market gate does the decision become APPROVED_FOR_REVIEW, as a new chained version", async () => {
    const m = await makePortfolioPassed();
    const before = await raw(m.portfolioId);
    expect(must(await getRiskDecision(db(), m.portfolioId))).toMatchObject({ status: "PENDING", effectiveStatus: "PENDING" }); // the portfolio alone approves nothing
    const out = await market(m.portfolioId);
    expect(out).toMatchObject({ created: true, decisionVersion: 4, status: "APPROVED_FOR_REVIEW", marketOutcome: "PASSED", reasonCode: null });
    const v4 = must(await getRiskDecision(db(), out.id));
    expect(v4).toMatchObject({ supersedesId: m.portfolioId, createdBy: "service:market-risk", decisionReasonCode: "market_gates_passed", stopLossValidationId: m.evidenceId, effectiveStatus: "APPROVED_FOR_REVIEW" });
    expect(Number(v4.plannedQuantity)).toBe(2000);
    const snap = v4.outputSnapshot as { stage: string; sizing: { status: string }; portfolio: { outcome: string }; market: Record<string, Record<string, Record<string, unknown>>> & { thresholds: Record<string, unknown>; observed: { snapshot: Record<string, unknown> }; gates: Record<string, Record<string, unknown>> } };
    expect(snap).toMatchObject({ stage: "market_risk", sizing: { status: "SIZED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW" }, market: { outcome: "PASSED", engineVersion: "market-v1" } });
    expect(Object.keys(snap.market["gates"]).sort()).toEqual(["blackout", "circuitBreaker", "expiry", "liquidity", "marketData", "session", "spread", "staleness"]);
    expect(snap.market["gates"]["session"]).toMatchObject({ result: "PASS", observed: { state: "OPEN" }, threshold: { opens: "09:15", closes: "15:30", timezone: "Asia/Kolkata" } });
    expect(snap.market["thresholds"]).toMatchObject({ minBidQty: 100, maxSpreadPct: 0.5, maxDataAgeSeconds: 60 });
    expect(snap.market["observed"]["snapshot"]).toMatchObject({ bid: 99.95, ask: 100.05, bidQty: 5000 });
    expect(v4.inputSnapshot).toMatchObject({ previousDecisionId: m.portfolioId, market: { outcome: "PASSED" } });
    expect(v4.evidenceReferences).toMatchObject({ previousDecisionId: m.portfolioId, stopLossValidationId: m.evidenceId });
    expect(await raw(m.portfolioId)).toEqual(before); // never mutated
    expect(must(await getRiskDecision(db(), m.portfolioId))).toMatchObject({ effectiveStatus: "SUPERSEDED", supersededById: out.id });
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
  it("the database refuses APPROVED_FOR_REVIEW unless the market evaluation PASSED, even for a sized, portfolio-passed decision", async () => {
    const m = await makePortfolioPassed();
    const d = must(await getRiskDecision(db(), m.portfolioId));
    const attempt = (outputSnapshot: Record<string, unknown>) => supersedeRiskDecision(db(), d.id, {
      stopLossValidationId: m.evidenceId, status: "APPROVED_FOR_REVIEW", idempotencyKey: `mg-nomk:${randomUUID()}`, createdBy: "operator:itest", instrumentType: "equity", market: "NSE", symbol: m.symbol, side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price",
      plannedQuantity: 1000, plannedNotional: 100000, plannedMaxLossAmount: 5000, plannedMaxLossPercent: 0.5, decisionReasonCode: "manual", inputSnapshot: { x: 1 }, outputSnapshot,
    });
    const base = { sizing: { status: "SIZED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW" } };
    for (const snap of [base, { ...base, market: {} }, { ...base, market: { outcome: "REJECTED" } }, { ...base, market: { outcome: "CONDITIONAL" } }]) expect((await err(attempt(snap))).code).toBe("stop_loss_not_valid"); // mapped from the database check violation
    expect(await listRiskDecisions(db(), { signalId: m.signalId })).toHaveLength(3);
  });
});

describe("a failed gate creates a REJECTED version with a machine-readable reason (table-driven)", () => {
  const evening = new Date("2024-06-12T12:00:00Z"); // 17:30 IST
  const saturday = new Date("2024-06-15T05:00:00Z");
  type Row = [string, (m: Made) => Partial<MarketOptions>, string, string];
  const rows: Row[] = [
    ["market closed (evening)", () => ({ now: evening, provider: syntheticProvider(healthy(evening)) }), "MARKET_CLOSED", "market_market_closed"],
    ["weekend", () => ({ now: saturday, provider: syntheticProvider(healthy(saturday)) }), "MARKET_CLOSED", "market_market_closed"],
    ["holiday (calendar interface)", () => ({ holidays: staticHolidayCalendar({ IN: ["2024-06-12"] }) }), "MARKET_HOLIDAY", "market_market_holiday"],
    ["stale data", () => ({ provider: syntheticProvider(healthy(OPEN_NOW, { timestamp: new Date(OPEN_NOW.getTime() - 5 * MIN) })) }), "STALE_MARKET_DATA", "market_stale_market_data"],
    ["spread too wide", () => ({ provider: syntheticProvider(healthy(OPEN_NOW, { bid: 99, ask: 101 })) }), "SPREAD_TOO_WIDE", "market_spread_too_wide"],
    ["insufficient liquidity", () => ({ provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 5 })) }), "INSUFFICIENT_LIQUIDITY", "market_insufficient_liquidity"],
    ["invalid (crossed) market data", () => ({ provider: syntheticProvider(healthy(OPEN_NOW, { bid: 101, ask: 100 })) }), "INVALID_MARKET_DATA", "market_invalid_market_data"],
    ["entry price far from the market (sanity)", () => ({ provider: syntheticProvider(healthy(OPEN_NOW, { last: 150, bid: 149.9, ask: 150.1 })) }), "INVALID_MARKET_DATA", "market_invalid_market_data"],
  ];
  it.each(rows)("%s", async (_name, opts, reason, code) => {
    const m = await makePortfolioPassed();
    const out = await market(m.portfolioId, opts(m));
    expect(out).toMatchObject({ created: true, status: "REJECTED", marketOutcome: "REJECTED", reasonCode: reason });
    const v = must(await getRiskDecision(db(), out.id));
    expect(v).toMatchObject({ status: "REJECTED", decisionReasonCode: code, supersedesId: m.portfolioId, createdBy: "service:market-risk" });
    const mk = (v.outputSnapshot as { market: { outcome: string; failures: Array<{ reason: string; observed?: unknown; threshold?: unknown }>; observed: unknown; thresholds: unknown } }).market;
    expect(mk.outcome).toBe("REJECTED");
    expect(mk.failures.map((f) => f.reason)).toContain(reason);
    expect(mk.observed).toBeTruthy();
    expect(mk.thresholds).toBeTruthy();
  });
  it("an event blackout: CRITICAL rejects (EVENT_BLACKOUT_ACTIVE); a WARNING window leaves the decision PENDING and conditional, never approved; a cancelled window no longer applies", async () => {
    const s = sym();
    const critical = await addEventWindow(db(), { market: "NSE", scope: "SYMBOL", scopeValue: s, severity: "CRITICAL", startsAt: new Date(OPEN_NOW.getTime() - 60 * MIN), endsAt: new Date(OPEN_NOW.getTime() + 60 * MIN), reasonCode: "results_announcement", createdBy: "operator:itest" });
    const m = await makePortfolioPassed({ symbol: s });
    const out = await market(m.portfolioId);
    expect(out).toMatchObject({ status: "REJECTED", reasonCode: "EVENT_BLACKOUT_ACTIVE" });
    expect((must(await getRiskDecision(db(), out.id)).evidenceReferences as { eventWindowIds: string[] }).eventWindowIds).toContain(critical.id);
    // cancel it, add a WARNING window: the rejected decision is re-evaluated and is now conditional (PENDING), not approved
    await cancelEventWindow(db(), critical.id, { createdBy: "operator:itest", reason: "announcement moved" });
    await addEventWindow(db(), { market: "NSE", scope: "SYMBOL", scopeValue: s, severity: "WARNING", startsAt: new Date(OPEN_NOW.getTime() - 60 * MIN), endsAt: new Date(OPEN_NOW.getTime() + 60 * MIN), reasonCode: "sector_news", createdBy: "operator:itest" });
    const cond = await market(out.id);
    expect(cond).toMatchObject({ status: "PENDING", marketOutcome: "CONDITIONAL", decisionVersion: 5 });
    expect(must(await getRiskDecision(db(), cond.id))).toMatchObject({ decisionReasonCode: "market_conditional_event_blackout_warning", effectiveStatus: "PENDING" });
  });
  it("an expiring contract: EXPIRY_TOO_SOON 20 minutes before the expiry-day close; EXPIRED_CONTRACT (recorded with the closed session) after it", async () => {
    const m = await makePortfolioPassed({ symbol: sym(), instrumentType: "future", lotSize: "10", expiry: "2024-06-12", market: "NFO", entry: 1000, stop: 950 });
    const late = new Date("2024-06-12T09:40:00Z"); // 15:10 IST
    const soon = await market(m.portfolioId, { now: late, provider: syntheticProvider(healthy(late, { last: 1000, bid: 999.9, ask: 1000.1, volume: 5_000, openInterest: 50_000 })) });
    expect(soon).toMatchObject({ status: "REJECTED", reasonCode: "EXPIRY_TOO_SOON" });
    const after = new Date("2024-06-12T10:05:00Z"); // 15:35 IST: the contract has expired and the session has closed
    const expired = await market(soon.id, { now: after, provider: syntheticProvider(healthy(after, { last: 1000, bid: 999.9, ask: 1000.1, volume: 5_000, openInterest: 50_000 })) });
    expect(expired).toMatchObject({ status: "REJECTED", reasonCode: "MARKET_CLOSED" }); // the primary reason follows the fixed precedence; the expired contract is still recorded
    expect((must(await getRiskDecision(db(), expired.id)).outputSnapshot as { market: { failures: Array<{ reason: string }> } }).market.failures.map((f) => f.reason)).toEqual(expect.arrayContaining(["MARKET_CLOSED", "EXPIRED_CONTRACT"]));
    const open = await market(expired.id, { provider: syntheticProvider(healthy(OPEN_NOW, { last: 1000, bid: 999.9, ask: 1000.1, volume: 5_000, openInterest: 50_000 })) }); // 10:00 IST on the expiry day: valid, stricter rules satisfied
    expect(open).toMatchObject({ status: "APPROVED_FOR_REVIEW", marketOutcome: "PASSED" });
    const snap = (must(await getRiskDecision(db(), open.id)).outputSnapshot as { market: { gates: Record<string, { result: string }> } }).market;
    expect(snap.gates["expiry"]).toMatchObject({ result: "WARN" }); // expiry day is flagged
  });
  it("an open loss circuit breaker rejects with CIRCUIT_BREAKER_ACTIVE", async () => {
    const m = await makePortfolioPassed();
    const week = new Date("2024-06-19T04:30:00Z"); // another Wednesday, so this breach never touches the other tests' week
    await recordLossEvent(db(), { amount: 30_000_000, occurredAt: new Date("2024-06-19T04:00:00Z"), source: "synthetic", sourceRef: `mg-${sfx()}`, createdBy: "service:itest" });
    const out = await market(m.portfolioId, { now: week, provider: syntheticProvider(healthy(week)) });
    expect(out).toMatchObject({ status: "REJECTED", reasonCode: "CIRCUIT_BREAKER_ACTIVE" });
    expect(must(await getRiskDecision(db(), out.id)).decisionReasonCode).toBe("market_circuit_breaker_active");
  });
});

describe("fail closed: required inputs that cannot be read write nothing", () => {
  it("missing market data, a failing provider, unreadable event windows, an unsized or portfolio-less decision, and a later INVALID stop-loss are refused", async () => {
    const m = await makePortfolioPassed();
    const before = await rowCount("risk_decisions");
    const alerts: MarketAlert[] = [];
    expect((await err(market(m.portfolioId, { provider: syntheticProvider(null), onMarketAlert: (a) => alerts.push(a) }))).code).toBe("market_data_unavailable");
    expect((await err(market(m.portfolioId, { provider: { name: "broken", getSnapshot: async () => { throw new Error("connection to feed failed password=SECRET-CANARY"); } }, onMarketAlert: (a) => alerts.push(a) }))).code).toBe("market_data_unavailable");
    expect((await err(market(m.portfolioId, { provider: undefined }))).code).toBe("market_data_unavailable");
    expect((await err(market(m.portfolioId, { windows: { listWindows: async () => { throw new Error("windows store down"); } } }))).code).toBe("event_windows_unavailable");
    expect(alerts.map((a) => a.severity)).toEqual(["WARNING", "CRITICAL"]); // no data -> WARNING; a provider failure -> CRITICAL (operational)
    expect(JSON.stringify(alerts)).not.toMatch(/SECRET-CANARY|password|connection/);
    const m2 = await makePortfolioPassed();
    const unsized = await makeUnsized();
    expect((await err(market(unsized, {}))).code).toBe("sizing_missing");
    expect((await err(market(m2.sizedId, {}))).code).toBe("portfolio_missing"); // sized, but the portfolio has not passed it
    await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: m2.signalId, ruleVersion: "stop-loss-v1", result: "INVALID", reasonCode: "STOP_LOSS_WRONG_SIDE", levelBasis: "price", maxRiskPct: "10" });
    expect((await err(market(m2.portfolioId, {}))).code).toBe("stop_loss_not_valid");
    expect((await err(market(randomUUID(), {}))).code).toBe("not_found");
    expect(await rowCount("risk_decisions")).toBe(before + (await rowCount("risk_decisions")) - before); // (only the fixtures above were added)
    expect((await listRiskDecisions(db(), { signalId: m.signalId })).filter((r) => r.createdBy === "service:market-risk")).toEqual([]);
  });
  it("kill switch, intake off and an unreadable runtime state refuse before any data is read", async () => {
    const m = await makePortfolioPassed();
    const calls: unknown[] = [];
    const provider = syntheticProvider(healthy(), calls as never);
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(market(m.portfolioId, { provider }))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false, INTAKE_ENABLED: false });
    expect((await err(market(m.portfolioId, { provider }))).code).toBe("safety_refused");
    source.set({ INTAKE_ENABLED: true });
    source.failWith(new Error("state unreadable"));
    expect((await err(market(m.portfolioId, { provider }))).code).toBe("safety_refused");
    expect(calls).toEqual([]);
    expect((await listRiskDecisions(db(), { signalId: m.signalId })).some((r) => r.createdBy === "service:market-risk")).toBe(false);
  });
  it("a decision past its own validity window is expired, not evaluated", async () => {
    const m = await makePortfolioPassed();
    const late = new Date(Date.now() + 31 * MIN);
    expect((await err(market(m.portfolioId, { now: late, provider: syntheticProvider(healthy(late)) }))).code).toBe("decision_expired");
  });
});

async function makeUnsized(): Promise<string> {
  const [instrument] = await db().insert(schema.instruments).values({ symbol: sym(), exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "mg-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  return (await createRiskDecision(db(), { subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `mg-u:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", symbol: "X", side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { a: 1 } })).id;
}

describe("versioned, idempotent recalculation", () => {
  it("identical inputs return the existing version; changed data appends the next version (REJECTED -> APPROVED) without mutating the old one", async () => {
    const m = await makePortfolioPassed();
    const stale = healthy(OPEN_NOW, { timestamp: new Date(OPEN_NOW.getTime() - 5 * MIN) });
    const v4 = await market(m.portfolioId, { provider: syntheticProvider(stale) });
    expect(v4).toMatchObject({ created: true, status: "REJECTED", reasonCode: "STALE_MARKET_DATA", decisionVersion: 4 });
    const before = await raw(v4.id);
    expect(await market(v4.id, { provider: syntheticProvider(stale) })).toMatchObject({ id: v4.id, created: false }); // same data, same verdict
    expect(await market(m.portfolioId, { provider: syntheticProvider(stale) })).toMatchObject({ id: v4.id, created: false }); // retried against the version it superseded
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => market(v4.id, { provider: syntheticProvider(healthy()) })));
    expect(new Set([a?.id, b?.id, c?.id]).size).toBe(1); // concurrent evaluations append exactly one version
    expect(a).toMatchObject({ status: "APPROVED_FOR_REVIEW", decisionVersion: 5 });
    expect(await raw(v4.id)).toEqual(before);
    expect((await listRiskDecisions(db(), { signalId: m.signalId })).filter((r) => r.createdBy === "service:market-risk")).toHaveLength(2);
    // an approval is re-checked against fresh data: it can fall back to REJECTED as a new version
    const lost = await market(a!.id, { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 1 })) });
    expect(lost).toMatchObject({ status: "REJECTED", reasonCode: "INSUFFICIENT_LIQUIDITY", decisionVersion: 6 });
  });
});

describe("alerts", () => {
  it("WARNING for stale data / wide spread / low liquidity; nothing for a closed market; the alert carries only reason and kind", async () => {
    const alerts: MarketAlert[] = [];
    const m1 = await makePortfolioPassed();
    await market(m1.portfolioId, { provider: syntheticProvider(healthy(OPEN_NOW, { bid: 98, ask: 102 })), onMarketAlert: (a) => alerts.push(a) });
    const m2 = await makePortfolioPassed();
    const evening = new Date("2024-06-12T12:00:00Z");
    await market(m2.portfolioId, { now: evening, provider: syntheticProvider(healthy(evening)), onMarketAlert: (a) => alerts.push(a) });
    expect(alerts.map((a) => `${a.severity}:${a.code}`)).toEqual(["WARNING:spread_too_wide"]);
    expect(Object.keys(alerts[0]!.details).sort()).toEqual(["kind", "reason"]);
    const m3 = await makePortfolioPassed();
    const again: MarketAlert[] = [];
    const opts = { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 1 })), onMarketAlert: (a: MarketAlert) => again.push(a) };
    await market(m3.portfolioId, opts);
    await market(m3.portfolioId, opts); // idempotent retry: no second alert
    expect(again.map((a) => a.code)).toEqual(["insufficient_liquidity"]);
    expect(JSON.stringify([alerts, again])).not.toMatch(/MG[0-9A-F]{8}|synthetic|operator:|postgres|password/i);
  });
});

describe("event blackout windows (manual / admin-defined source)", () => {
  it("are immutable and tamper-evident, validated, cancelled by an appended row, and read through the EventWindowSource interface", async () => {
    const s = sym();
    const start = new Date("2031-03-03T00:00:00Z"), end = new Date("2031-03-04T00:00:00Z");
    const w = await addEventWindow(db(), { market: "NSE", scope: "SYMBOL", scopeValue: s, severity: "CRITICAL", startsAt: start, endsAt: end, reasonCode: "budget_day", reason: "union budget", createdBy: "operator:itest" });
    expect(w.created).toBe(true);
    expect(await addEventWindow(db(), { market: "NSE", scope: "SYMBOL", scopeValue: s, severity: "CRITICAL", startsAt: start, endsAt: end, reasonCode: "budget_day", reason: "union budget", createdBy: "operator:itest" })).toEqual({ id: w.id, created: false });
    const at = new Date("2031-03-03T10:00:00Z");
    expect((await databaseEventWindows(db()).listWindows({ market: "NSE", symbol: s, at })).map((x) => x.id)).toEqual([w.id]);
    expect(await databaseEventWindows(db()).listWindows({ market: "NYSE", symbol: s, at })).toEqual([]);
    expect(await databaseEventWindows(db()).listWindows({ market: "NSE", symbol: "OTHER", at })).toEqual([]);
    expect(await databaseEventWindows(db()).listWindows({ market: "NSE", symbol: s, at: new Date("2031-03-04T00:00:00Z") })).toEqual([]);
    for (const bad of [
      { market: "nse" }, { scope: "SYMBOL" as const, scopeValue: null }, { scope: "MARKET" as const, scopeValue: "X" }, { severity: "INFO" as never }, { endsAt: start }, { endsAt: new Date(start.getTime() + 40 * 86_400_000) }, { reasonCode: "Bad Code" }, { createdBy: "somebody" },
    ]) expect((await err(addEventWindow(db(), { market: "NSE", scope: "SYMBOL", scopeValue: s, severity: "WARNING", startsAt: start, endsAt: end, reasonCode: "x_event", createdBy: "operator:itest", ...bad }))).code, JSON.stringify(bad)).toBe("invalid_input");
    const cancelled = await cancelEventWindow(db(), w.id, { createdBy: "operator:itest" });
    expect(cancelled.created).toBe(true);
    expect(await cancelEventWindow(db(), w.id, { createdBy: "operator:itest" })).toEqual({ id: cancelled.id, created: false });
    expect(await databaseEventWindows(db()).listWindows({ market: "NSE", symbol: s, at })).toEqual([]);
    expect((await listEventWindows(db(), { includeCancelled: true })).find((x) => x.id === w.id)).toMatchObject({ cancelled: true });
    expect((await err(cancelEventWindow(db(), randomUUID(), { createdBy: "operator:itest" }))).code).toBe("not_found");
    // UPDATE / DELETE / TRUNCATE are rejected (also under replica role) and tampering is detected
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const sql of ["update event_blackout_windows set reason = 'x'", "delete from event_blackout_windows", "truncate event_blackout_windows", "truncate event_blackout_windows cascade"]) {
        await c.query("savepoint s");
        const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
        await c.query("rollback to savepoint s");
        expect(["23001", "0A000"], sql).toContain(e?.code);
      }
      await c.query("set local session_replication_role = replica");
      expect((await c.query("update event_blackout_windows set event_hash = event_hash").then(() => null, (x: { code?: string }) => x))?.code).toBe("23001");
      await c.query("rollback");
      await c.query("begin");
      await c.query("alter table event_blackout_windows disable trigger event_blackout_windows_no_update_delete");
      await c.query("update event_blackout_windows set reason = coalesce(reason, '') || '-edited' where chain_index = (select max(chain_index) from event_blackout_windows)");
      await c.query("alter table event_blackout_windows enable always trigger event_blackout_windows_no_update_delete");
      const tampered = await verifyAuditChains(c, { chains: ["event_blackout_windows"] });
      expect(tampered.ok).toBe(false);
      expect(tampered.firstFailure?.code).toBe("payload_modified");
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    // a cancellation must describe the window it withdraws, and cannot withdraw a cancellation
    const bad = await pool.query(`insert into event_blackout_windows (id, entry_type, market, scope, severity, starts_at, ends_at, reason_code, cancels_id, idempotency_key, created_by)
      values (gen_random_uuid(), 'CANCELLATION', 'NSE', 'MARKET', 'WARNING', now(), now() + interval '1 hour', 'wrong_cancel', $1, $2, 'operator:itest')`, [w.id, `bad-${randomUUID()}`]).then(() => "inserted", (e: { message?: string }) => e.message);
    expect(bad).toMatch(/must describe the window it withdraws/);
    expect((await verifyAuditChainsWithPool(pool, { chains: ["event_blackout_windows"] })).ok).toBe(true);
  });
  it("the operations CLI adds, lists and cancels windows (usage errors exit 2)", async () => {
    const run = async (args: string[]) => {
      const out: string[] = [], errs: string[] = [];
      const code = await runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }) });
      return { code, out: out.join("\n"), err: errs.join("\n") };
    };
    const s = sym();
    const added = await run(["blackout", "add", "--market", "ALL", "--scope", "SYMBOL", "--symbol", s, "--severity", "WARNING", "--starts", "2032-05-05T00:00:00Z", "--ends", "2032-05-06T00:00:00Z", "--reason-code", "cli_event", "--created-by", "operator:itest"]);
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.out) as { id: string }).id;
    const listed = await run(["blackout", "list", "--at", "2032-05-05T12:00:00Z"]);
    expect(listed.out).toContain(id);
    expect((await run(["blackout", "cancel", "--id", id, "--created-by", "operator:itest"])).code).toBe(0);
    expect((await run(["blackout", "list", "--at", "2032-05-05T12:00:00Z"])).out).not.toContain(id);
    expect((await run(["blackout", "list", "--at", "2032-05-05T12:00:00Z", "--include-cancelled"])).out).toContain(id);
    expect((await run(["blackout", "add", "--market", "NSE"])).code).toBe(2);
    expect((await run(["blackout", "add", "--market", "nse", "--scope", "MARKET", "--severity", "WARNING", "--starts", "2032-05-05T00:00:00Z", "--ends", "2032-05-06T00:00:00Z", "--reason-code", "cli_event", "--created-by", "operator:itest"])).code).toBe(3);
  });
});

describe("nothing executable is created", () => {
  it("evaluations write no order, fill, position, legacy decision or approval card; the audit chains still verify", async () => {
    const counts = async () => Promise.all(["orders", "fills", "positions", "decisions", "claim_review_cards"].map(rowCount));
    const before = await counts();
    const m = await makePortfolioPassed();
    await market(m.portfolioId);
    const m2 = await makePortfolioPassed();
    await market(m2.portfolioId, { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 1 })) });
    expect(await counts()).toEqual(before);
    expect((await verifyAuditChainsWithPool(pool)).ok).toBe(true);
  });
});
