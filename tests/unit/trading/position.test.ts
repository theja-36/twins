import { describe, expect, it } from "vitest";
import { applyEntryFill, DEFAULT_RULES_BASE, evaluatePosition, exitPnl, freshPrice, loadExecutionConfig, priceProviderFrom, unrealizedPnl, type PositionRules, type PositionView } from "../../../packages/execution/src/index";
import { dec, str } from "../../../packages/planning/src/index";

const NOW = new Date("2031-01-06T05:00:00Z"); // 10:30 IST
const rules = (o: Partial<PositionRules> = {}): PositionRules => ({ ...DEFAULT_RULES_BASE, ladder: ["0.5"], instrumentKind: "equity", stopBasis: "price", lotSize: "25", expiry: null, fees: null, ...o } as PositionRules);
const pos = (o: Partial<Record<keyof PositionView, unknown>> = {}): PositionView => ({ side: "BUY", quantity: dec(1000), initialQuantity: dec(1000), avgEntry: dec(100), initialStop: dec(98), stop: dec(98), targets: [dec(104), dec(108)], openedAt: new Date(NOW.getTime() - 3600_000), plannedMaxLoss: dec(2100), ...o } as PositionView);
const act = (p: PositionView, price: number, r = rules(), now = NOW) => evaluatePosition(p, dec(price), now, r);

describe("position arithmetic (fixed-point)", () => {
  it("weights the average entry across partial fills exactly and computes direction-signed P&L", () => {
    const a = applyEntryFill({ quantity: 0n, avg: 0n }, dec(300), dec("100.10")), b = applyEntryFill(a, dec(200), dec("100.35"));
    expect(str(b.avg, 8)).toBe("100.20000000"); expect(b.quantity).toBe(dec(500));
    expect(str(exitPnl("BUY", dec(100), dec("104.05"), dec(250)))).toBe("1012.50");
    expect(str(exitPnl("SELL", dec(100), dec("96"), dec(250)))).toBe("1000.00");
    expect(str(exitPnl("BUY", dec(100), dec("98"), dec(250)))).toBe("-500.00");
    expect(str(unrealizedPnl("SELL", dec(100), dec(10), dec("101")))).toBe("-10.00");
  });
});

