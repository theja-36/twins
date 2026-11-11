/**
 * Recovery of a worker that died AFTER an order fill committed and BEFORE the position / request were updated (G-47). The database is replaced by an in-memory store that mimics the SQL semantics that matter here
 * (a unique position per decision with conflict-safe creation, fills as the source of truth, the request state), so the REAL execution code (`healEntryFill`, `syncPosition`, `fillOrder`, `requestPaperExecution`,
 * `advanceOpenOrders`) runs unchanged. The SQL itself and a real SIGKILL are covered in CI (tests/integration/runtime/executionCrashRecovery.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Order { id: string; userId: string; decisionId: string; purpose: "ENTRY" | "EXIT"; status: string; quantity: string; filledQuantity: string; instrument: string; exchange: string; side: "BUY" | "SELL"; createdAt: Date; exitReason: string | null; orderType: string; limitPrice: string | null }
interface Fill { id: string; orderId: string; quantity: number; price: number; costs: number }
interface Pos { id: string; userId: string; accountId: string; decisionId: string; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: string; initialQuantity: string; avgEntryPrice: string; initialStop: string; status: string; realizedPnl: string; realizedCosts: string; rules: unknown; openedAt: Date; stopLoss: string; targets: string[] }
const store = vi.hoisted(() => ({
  orders: [] as Order[], fills: [] as Fill[], positions: [] as Pos[], request: { id: "rq1", state: "ELIGIBLE", checks: [] as unknown[] } as { id: string; state: string; checks: unknown[] } | null,
  events: [] as Array<{ kind: string }>, monitoring: [] as Array<{ kind: string }>, calls: [] as string[], invalidated: 0, createdOrders: 0, insertedFills: 0, updateEntryCalls: 0,
}));

vi.mock("@twins/database", async (orig) => {
  const real = await orig<typeof import("@twins/database")>();
  const D = "d1", U = "u1";
  const cand = { id: "c1", underlying: "ACME", exchange: "NSE", side: "BUY", strike: null, optionType: null, expiry: null, stopLoss: 98, targets: [104, 108, 112] };
  const dec = { id: D, userId: U, accountId: "a1", candidateId: "c1", permittedSize: { quantity: 100, maxLossAtStop: "200" }, workflowState: "APPROVED", outcome: "QUALIFIED", invalidated: null };
  const tick = () => Promise.resolve();
  const entryQty = (): number => store.fills.filter((f) => store.orders.find((o) => o.id === f.orderId)?.purpose === "ENTRY").reduce((a, f) => a + f.quantity, 0);
  return {
    ...real,
    getDecision: async () => dec, getCandidate: async () => cand,
    getExecutionRequest: async () => store.request,
    updateExecutionRequest: async (_d: unknown, _u: string, _id: string, state: string) => { store.calls.push(`request:${state}`); if (store.request) store.request.state = state; },
    listPaperOrders: async (_d: unknown, _u: string, o: { statuses?: readonly string[] }) => store.orders.filter((x) => !o.statuses || o.statuses.includes(x.status)),
    getPaperOrder: async (_d: unknown, _u: string, id: string) => store.orders.find((x) => x.id === id) ?? null,
    fillTotalsForDecision: async () => {
      const sums = (p: string) => store.fills.filter((f) => store.orders.find((o) => o.id === f.orderId)?.purpose === p);
      const q = (p: string) => sums(p).reduce((a, f) => a + f.quantity, 0), v = (p: string) => sums(p).reduce((a, f) => a + f.quantity * f.price, 0);
      return { entryQty: String(q("ENTRY")), entryValue: String(v("ENTRY")), exitQty: String(q("EXIT")), exitValue: String(v("EXIT")), costs: String(store.fills.reduce((a, f) => a + f.costs, 0)) };
    },
    getPositionForDecision: async () => { await tick(); await tick(); return store.positions[0] ?? null; }, // yields, so two racing workers can both see "no position"
    listPaperPositions: async () => store.positions,
    createPaperPositionOnce: async (_d: unknown, userId: string, p: Omit<Pos, "id" | "userId" | "status" | "realizedPnl" | "realizedCosts" | "openedAt" | "initialStop">) => {
      store.calls.push("createOnce");
      const existing = store.positions[0]; if (existing) return { position: existing, created: false };
      const pos: Pos = { ...p, id: "p1", userId, initialStop: p.stopLoss, status: "OPEN", realizedPnl: "0", realizedCosts: "0", openedAt: new Date() }; store.positions.push(pos); return { position: pos, created: true };
    },
    addPositionEvent: async (_d: unknown, _u: string, _id: string, kind: string) => { store.events.push({ kind }); },
    addMonitoringEvent: async (_d: unknown, _u: string, e: { kind: string }) => { store.monitoring.push({ kind: e.kind }); },
    // conditional on the target state and atomic with its event, like the SQL (UPDATE ... WHERE differs, event in the same transaction)
    applyPositionEntrySync: async (_d: unknown, _u: string, _id: string, p: { quantity: string; avgEntryPrice: string }) => {
      const pos = store.positions[0]; if (!pos || (Number(pos.quantity) === Number(p.quantity) && Number(pos.avgEntryPrice) === Number(p.avgEntryPrice))) return false;
      pos.quantity = p.quantity; pos.avgEntryPrice = p.avgEntryPrice; store.updateEntryCalls++; store.events.push({ kind: "ENTRY_FILL" }); return true;
    },
    listActiveAccounts: async () => [{ accountId: "a1", userId: U }],
    // the same three conditions as the SQL
    listDecisionsNeedingPositionSync: async () => {
      const e = store.orders.find((o) => o.purpose === "ENTRY" && Number(o.filledQuantity) > 0); if (!e) return [];
      const pos = store.positions[0], net = entryQty();
      const need = !pos || (pos.status === "OPEN" && Number(pos.quantity) !== net) || (e.status === "FILLED" && store.request?.state === "ELIGIBLE");
      return need ? [D] : [];
    },
    // anything that would create new orders / fills / invalidations must never be called on a recovery path
    createPaperOrder: async () => { store.createdOrders++; throw new Error("createPaperOrder must not be called when recovering"); },
    insertPaperFill: async () => { store.insertedFills++; throw new Error("insertPaperFill must not be called when recovering"); },
    invalidateDecision: async () => { store.invalidated++; },
  };
});

import { memorySpecProvider } from "@twins/planning";
import { advanceOpenOrders, DEFAULT_EXECUTION_CONFIG, healEntryFill, fillOrder, requestPaperExecution, rulesFor, type ExecutionDeps } from "../../../packages/execution/src/index";
import { FEES, SPEC } from "../planning/fixtures";

const NOW = new Date("2031-01-06T05:00:00Z");
const deps = (): ExecutionDeps => ({ eval: { db: {} as never, specs: memorySpecProvider({ instruments: [{ ...SPEC, underlying: "ACME" }], fees: [FEES] }), now: () => NOW } as never, prices: null, config: { ...DEFAULT_EXECUTION_CONFIG, enabled: true, managementEnabled: true } });
const decision = { id: "d1", userId: "u1", accountId: "a1", candidateId: "c1", permittedSize: { quantity: 100, maxLossAtStop: "200" }, workflowState: "APPROVED", outcome: "QUALIFIED", invalidated: null } as never;
const cand = { expiry: null, strike: null, optionType: null };
const rules = () => rulesFor(deps(), SPEC.lotSize, cand, FEES, decision, "equity");

/** The state a SIGKILL leaves: the fill is committed and the order is FILLED, but there is no position and the request is still ELIGIBLE. */
function crashedState(): void {
  store.orders.length = 0; store.fills.length = 0; store.positions.length = 0; store.events.length = 0; store.monitoring.length = 0; store.calls.length = 0;
  store.request = { id: "rq1", state: "ELIGIBLE", checks: [] }; store.invalidated = 0; store.createdOrders = 0; store.insertedFills = 0; store.updateEntryCalls = 0;
  store.orders.push({ id: "o1", userId: "u1", decisionId: "d1", purpose: "ENTRY", status: "FILLED", quantity: "100", filledQuantity: "100", instrument: "ACME", exchange: "NSE", side: "BUY", createdAt: NOW, exitReason: null, orderType: "MARKET", limitPrice: null });
  store.fills.push({ id: "f1", orderId: "o1", quantity: 100, price: 100.05, costs: 10 });
}
const snapshot = () => JSON.stringify({ fills: store.fills, orders: store.orders, positions: store.positions, events: store.events, monitoring: store.monitoring, request: store.request });

