import { describe, expect, it } from "vitest";
import { createTrade, exitNow, step, DEFAULT_PAPER_CONFIG, PaperTradeError, rMultiple, unrealizedPnl, type PaperConfig, type PaperTrade } from "../../../packages/paper/src/index";

const cfg = (o: Partial<PaperConfig> = {}): PaperConfig => ({ ...DEFAULT_PAPER_CONFIG, slippageBps: 0, trail: { kind: "none" }, ...o });
const T0 = "2026-11-06T04:00:00.000Z";
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const buy = (o: Partial<Parameters<typeof createTrade>[0]> = {}): PaperTrade => createTrade({ id: "t1", riskDecisionId: "d1", symbol: "NIFTY", side: "BUY", quantity: 100, entryPrice: 100, stop: 95, targets: [110, 120, 130], now: T0, ...o }).trade;
const run = (t: PaperTrade, ticks: Array<[number, number]>, c: PaperConfig): PaperTrade => ticks.reduce((acc, [m, p]) => step(acc, { price: p, at: at(m) }, c).trade, t);

describe("createTrade validation", () => {
  const bad = (o: Partial<Parameters<typeof createTrade>[0]>, code: string) => expect(() => buy(o)).toThrow(new PaperTradeError(code));
  it("refuses incoherent trades", () => {
    bad({ stop: 105 }, "stop_side"); bad({ side: "SELL" }, "stop_side"); bad({ targets: [90] }, "target_order"); bad({ targets: [110, 105] }, "target_order"); bad({ targets: [] }, "targets");
    bad({ targets: [110, 120, 130, 140] }, "targets"); bad({ quantity: 0 }, "quantity"); bad({ quantity: 1.5 }, "quantity"); bad({ entryPrice: NaN }, "price"); bad({ symbol: "a;b" }, "symbol"); bad({ stop: -1 }, "price");
  });
  it("starts pending, with a CREATED event and no fill", () => {
    const { trade, events } = createTrade({ id: "t", riskDecisionId: "d", symbol: "NIFTY", side: "SELL", quantity: 10, entryPrice: 100, stop: 105, targets: [95], now: T0 });
    expect(trade).toMatchObject({ state: "PENDING_ENTRY", fillPrice: null, remainingQuantity: 10, stop: 105 }); expect(events.map((e) => e.type)).toEqual(["CREATED"]);
  });
});

describe("entry", () => {
  it("fills a BUY limit when the price is at or below it, never worse than the limit (even with slippage)", () => {
    const c = cfg({ slippageBps: 100 });
    expect(step(buy(), { price: 101, at: at(1) }, c).trade.state).toBe("PENDING_ENTRY");
    const f = step(buy(), { price: 99.8, at: at(1) }, c);
    expect(f.trade).toMatchObject({ state: "OPEN" }); expect(f.trade.fillPrice).toBeLessThanOrEqual(100); expect(f.events.map((e) => e.type)).toEqual(["ENTRY_FILLED"]);
  });
  it("fills a SELL limit when the price is at or above it, never below the limit", () => {
    const s = createTrade({ id: "s", riskDecisionId: "d", symbol: "X", side: "SELL", quantity: 10, entryPrice: 100, stop: 105, targets: [90], now: T0 }).trade;
    const f = step(s, { price: 100.4, at: at(1) }, cfg({ slippageBps: 100 }));
    expect(f.trade.state).toBe("OPEN"); expect(f.trade.fillPrice).toBeGreaterThanOrEqual(100);
  });
  it("cancels a pending entry after the expiry, and when the stop level is breached first", () => {
    expect(step(buy(), { price: 101, at: at(30) }, cfg()).trade).toMatchObject({ state: "CANCELLED", cancelReason: "ENTRY_EXPIRED" });
    expect(step(buy(), { price: 94, at: at(1) }, cfg()).trade).toMatchObject({ state: "CANCELLED", cancelReason: "STOP_BREACHED_BEFORE_ENTRY" });
  });
  it("ignores bad ticks and ticks for finished trades", () => {
    const t = buy();
    expect(step(t, { price: NaN, at: at(1) }, cfg()).trade).toBe(t); expect(step(t, { price: 100, at: "nope" }, cfg()).events).toEqual([]);
    const done = { ...t, state: "CLOSED" as const }; expect(step(done, { price: 100, at: at(1) }, cfg()).trade).toBe(done);
  });
});

describe("stop loss", () => {
  it("exits everything at the stop, books the loss, and reports STOP_LOSS", () => {
    const t = run(buy(), [[1, 100], [2, 95]], cfg());
    expect(t).toMatchObject({ state: "CLOSED", closeReason: "STOP_LOSS", remainingQuantity: 0, realizedPnl: -500 });
  });
  it("a gap through the stop fills at the gap price, not at the stop", () => {
    const t = run(buy(), [[1, 100], [2, 90]], cfg());
    expect(t.exits[0]!.price).toBe(90); expect(t.realizedPnl).toBe(-1000);
  });
  it("applies adverse slippage to stop exits", () => {
    const t = run(buy(), [[1, 100], [2, 95]], cfg({ slippageBps: 100 }));
    expect(t.exits[0]!.price).toBeLessThan(95);
  });
  it("a SELL stop works the other way", () => {
    const s = createTrade({ id: "s", riskDecisionId: "d", symbol: "X", side: "SELL", quantity: 10, entryPrice: 100, stop: 105, targets: [90], now: T0 }).trade;
    const t = run(s, [[1, 100], [2, 106]], cfg());
    expect(t).toMatchObject({ state: "CLOSED", closeReason: "STOP_LOSS" }); expect(t.realizedPnl).toBe(-60);
  });
});