describe("exit and protection rules", () => {
  it("a stop breach exits everything; a gap fills at the observed (worse) price, never better", () => {
    expect(act(pos(), 98)).toEqual([expect.objectContaining({ kind: "EXIT", reason: "STOP_HIT", quantity: dec(1000) })]);
    const gap = act(pos(), 90)[0] as { kind: string; detail: string };
    expect(gap.kind).toBe("EXIT"); expect(gap.detail).toMatch(/90/);
    expect(act(pos({ side: "SELL", stop: dec(102), initialStop: dec(102), targets: [dec(96)] }), 103)[0]).toMatchObject({ reason: "STOP_HIT" });
  });
  it("targets exit along the ladder: a share at the first, everything remaining at the last", () => {
    expect(act(pos(), 104)).toEqual([expect.objectContaining({ kind: "EXIT", reason: "TARGET_HIT", quantity: dec(500), targetIndex: 0 })]);
    expect(act(pos({ quantity: dec(500) }), 108)).toEqual([expect.objectContaining({ reason: "TARGET_HIT", quantity: dec(500), targetIndex: 1 })]);
    expect(act(pos(), 109)[0]).toMatchObject({ reason: "TARGET_HIT", quantity: dec(1000), targetIndex: 1 }); // straight through both rungs
    expect(act(pos({ quantity: dec(500) }), 104).filter((a) => a.kind === "EXIT")).toEqual([]);          // first rung already taken
  });
  it("after the first rung the stop moves to breakeven, validated against the current price, and only ever tightens", () => {
    const m = act(pos({ quantity: dec(500) }), 105).find((a) => a.kind === "MOVE_STOP") as { kind: "MOVE_STOP"; stop: bigint; reason: string };
    expect(m).toMatchObject({ reason: "BREAKEVEN" }); expect(m.stop).toBe(dec(100));
    expect(act(pos({ quantity: dec(500), stop: dec(100) }), 105).some((a) => a.kind === "MOVE_STOP" && a.reason === "BREAKEVEN")).toBe(false); // already there
    expect(act(pos({ quantity: dec(500), stop: dec(103) }), 105).some((a) => a.kind === "MOVE_STOP")).toBe(false);                          // never loosens
  });
  it("trails one initial-risk distance behind price once price has moved far enough", () => {
    const r = rules({ ladder: ["0.5"], breakevenAfterTarget: null, trailAfterR: "1" });
    expect(act(pos({ targets: [dec(120), dec(130)] }), 102.5, r).some((a) => a.kind === "MOVE_STOP")).toBe(true);   // 2.5 >= 1 x 2.0 risk
    expect(act(pos({ targets: [dec(120), dec(130)] }), 101, r).some((a) => a.kind === "MOVE_STOP")).toBe(false);
    const t = act(pos({ targets: [dec(120), dec(130)] }), 103, r).find((a) => a.kind === "MOVE_STOP") as { stop: bigint };
    expect(t.stop).toBe(dec(101));
  });
  it("time exits: session close, maximum hold, and instrument expiry", () => {
    expect(act(pos(), 101, rules(), new Date("2031-01-06T09:46:00Z"))[0]).toMatchObject({ reason: "TIME_EXIT" });   // 15:16 IST
    expect(act(pos(), 101, rules({ sessionCloseExitMinutes: null, maxHoldMinutes: 30 }))[0]).toMatchObject({ reason: "TIME_EXIT" });
    expect(act(pos(), 101, rules({ expiry: "2031-01-06" }), new Date("2031-01-06T09:35:00Z"))[0]).toMatchObject({ reason: "EXPIRY_EXIT" }); // 15:05 IST on expiry day
    expect(act(pos(), 101, rules({ expiry: "2031-01-06" })).some((a) => a.kind === "EXIT")).toBe(false);          // before the expiry-day cut-off
    expect(act(pos(), 101, rules({ expiry: "2031-01-05" }))[0]).toMatchObject({ reason: "EXPIRY_EXIT" });
  });
  it("flags a risk breach when the open loss is far beyond the planned loss", () => {
    const p = pos({ stop: dec(80), initialStop: dec(80), plannedMaxLoss: dec(100) });
    expect(act(p, 95).some((a) => a.kind === "RISK_BREACH")).toBe(true);
    expect(act(pos({ plannedMaxLoss: dec(100000) }), 99).some((a) => a.kind === "RISK_BREACH")).toBe(false);
  });
  it("does nothing for a closed position and is deterministic", () => {
    expect(act(pos({ quantity: 0n }), 50)).toEqual([]);
    expect(JSON.stringify(act(pos(), 104), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(act(pos(), 104), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
});

describe("price provider: missing or stale prices are failures, never prices", () => {
  const prov = (o: unknown) => priceProviderFrom({ name: "memory", price: async () => o as never }, "FIXTURE");
  const q = { exchange: "NSE", symbol: "ACME" };
  it("returns a price with its age and declared source, or a coded failure", async () => {
    const fresh = await freshPrice(prov({ price: 101.5, asOf: new Date(NOW.getTime() - 5000).toISOString() }), q, NOW, 60);
    expect(fresh).toMatchObject({ ok: true, price: 101.5, source: "FIXTURE", provider: "memory" }); expect(fresh.ok && fresh.ageSeconds).toBeCloseTo(5, 0);
    const why = async (o: unknown) => { const r = await freshPrice(prov(o), q, NOW, 60); return r.ok ? "OK" : r.reason; };
    expect(await why(null)).toBe("NO_PRICE"); expect(await why({ price: 100, asOf: new Date(NOW.getTime() - 120_000).toISOString() })).toBe("STALE");
    expect(await why({ price: 100, asOf: new Date(NOW.getTime() + 120_000).toISOString() })).toBe("FUTURE");
    expect(await why({ price: -1, asOf: NOW.toISOString() })).toBe("MALFORMED"); expect(await why({ price: 100, asOf: "garbage" })).toBe("MALFORMED"); expect(await why({ price: Number.NaN, asOf: NOW.toISOString() })).toBe("MALFORMED");
    expect((await freshPrice(null, q, NOW, 60))).toMatchObject({ ok: false, reason: "NO_PROVIDER" });
    const boom = priceProviderFrom({ name: "x", price: async () => { throw new Error("SECRET"); } }, "FIXTURE");
    expect(JSON.stringify(await freshPrice(boom, q, NOW, 60))).not.toContain("SECRET");
  });
});

describe("execution configuration", () => {
  it("is off by default, has no live setting, and is strict", () => {
    expect(loadExecutionConfig({})).toMatchObject({ enabled: false, managementEnabled: false, fillFraction: 1 });
    expect(Object.keys(loadExecutionConfig({}))).not.toContain("live");
    expect(loadExecutionConfig({ TWINS_EXECUTION_ENABLED: "true", TWINS_PAPER_FILL_FRACTION: "0.5", TWINS_EXIT_LADDER: "0.3,0.3" })).toMatchObject({ enabled: true, fillFraction: 0.5, ladder: ["0.3", "0.3"] });
    for (const e of [{ TWINS_EXECUTION_ENABLED: "1" }, { TWINS_PAPER_FILL_FRACTION: "0" }, { TWINS_EXIT_LADDER: "0.6,0.6" }, { TWINS_EXIT_LADDER: "1" }, { TWINS_EXEC_MAX_PRICE_AGE_SECONDS: "0" }]) expect(() => loadExecutionConfig(e)).toThrow();
  });
});