describe("a fill committed before the position was written (G-47)", () => {
  beforeEach(crashedState);

  it("healEntryFill creates the position from the fill exactly once, opens it once and completes the request", async () => {
    const after = await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision: decision, rules: rules() });
    expect(after.status).toBe("FILLED");
    expect(store.positions).toHaveLength(1);
    expect(store.positions[0]).toMatchObject({ status: "OPEN", quantity: "100.00000000", initialQuantity: "100" });
    expect(Number(store.positions[0]?.avgEntryPrice)).toBe(100.05);
    expect(store.events).toEqual([{ kind: "OPENED" }]); expect(store.monitoring).toEqual([{ kind: "ENTRY_FILLED" }]);
    expect(store.request?.state).toBe("COMPLETED");
    expect(store.fills).toHaveLength(1); expect(store.insertedFills).toBe(0);
  });

  it("running it again, or after a restart, changes nothing (idempotent)", async () => {
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() });
    const once = snapshot();
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() });
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() });
    expect(snapshot()).toBe(once); expect(store.updateEntryCalls).toBe(0);
  });

  it("two workers healing at the same moment still produce one position and one opening event", async () => {
    await Promise.all([healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() }), healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() })]);
    expect(store.calls.filter((c) => c === "createOnce")).toHaveLength(2); // both tried to create it ...
    expect(store.positions).toHaveLength(1); // ... the unique position took one
    expect(store.events).toEqual([{ kind: "OPENED" }]); expect(store.monitoring).toEqual([{ kind: "ENTRY_FILLED" }]); // only the creator recorded the opening
    expect(store.request?.state).toBe("COMPLETED"); expect(store.fills).toHaveLength(1);
  });

  it("fillOrder on an order that is already FILLED repairs the position instead of returning early", async () => {
    const r = await fillOrder(deps(), { userId: "u1", orderId: "o1", fees: FEES, lotSize: SPEC.lotSize, decision, rules: rules() });
    expect(r).toMatchObject({ status: "FILLED", filledQuantity: "100" });
    expect(store.positions).toHaveLength(1); expect(store.request?.state).toBe("COMPLETED"); expect(store.insertedFills).toBe(0);
  });

  it("a retried execution request repairs the follow-up: no new order, no new fill, and it never re-validates (so it cannot invalidate) the filled entry", async () => {
    const out = await requestPaperExecution(deps(), { userId: "u1", decisionId: "d1", mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(out).toMatchObject({ status: "FILLED", duplicate: true, orderId: "o1", filledQuantity: "100" });
    expect(store.createdOrders).toBe(0); expect(store.insertedFills).toBe(0); expect(store.invalidated).toBe(0);
    expect(store.positions).toHaveLength(1); expect(store.request?.state).toBe("COMPLETED");
    const once = snapshot();
    expect(await requestPaperExecution(deps(), { userId: "u1", decisionId: "d1", mode: "PAPER", idempotencyKey: "exec-key-00001" })).toMatchObject({ status: "FILLED", duplicate: true });
    expect(snapshot()).toBe(once);
  });

  it("the worker cycle finds the committed fill on its own (healed: 1), and the next cycle finds nothing", async () => {
    const first = await advanceOpenOrders(deps());
    expect(first).toMatchObject({ healed: 1, filled: 0 });
    expect(store.positions).toHaveLength(1); expect(store.events).toEqual([{ kind: "OPENED" }]); expect(store.request?.state).toBe("COMPLETED");
    const once = snapshot();
    expect(await advanceOpenOrders(deps())).toMatchObject({ healed: 0 });
    expect(snapshot()).toBe(once);
    expect(store.insertedFills).toBe(0); expect(store.createdOrders).toBe(0);
  });

  it("a position that is behind its fills (a second fill committed, position not yet updated) is brought in line, with no new fill", async () => {
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() }); // position for the first 100
    store.orders[0] = { ...(store.orders[0] as Order), status: "PARTIALLY_FILLED", quantity: "150", filledQuantity: "150" };
    store.fills.push({ id: "f2", orderId: "o1", quantity: 50, price: 100.15, costs: 5 }); // committed, position still says 100
    store.request = { id: "rq1", state: "ELIGIBLE", checks: [] };
    const r = await advanceOpenOrders(deps());
    expect(r.healed).toBe(1);
    expect(store.fills).toHaveLength(2); expect(store.insertedFills).toBe(0);
    expect(store.updateEntryCalls).toBe(1);
  });

  it("two workers repairing the same LATER fill at once record exactly one ENTRY_FILL and the correct totals", async () => {
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() });
    store.orders[0] = { ...(store.orders[0] as Order), status: "PARTIALLY_FILLED", quantity: "150", filledQuantity: "150" };
    store.fills.push({ id: "f2", orderId: "o1", quantity: 50, price: 100.15, costs: 5 });
    await Promise.all([1, 2, 3, 4].map(() => healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() })));
    expect(store.events.filter((e) => e.kind === "ENTRY_FILL")).toHaveLength(1);
    expect(Number(store.positions[0]?.quantity)).toBe(150);
    expect(Number(store.positions[0]?.avgEntryPrice)).toBeCloseTo((100 * 100.05 + 50 * 100.15) / 150, 6);
  });

  it("a healthy system has nothing to heal: no position-less fill, matching quantity, completed request", async () => {
    await healEntryFill(deps(), { userId: "u1", orderId: "o1", decision, rules: rules() });
    expect((await advanceOpenOrders(deps())).healed).toBe(0);
  });

  it("a decision whose specification or fee schedule is unavailable is left for the next cycle, never guessed at", async () => {
    const d = deps(); (d.eval as { specs: unknown }).specs = memorySpecProvider({ instruments: [], fees: [FEES] });
    expect((await advanceOpenOrders(d)).healed).toBe(0);
    expect(store.positions).toHaveLength(0); expect(store.request?.state).toBe("ELIGIBLE");
  });
});
