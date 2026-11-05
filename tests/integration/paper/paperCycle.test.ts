/**
 * Paper trading cycle against REAL PostgreSQL. Simulation only: it reads risk decisions / approvals, writes only paper_* tables, and never creates an order, fill or position.
 * Synthetic decisions and an in-memory price source: no network, no broker.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { createPendingRiskDecisionForSignal, recordSourceIntelligence, type IntelligenceResolver } from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { createTrade, DEFAULT_PAPER_CONFIG, listPaperEvents, listPaperOutcomes, listPaperPositions, paperOutcomeStats, paperSummary, runPaperCycle, type PaperConfig, type PriceSource } from "../../../packages/paper/src/index";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
let state: InMemoryStateSource;
const db = () => handle.db;
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); state = inMemoryStateSource(); configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 }); });
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const n = async (t: string, where = "true") => Number(must((await q(`select count(*)::int as n from ${t} where ${where}`))[0])["n"]);
const synthetic: IntelligenceResolver = async (req) => ({ ...(validIntelligence() as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(randomUUID()).digest("hex") });
const cfg = (o: Partial<PaperConfig> = {}): PaperConfig => ({ ...DEFAULT_PAPER_CONFIG, enabled: true, slippageBps: 0, trail: { kind: "none" }, squareOffIstMinutes: null, ...o });
const env = { LIVE_TRADING: "false", TRADING_MODE: "paper" };
const NOW = new Date("2026-11-06T04:30:00.000Z");
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);
const prices = (sym: string, now: () => Date): PriceSource & { set: (p: number | null) => void } => { let p: number | null = null; return { set: (x) => { p = x; }, last: async (s) => (s === sym && p !== null ? { price: p, at: now().toISOString() } : null) }; };

async function makeDecision(): Promise<{ id: string; symbol: string }> {
  const symbol = `PP${randomLetters(8)}`;
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "pp-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110, 120, 130], signalTimestamp: new Date("2025-01-06T00:00:00Z") }).returning();
  await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100" } as never);
  const pending = await createPendingRiskDecisionForSignal(db(), must(signal).id);
  if (pending.skipped) throw new Error("no decision");
  return { id: (await recordSourceIntelligence(db(), pending.id, { resolve: synthetic })).id, symbol };
}
async function seedTrade(decisionId: string, symbol: string, o: Partial<Parameters<typeof createTrade>[0]> = {}): Promise<string> {
  const { trade } = createTrade({ id: randomUUID(), riskDecisionId: decisionId, symbol, side: "BUY", quantity: 100, entryPrice: 100, stop: 95, targets: [110, 120, 130], now: NOW.toISOString(), ...o });
  await db().insert(schema.paperTrades).values({ id: trade.id, riskDecisionId: decisionId, symbol, side: trade.side, state: trade.state, trade });
  return trade.id;
}
const SIM_FREE = ["orders", "fills", "positions"];

describe("paper cycle", () => {
  it("does nothing, and writes nothing, unless explicitly enabled", async () => {
    const before = await n("paper_trades");
    expect(await runPaperCycle(db(), { config: { ...cfg(), enabled: false }, prices: prices("X", () => NOW), env })).toMatchObject({ skipped: "PAPER_DISABLED", created: 0 });
    expect(await n("paper_trades")).toBe(before);
  });
  it("refuses to run with LIVE_TRADING on, outside paper mode, or with the kill switch set", async () => {
    const p = prices("X", () => NOW);
    await expect(runPaperCycle(db(), { config: cfg(), prices: p, env: { LIVE_TRADING: "true" } })).rejects.toThrow();
    await expect(runPaperCycle(db(), { config: cfg(), prices: p, env: { TRADING_MODE: "live" } })).rejects.toThrow();
    state.set({ KILL_SWITCH_ACTIVE: true });
    await expect(runPaperCycle(db(), { config: cfg(), prices: p, env })).rejects.toThrow();
  });
  it("walks a trade from pending entry to a full target exit, appending events and one immutable outcome", async () => {
    const d = await makeDecision(); const id = await seedTrade(d.id, d.symbol);
    let clock = NOW; const p = prices(d.symbol, () => clock); const run = () => runPaperCycle(db(), { config: cfg({ breakevenAfterTarget1: false }), prices: p, now: () => clock, env });
    p.set(103); expect(await run()).toMatchObject({ stepped: 1 }); // above the limit: still pending
    expect((await listPaperPositions(db(), p)).find((x) => x.tradeId === id)).toMatchObject({ state: "PENDING_ENTRY", unrealizedPnl: 0 });
    clock = at(1); p.set(100); await run();
    clock = at(2); p.set(104); await run();
    expect((await listPaperPositions(db(), p, { state: "OPEN" })).find((x) => x.tradeId === id)).toMatchObject({ state: "OPEN", fillPrice: 100, unrealizedPnl: 400, lastPrice: 104 });
    for (const [m, px] of [[3, 110], [4, 120], [5, 130]] as const) { clock = at(m); p.set(px); await run(); }
    const [row] = await q("select state, trade from paper_trades where id = $1", [id]);
    expect(row).toMatchObject({ state: "CLOSED" }); expect(row!["trade"]).toMatchObject({ closeReason: "TARGET", remainingQuantity: 0, realizedPnl: 1750 });
    expect((await listPaperEvents(db(), id)).map((e) => e.type)).toEqual(["ENTRY_FILLED", "TARGET_HIT", "TARGET_HIT", "TARGET_HIT", "CLOSED"]);
    expect((await listPaperEvents(db(), id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const outs = await listPaperOutcomes(db()); expect(outs.find((o) => o.tradeId === id)).toMatchObject({ outcome: "WIN", closeReason: "TARGET", rMultiple: 3.5 });
    expect((await paperOutcomeStats(db())).n).toBeGreaterThanOrEqual(1);
    expect((await paperSummary(db(), p)).realizedPnl).toBeGreaterThanOrEqual(1750);
  });
  it("stops out at the stop, ignores stale and missing prices, and a finished trade can never be changed or deleted", async () => {
    const d = await makeDecision(); const id = await seedTrade(d.id, d.symbol);
    let clock = NOW; const p = prices(d.symbol, () => clock); const run = () => runPaperCycle(db(), { config: cfg(), prices: p, now: () => clock, env });
    p.set(null); const none = await run(); expect(none.stepped).toBe(0); expect(none.noPrice).toBeGreaterThanOrEqual(1); // the database may hold other live paper trades, so counts are lower bounds
    const stale = { last: async () => ({ price: 100, at: new Date(clock.getTime() - 3_600_000).toISOString() }) }; const old = await runPaperCycle(db(), { config: cfg(), prices: stale, now: () => clock, env }); expect(old.stepped).toBe(0); expect(old.stalePrice).toBeGreaterThanOrEqual(1);
    clock = at(1); p.set(100); await run(); clock = at(2); p.set(94); expect((await run()).closed).toBeGreaterThanOrEqual(1);
    expect(await listPaperOutcomes(db())).toContainEqual(expect.objectContaining({ tradeId: id, outcome: "LOSS", closeReason: "STOP_LOSS" }));
    await expect(pool.query("update paper_trades set state = 'OPEN' where id = $1", [id])).rejects.toThrow(/finished paper trade/);
    await expect(pool.query("delete from paper_trades where id = $1", [id])).rejects.toThrow();
    await expect(pool.query("update paper_trade_events set type = 'CREATED' where trade_id = $1", [id])).rejects.toThrow();
    await expect(pool.query("delete from paper_outcomes where trade_id = $1", [id])).rejects.toThrow();
  });
  it("cancels an unfilled entry after its expiry even with no price, and squares off open trades at the session end", async () => {
    const d1 = await makeDecision(), d2 = await makeDecision();
    const pend = await seedTrade(d1.id, d1.symbol), open = await seedTrade(d2.id, d2.symbol);
    let clock = NOW; const p2 = prices(d2.symbol, () => clock);
    p2.set(100); await runPaperCycle(db(), { config: cfg(), prices: p2, now: () => clock, env }); // fills d2 (d1 has no price)
    clock = at(31); p2.set(102);
    await runPaperCycle(db(), { config: cfg({ squareOffIstMinutes: 0 }), prices: p2, now: () => clock, env });
    const rows = await q("select id, state, trade from paper_trades where id = any($1)", [[pend, open]]);
    expect(rows.find((r) => r["id"] === pend)).toMatchObject({ state: "CANCELLED" }); expect(rows.find((r) => r["id"] === open)).toMatchObject({ state: "CLOSED" });
    expect(rows.find((r) => r["id"] === open)!["trade"]).toMatchObject({ closeReason: "SQUARE_OFF", realizedPnl: 200 });
  });
  it("a human APPROVE on a decision that is not current produces no paper trade", async () => {
    const d = await makeDecision();
    await pool.query(`insert into risk_approvals (risk_decision_id, decision_version, action, actor, actor_context, decision_snapshot, evidence_references, valid_until) values ($1, 1, 'APPROVE', 'operator:paper-test', '{}', '{}', '{}', now() + interval '1 hour')`, [d.id]).catch(() => undefined);
    const r = await runPaperCycle(db(), { config: cfg(), prices: prices(d.symbol, () => NOW), now: () => NOW, env });
    expect(r.created).toBe(0);
    expect(await n("paper_trades", `risk_decision_id = '${d.id}'`)).toBe(0);
  });
  it("never creates an order, fill or position, and never alters the risk decision or approval tables", async () => {
    const [o, f, pz, a] = await Promise.all([...SIM_FREE.map((t) => n(t)), n("risk_approvals")]);
    const d = await makeDecision(); await seedTrade(d.id, d.symbol); const p = prices(d.symbol, () => NOW); p.set(100);
    await runPaperCycle(db(), { config: cfg(), prices: p, now: () => NOW, env });
    expect(await Promise.all([...SIM_FREE.map((t) => n(t)), n("risk_approvals")])).toEqual([o, f, pz, a]);
  });
});
