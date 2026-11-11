/**
 * Stage 07 concurrency against REAL PostgreSQL (G-47): several workers repairing the SAME committed fill at the same moment. A fill is the source of truth; the position and its events are derived from it. Whatever the interleaving,
 * the position must end with the right quantity and value and exactly ONE event must be recorded per logical change (ENTRY_FILL for a later entry fill, PARTIAL_EXIT for a partial exit, CLOSED for the closing exit, with one trade
 * outcome). Also: concurrent execution requests for one decision must all converge on a single order (the order insert is check-then-insert and is serialised per key).
 * Synthetic data, FIXTURE prices, Monday 10:30 IST in 2031. The connection is a superuser (it bypasses row-level security, not triggers or constraints).
 */
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { approveDecision } from "../../../packages/decision/src/index";
import { createDb, createPaperOrder, getDecision, getExecutionRequest, getPositionForDecision, insertPaperFill, listPaperFills, listPaperOrders, setOrderStatus, getCandidate, advanceOrderStatus } from "../../../packages/database/src/index";
import { requestPaperExecution, rulesFor, syncPosition } from "../../../packages/execution/src/index";
import { beforeNthStatement } from "../../support/crashHold";
import { makeFixtures, NOW, pricesFor } from "../../support/executionFixtures";
import { FEES, SPEC } from "../../unit/planning/fixtures";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl();
const db = createDb(URL_), fx = makeFixtures(db), clients: pg.Client[] = [];
let ownerClient: pg.Client | null = null;
async function owner(): Promise<pg.Client> { if (!ownerClient) { ownerClient = new pg.Client({ connectionString: URL_ }); await ownerClient.connect(); clients.push(ownerClient); } return ownerClient; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });

const WORKERS = 8;
const events = async (decisionId: string) => (await (await owner()).query("select e.kind, count(*)::int as n from paper_position_events e join paper_positions p on p.id = e.position_id where p.decision_id = $1 group by e.kind order by e.kind", [decisionId])).rows as Array<{ kind: string; n: number }>;
const eventCount = async (decisionId: string, kind: string): Promise<number> => (await events(decisionId)).find((e) => e.kind === kind)?.n ?? 0;
const positionRow = async (decisionId: string) => (await (await owner()).query("select id, status, quantity::float8 as quantity, avg_entry_price::float8 as avg, realized_pnl::float8 as pnl from paper_positions where decision_id = $1", [decisionId])).rows;
const outcomes = async (decisionId: string): Promise<number> => (await (await owner()).query("select count(*)::int as n from trade_outcomes where decision_id = $1", [decisionId])).rows[0].n as number;
const fillsOf = async (decisionId: string) => (await (await owner()).query("select f.id, f.quantity::float8 as q, f.price::float8 as p from paper_fills f join paper_orders o on o.id = f.order_id where o.decision_id = $1 order by f.filled_at, f.id", [decisionId])).rows as Array<{ id: string; q: number; p: number }>;

