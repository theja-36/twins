import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FillsRelay, OrdersRelay, PortfolioRelay, PositionEventsRelay, PositionsRelay } from "./schemas.control";
import { relaySchemaFor } from "./schemas";

const S = JSON.parse(readFileSync(new URL("../../e2e/fixtures/paper.sample.json", import.meta.url), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

describe("paper relay schemas against REAL engine output", () => {
  it("orders: every real row passes, keeps its exact decimal STRINGS and scale, and a market order's limit price stays null", () => {
    const r = OrdersRelay.parse({ orders: S["orders"] }); expect(r.orders).toHaveLength(3); const entry = r.orders.find((o) => o.purpose === "ENTRY")!;
    expect(entry.quantity).toBe("4500"); expect(entry.filledQuantity).toBe("4500.00000000"); expect(entry.limitPrice).toBeNull(); expect(entry.positionId).toBeNull(); expect(typeof entry.avgFillPrice).toBe("string");
  });
  it("positions: `userId` and the free-form `rules` (fee schedule) are STRIPPED; everything the screens show is kept as strings", () => {
    expect(S["positionClosed"]).toHaveProperty("userId"); expect(S["positionClosed"]).toHaveProperty("rules"); // the real output has them
    const p = PositionsRelay.parse({ positions: [S["positionClosed"]] }).positions[0]!;
    expect(p).not.toHaveProperty("userId"); expect(p).not.toHaveProperty("rules"); expect(JSON.stringify(p)).not.toMatch(/sebiPct|brokerage|feeVersion|stampDuty/);
    expect(p.quantity).toBe("0"); expect(p.targets).toEqual(["104", "108", "112"]); expect(p.closedAt).toEqual(expect.any(String)); expect(typeof p.realizedPnl).toBe("string");
  });
  it("an OPEN position keeps exitReason and closedAt as explicit null", () => { const p = PositionsRelay.parse({ positions: [S["positionOpenVariant"]] }).positions[0]!; expect(p.exitReason).toBeNull(); expect(p.closedAt).toBeNull(); expect(p.status).toBe("OPEN"); });
  it("events: only `kind` and `at` survive; the payload (realised figures, ids, reconciliation detail) never reaches the browser", () => {
    expect(S["events"][0]).toHaveProperty("payload"); const r = PositionEventsRelay.parse({ events: S["events"] }); expect(r.events).toHaveLength(10);
    for (const e of r.events) expect(Object.keys(e).sort()).toEqual(["at", "kind"]); expect(JSON.stringify(r)).not.toMatch(/realizedPnl|openQuantity|repaired|differences|decisionId/);
  });
  it("fills keep price, quantity and costs as strings with their source", () => { const f = FillsRelay.parse({ fills: S["fillsEntry"] }).fills[0]!; expect(f.price).toBe("100.05000000"); expect(f.costs).toBe("53.45"); expect(f.priceSource).toBe("FIXTURE"); });
  it("portfolio: real facts pass; capital stays null (never 0); a profile in force gives strings and a version number", () => {
    const real = PortfolioRelay.parse(S["portfolioReal"]); expect(real.facts!.totalCapital).toBeNull(); expect(real.facts!.capitalProfileVersion).toBeNull(); expect(real.facts!.realizedPnl).toBe("6746.40"); expect(real.mode).toBe("PAPER");
    const cap = PortfolioRelay.parse(S["portfolioCapitalVariant"]); expect(cap.facts!.availableCapital).toBe("1500000.50"); expect(typeof cap.facts!.capitalProfileVersion).toBe("number");
  });
  it("portfolio facts may be null (stored as null, not as zeros)", () => { expect(PortfolioRelay.parse({ ...clone(S["portfolioReal"]), facts: null }).facts).toBeNull(); });
});

describe("a contract break refuses the WHOLE response", () => {
  const bad: Array<[string, () => unknown]> = [
    ["a numeric quantity", () => { const o = clone(S["orders"]); o[0].quantity = 4500; return { orders: o }; }],
    ["money that is not a decimal", () => { const o = clone(S["orders"]); o[0].avgFillPrice = "NaN"; return { orders: o }; }],
    ["an unknown order status", () => { const o = clone(S["orders"]); o[0].status = "EXECUTED_LIVE"; return { orders: o }; }],
    ["a numeric realised P&L on a position", () => ({ positions: [{ ...clone(S["positionClosed"]), realizedPnl: 6746.4 }] })],
    ["an unknown position status", () => ({ positions: [{ ...clone(S["positionClosed"]), status: "ARCHIVED" }] })],
    ["a numeric fill price", () => ({ fills: [{ ...clone(S["fillsEntry"][0]), price: 100.05 }] })],
  ];
  for (const [name, make] of bad) it(name, () => { const m = make() as Record<string, unknown>; const schema = "orders" in m ? OrdersRelay : "positions" in m ? PositionsRelay : FillsRelay; expect(schema.safeParse(m).success).toBe(false); });
  it("a portfolio in LIVE mode, or with numeric capital", () => {
    expect(PortfolioRelay.safeParse({ ...clone(S["portfolioReal"]), mode: "LIVE" }).success).toBe(false);
    const c = clone(S["portfolioCapitalVariant"]); c.facts.totalCapital = 2000000; expect(PortfolioRelay.safeParse(c).success).toBe(false);
  });
  it("the relay uses these schemas for the five routes (not the pass-through object)", () => { for (const id of ["orders.list", "orders.fills", "positions.list", "positions.events", "portfolio.get"]) expect(relaySchemaFor(id).safeParse({ unrelated: true }).success, id).toBe(false); });
});