describe("targets, break-even and trailing", () => {
  it("scales out 50/25/25 and closes at the last target", () => {
    const t = run(buy(), [[1, 100], [2, 110], [3, 120], [4, 130]], cfg({ breakevenAfterTarget1: false }));
    expect(t.exits.map((e) => e.quantity)).toEqual([50, 25, 25]); expect(t).toMatchObject({ state: "CLOSED", closeReason: "TARGET", realizedPnl: 50 * 10 + 25 * 20 + 25 * 30 });
  });
  it("a gap over several targets books each in order at its own price", () => {
    const t = run(buy(), [[1, 100], [2, 125]], cfg({ breakevenAfterTarget1: false }));
    expect(t.targetsHit).toBe(2); expect(t.exits.map((e) => e.price)).toEqual([110, 120]); expect(t.remainingQuantity).toBe(25);
  });
  it("moves the stop to break-even after target 1, and a later stop-out is BREAKEVEN_STOP", () => {
    const hit = step(run(buy(), [[1, 100]], cfg()), { price: 110, at: at(2) }, cfg());
    expect(hit.trade.stop).toBe(100); expect(hit.events.map((e) => e.type)).toEqual(["TARGET_HIT", "STOP_MOVED"]);
    const out = step(hit.trade, { price: 99, at: at(3) }, cfg());
    expect(out.trade).toMatchObject({ state: "CLOSED", closeReason: "BREAKEVEN_STOP" }); expect(out.trade.realizedPnl).toBe(50 * 10 + 50 * -1);
  });
  it("trails the stop by a percentage behind the best price, tighten-only", () => {
    const c = cfg({ trail: { kind: "percent", value: 5 }, trailAfterTargets: 0, breakevenAfterTarget1: false });
    let t = run(buy({ targets: [200] }), [[1, 100], [2, 110]], c);
    expect(t.stop).toBeCloseTo(104.5, 5);
    t = step(t, { price: 106, at: at(3) }, c).trade; expect(t.stop).toBeCloseTo(104.5, 5); // price fell back: the stop does not loosen
    t = step(t, { price: 120, at: at(4) }, c).trade; expect(t.stop).toBeCloseTo(114, 5);
    const out = step(t, { price: 113, at: at(5) }, c).trade;
    expect(out).toMatchObject({ state: "CLOSED", closeReason: "TRAILING_STOP" }); expect(out.realizedPnl).toBeGreaterThan(0);
  });
  it("trails by points, and not before the configured number of targets", () => {
    const c = cfg({ trail: { kind: "points", value: 3 }, trailAfterTargets: 1, breakevenAfterTarget1: false });
    let t = run(buy({ targets: [110, 150] }), [[1, 100], [2, 105]], c); expect(t.trailingActive).toBe(false); expect(t.stop).toBe(95);
    t = step(t, { price: 112, at: at(3) }, c).trade; expect(t.trailingActive).toBe(true); expect(t.stop).toBe(109);
  });
  it("one target: it takes the whole position", () => {
    const t = run(buy({ targets: [110] }), [[1, 100], [2, 111]], cfg());
    expect(t).toMatchObject({ state: "CLOSED", closeReason: "TARGET", realizedPnl: 1000 });
  });
  it("tiny quantity: never leaves a zero-size remainder before the last target", () => {
    const t = run(buy({ quantity: 1 }), [[1, 100], [2, 110]], cfg());
    expect(t.remainingQuantity).toBe(0); expect(t.state).toBe("CLOSED");
  });
});

describe("square-off, P&L and R", () => {
  it("exitNow closes an open trade at the price, cancels a pending one", () => {
    const open = run(buy(), [[1, 100]], cfg());
    expect(exitNow(open, { price: 104, at: at(5) }, cfg(), "SQUARE_OFF").trade).toMatchObject({ state: "CLOSED", closeReason: "SQUARE_OFF", realizedPnl: 400 });
    expect(exitNow(buy(), { price: 104, at: at(5) }, cfg(), "SQUARE_OFF").trade).toMatchObject({ state: "CANCELLED", cancelReason: "SESSION_END" });
    expect(exitNow(open, { price: 104, at: at(5) }, cfg(), "MANUAL").trade.closeReason).toBe("MANUAL");
  });
  it("unrealised P&L and R multiples", () => {
    const open = run(buy(), [[1, 100]], cfg());
    expect(unrealizedPnl(open, 102)).toBe(200); expect(unrealizedPnl(open, null)).toBe(0); expect(unrealizedPnl(buy(), 102)).toBe(0);
    expect(rMultiple(open, 102)).toBe(0.4); expect(rMultiple(buy(), 102)).toBeNull();
  });
});