describe("workers repairing the same fill concurrently (G-47)", () => {
  it("a later ENTRY fill, an exit fill and the closing fill are each applied once: correct quantity and value, exactly one event per change, one outcome", async () => {
    const c = await owner();
    const p = await fx.pipeline(async (text, params) => c.query(text, params as unknown[]));
    expect(p.outcome).toBe("QUALIFIED");
    await approveDecision(fx.evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const dec0 = (await getDecision(db, p.userId, p.decisionId))!, qty = dec0.permittedSize!.quantity, cand = (await getCandidate(db, dec0.candidateId))!;
    const deps = fx.execDeps(pricesFor(p.u), { fillFraction: 0.4, orderTtlMinutes: 1e9 }), rules = rulesFor(deps, SPEC.lotSize, cand, FEES, dec0, "equity");

    // 1. the entry fills in part: the position opens for the first step
    const first = await requestPaperExecution(deps, { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(first.status).toBe("PARTIALLY_FILLED");
    const entry = (await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 }))[0]!;
    expect(await eventCount(p.decisionId, "OPENED")).toBe(1);
    const firstQty = Number(entry.filledQuantity), laterQty = qty - firstQty;
    expect(laterQty).toBeGreaterThan(0);

    // 2. a later fill COMMITS and its worker dies before the position is updated; EIGHT workers repair it at once
    expect(await insertPaperFill(db, p.userId, { orderId: entry.id, quantity: String(laterQty), price: "100.20000000", costs: "7.00", priceSource: "FIXTURE", priceAsOf: NOW, expectedFilledQuantity: entry.filledQuantity })).not.toBeNull();
    expect(Number((await positionRow(p.decisionId))[0]!.quantity)).toBe(firstQty); // the position is behind its fills
    await Promise.all(Array.from({ length: WORKERS }, () => syncPosition(deps, { userId: p.userId, decision: dec0, rules })));
    const fills1 = await fillsOf(p.decisionId), expectedAvg = fills1.reduce((a, f) => a + f.q * f.p, 0) / fills1.reduce((a, f) => a + f.q, 0);
    const pos1 = (await positionRow(p.decisionId))[0]!;
    expect(fills1).toHaveLength(2); expect(pos1.quantity).toBe(qty); expect(pos1.avg).toBeCloseTo(expectedAvg, 6);
    expect(await eventCount(p.decisionId, "ENTRY_FILL")).toBe(1); // ONE update event for the one later fill
    expect(await eventCount(p.decisionId, "OPENED")).toBe(1);
    await Promise.all(Array.from({ length: WORKERS }, () => syncPosition(deps, { userId: p.userId, decision: dec0, rules }))); // repeating changes nothing
    expect(await eventCount(p.decisionId, "ENTRY_FILL")).toBe(1); expect((await positionRow(p.decisionId))[0]!.quantity).toBe(qty);

    // 3. a PARTIAL exit fill commits; eight workers repair it at once
    const rq = (await getExecutionRequest(db, p.userId, p.decisionId, "PAPER"))!, posId = pos1.id as string;
    const exitOrder = async (quantity: number, key: string) => {
      const { order } = await createPaperOrder(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, executionRequestId: rq.id, positionId: posId, purpose: "EXIT", exitReason: "TARGET_HIT", instrument: cand.underlying, exchange: cand.exchange, side: "SELL", orderType: "MARKET", quantity: String(quantity), limitPrice: null, idempotencyKey: key });
      await setOrderStatus(db, p.userId, order.id, "SUBMITTED", "t"); await setOrderStatus(db, p.userId, order.id, "ACCEPTED", "t"); return order;
    };
    const x1 = 1000, o1 = await exitOrder(x1, `exit-1:${p.decisionId}`);
    expect(await insertPaperFill(db, p.userId, { orderId: o1.id, quantity: String(x1), price: "101.00000000", costs: "6.00", priceSource: "FIXTURE", priceAsOf: NOW, expectedFilledQuantity: "0" })).not.toBeNull();
    await Promise.all(Array.from({ length: WORKERS }, () => syncPosition(deps, { userId: p.userId, decision: dec0, rules })));
    const pos2 = (await positionRow(p.decisionId))[0]!;
    expect(pos2.status).toBe("OPEN"); expect(pos2.quantity).toBe(qty - x1);
    expect(pos2.pnl).toBeCloseTo(x1 * (101 - expectedAvg), 1); // realised on the exited part only
    expect(await eventCount(p.decisionId, "PARTIAL_EXIT")).toBe(1);
    expect(await outcomes(p.decisionId)).toBe(0);

    // 4. the CLOSING exit fill commits; eight workers repair it at once: one CLOSED event, one outcome
    const x2 = qty - x1, o2 = await exitOrder(x2, `exit-2:${p.decisionId}`);
    expect(await insertPaperFill(db, p.userId, { orderId: o2.id, quantity: String(x2), price: "102.00000000", costs: "9.00", priceSource: "FIXTURE", priceAsOf: NOW, expectedFilledQuantity: "0" })).not.toBeNull();
    await Promise.all(Array.from({ length: WORKERS }, () => syncPosition(deps, { userId: p.userId, decision: dec0, rules })));
    const pos3 = (await positionRow(p.decisionId))[0]!;
    expect(pos3.status).toBe("CLOSED"); expect(pos3.quantity).toBe(0);
    expect(pos3.pnl).toBeCloseTo(x1 * (101 - expectedAvg) + x2 * (102 - expectedAvg), 1);
    expect(await eventCount(p.decisionId, "CLOSED")).toBe(1);
    expect(await eventCount(p.decisionId, "PARTIAL_EXIT")).toBe(1);
    expect(await eventCount(p.decisionId, "ENTRY_FILL")).toBe(1);
    expect(await outcomes(p.decisionId)).toBe(1);
    // no fill was ever duplicated by any repair
    expect((await fillsOf(p.decisionId)).map((f) => f.q)).toEqual([...fills1.map((f) => f.q), x1, x2]);
    expect((await listPaperFills(db, p.userId, entry.id)).reduce((a, f) => a + Number(f.quantity), 0)).toBe(qty);
  }, 120_000);

  it("concurrent execution requests for one decision (same and different request keys) all converge on one order, one position and one OPENED event", async () => {
    const c = await owner();
    const p = await fx.pipeline(async (text, params) => c.query(text, params as unknown[]));
    await approveDecision(fx.evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const qty = (await getDecision(db, p.userId, p.decisionId))!.permittedSize!.quantity, deps = fx.execDeps(pricesFor(p.u));
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => requestPaperExecution(deps, { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: i < 4 ? "exec-conc-same-1" : `exec-conc-diff-${i}` })));
    for (const o of outs) expect(["FILLED", "PARTIALLY_FILLED", "ORDER_OPEN"]).toContain(o.status);
    expect(await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 20 })).toHaveLength(1);
    const fills = await fillsOf(p.decisionId);
    expect(fills.reduce((a, f) => a + f.q, 0)).toBe(qty);
    const pos = await positionRow(p.decisionId);
    expect(pos).toHaveLength(1); expect(pos[0]!.quantity).toBe(qty);
    expect(await eventCount(p.decisionId, "OPENED")).toBe(1);
    expect((await getPositionForDecision(db, p.userId, p.decisionId))?.status).toBe("OPEN");
  }, 120_000);

  it("concurrent execution requests never fail: across repeated rounds every caller gets a normal result and each decision ends with one order, one position and one OPENED event (no stale status step)", async () => {
    const c = await owner();
    for (let round = 0; round < 8; round++) {
      const p = await fx.pipeline(async (text, params) => c.query(text, params as unknown[]));
      await approveDecision(fx.evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
      const qty = (await getDecision(db, p.userId, p.decisionId))!.permittedSize!.quantity, deps = fx.execDeps(pricesFor(p.u));
      const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => requestPaperExecution(deps, { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: i < 5 ? "exec-conc-same-1" : `exec-conc-diff-${i}` })));
      expect(settled.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason?.cause?.message ?? (x as PromiseRejectedResult).reason)), `round ${round}`).toEqual([]);
      for (const x of settled) expect(["FILLED", "PARTIALLY_FILLED", "ORDER_OPEN"]).toContain((x as PromiseFulfilledResult<{ status: string }>).value.status);
      expect(await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 20 })).toHaveLength(1);
      expect((await fillsOf(p.decisionId)).reduce((a, f) => a + f.q, 0)).toBe(qty);
      expect(await positionRow(p.decisionId)).toHaveLength(1); expect(await eventCount(p.decisionId, "OPENED")).toBe(1);
    }
  }, 180_000);

  it("a caller whose order is advanced by a rival between its own status steps still gets a normal result: the stale step is a no-op, not an error", async () => {
    const c = await owner(), p = await fx.pipeline(async (text, params) => c.query(text, params as unknown[]));
    await approveDecision(fx.evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const qty = (await getDecision(db, p.userId, p.decisionId))!.permittedSize!.quantity;
    // the rival completes the WHOLE entry (accept, then fill in full) on another connection, exactly between this caller's SUBMITTED and ACCEPTED steps
    const rival = async (): Promise<void> => {
      const o = (await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 }))[0]!;
      await setOrderStatus(db, p.userId, o.id, "ACCEPTED", "rival acknowledged");
      expect(await insertPaperFill(db, p.userId, { orderId: o.id, quantity: String(qty), price: "100.05000000", costs: "10.00", priceSource: "FIXTURE", priceAsOf: NOW, expectedFilledQuantity: "0" })).not.toBeNull();
    };
    const hooked = makeFixtures(beforeNthStatement(db, { match: /update paper_orders set status/, nth: 2, action: rival }));
    hooked.instruments.push({ ...hooked.spec, underlying: p.u });
    const out = await requestPaperExecution(hooked.execDeps(pricesFor(p.u)), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(out).toMatchObject({ status: "FILLED", filledQuantity: String(qty) });
    expect(await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 20 })).toHaveLength(1);
    expect(await fillsOf(p.decisionId)).toHaveLength(1); // only the rival's fill: the stale caller added none
    expect(await positionRow(p.decisionId)).toHaveLength(1); expect(await eventCount(p.decisionId, "OPENED")).toBe(1); // and its follow-up repaired the position exactly once
  }, 120_000);

  it("advancing an order is compare-and-set: it applies only from the expected state, once, and is a quiet no-op when the order has moved on", async () => {
    const c = await owner(), a = await fx.openPosition(async (t, q) => c.query(t, q as unknown[])); // a FILLED entry order
    expect(await advanceOrderStatus(db, a.userId, a.entry.id, "SUBMITTED", "ACCEPTED", "stale step")).toBe(false); // it is FILLED: nothing happens, nothing throws
    const p2 = await fx.pipeline(async (t, q) => c.query(t, q as unknown[]));
    await approveDecision(fx.evalDeps(), { userId: p2.userId, decisionId: p2.decisionId, idempotencyKey: "approve-key-0001" });
    const rq = await requestPaperExecution(fx.execDeps(pricesFor(p2.u, () => false)), { userId: p2.userId, decisionId: p2.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(rq.status).toBe("ORDER_OPEN"); // ACCEPTED, unfilled
    const ord = (await listPaperOrders(db, p2.userId, { decisionId: p2.decisionId, limit: 5 }))[0]!;
    expect(await advanceOrderStatus(db, p2.userId, ord.id, "SUBMITTED", "ACCEPTED", "x")).toBe(false); // already ACCEPTED
    expect((await listPaperOrders(db, p2.userId, { decisionId: p2.decisionId, limit: 5 }))[0]!.status).toBe("ACCEPTED");
  }, 120_000);
});
