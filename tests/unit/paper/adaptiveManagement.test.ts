import { describe, expect, it } from "vitest";
import { createTrade, DEFAULT_PAPER_CONFIG, DEFAULT_MANAGEMENT_POLICY, isReduceOnly, proposeManagement, replayManagement, step, type ManagementContext, type PaperConfig, type PaperTrade, type ReplayTick } from "../../../packages/paper/src/index";

const cfg = (o: Partial<PaperConfig> = {}): PaperConfig => ({ ...DEFAULT_PAPER_CONFIG, slippageBps: 0, trail: { kind: "none" }, breakevenAfterTarget1: false, ...o });
const T0 = "2026-11-06T04:00:00.000Z";
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const quiet: ManagementContext = { volatilityRatio: 1, minutesToHighImpactEvent: null, minutesToSquareOff: null };
const mk = (side: "BUY" | "SELL" = "BUY", o: Partial<Parameters<typeof createTrade>[0]> = {}): PaperTrade => {
  const base = side === "BUY" ? { entryPrice: 100, stop: 95, targets: [110, 120, 130] } : { entryPrice: 100, stop: 105, targets: [90, 80, 70] };
  const t = createTrade({ id: "t", riskDecisionId: "d", symbol: "NIFTY", side, quantity: 10, now: T0, ...base, ...o }).trade;
  return step(t, { price: 100, at: at(1) }, cfg()).trade; // filled at 100
};

describe("proposeManagement (P0 #1, proposals only)", () => {
  it("holds when nothing applies, and lists unknown context instead of assuming calm", () => {
    const p = proposeManagement(mk(), 102, { volatilityRatio: null, minutesToHighImpactEvent: null, minutesToSquareOff: null });
    expect(p).toMatchObject({ action: "HOLD", executed: false }); expect(p.unknownInputs).toEqual(["volatilityRatio", "minutesToHighImpactEvent", "minutesToSquareOff"]);
  });
  it("tightens to breakeven when an event is near and the trade is in profit (BUY and SELL)", () => {
    const ev: ManagementContext = { ...quiet, minutesToHighImpactEvent: 30 };
    expect(proposeManagement(mk("BUY"), 104, ev)).toMatchObject({ action: "TIGHTEN_STOP", newStop: 100, reasons: ["EVENT_NEAR_BREAKEVEN"] });
    expect(proposeManagement(mk("SELL"), 96, ev)).toMatchObject({ action: "TIGHTEN_STOP", newStop: 100, reasons: ["EVENT_NEAR_BREAKEVEN"] });
  });
  it("locks profit on a volatility spike and picks the safest of several candidates", () => {
    const p = proposeManagement(mk("BUY"), 106, { volatilityRatio: 2.5, minutesToHighImpactEvent: 20, minutesToSquareOff: null }); // risk 5: lock 0.5R = 102.5 beats breakeven 100
    expect(p).toMatchObject({ action: "TIGHTEN_STOP", newStop: 102.5 }); expect(p.reasons[0]).toBe("VOLATILITY_SPIKE_LOCK_PROFIT");
  });
  it("locks profit after the best excursion has been given back", () => {
    let t = mk("BUY"); t = step(t, { price: 108, at: at(2) }, cfg()).trade; // mfe 1.6R
    const p = proposeManagement(t, 104, quiet); // open 0.8R <= 1.6 x 0.6 = 0.96
    expect(p).toMatchObject({ action: "TIGHTEN_STOP", newStop: 102.5, reasons: ["PROFIT_GIVEBACK_LOCK"] });
  });
  it("never proposes a stop at or beyond the price, nor one that is not tighter than the current stop", () => {
    expect(proposeManagement(mk("BUY"), 100.02, { ...quiet, minutesToHighImpactEvent: 10 }).action).not.toBe("TIGHTEN_STOP"); // not in profit enough to lock anything (a partial exit is the only option)
    let t = mk("BUY"); t = { ...t, stop: 101 };
    expect(proposeManagement(t, 106, { ...quiet, minutesToHighImpactEvent: 10 }).action).toBe("HOLD"); // breakeven 100 is looser than the current 101
    const near = proposeManagement({ ...mk("BUY"), extreme: 108 }, 100.05, quiet); // giveback lock 102.5 would be above the price
    expect(near.action).toBe("HOLD"); expect(near.reasons).toContain("PROFIT_GIVEBACK_LOCK_NOT_APPLICABLE");
  });
  it("proposes a partial exit (only) when an event is near and the trade is not in profit", () => {
    const p = proposeManagement(mk("BUY"), 99, { ...quiet, minutesToHighImpactEvent: 20 });
    expect(p).toMatchObject({ action: "PARTIAL_EXIT", exitFraction: 0.5, reasons: ["EVENT_NEAR_REDUCE_EXPOSURE"] }); expect(p.newStop).toBeUndefined();
    expect(proposeManagement(mk("BUY", { quantity: 1 }), 99, { ...quiet, minutesToHighImpactEvent: 20 }).action).toBe("HOLD"); // nothing to reduce
  });
  it("proposes nothing for a pending, closed or priceless trade", () => {
    const pending = createTrade({ id: "t", riskDecisionId: "d", symbol: "N", side: "BUY", quantity: 5, entryPrice: 100, stop: 95, targets: [110], now: T0 }).trade;
    expect(proposeManagement(pending, 100, quiet).reasons).toEqual(["NOT_AN_OPEN_TRADE_OR_NO_PRICE"]);
    expect(proposeManagement(mk(), Number.NaN, quiet).action).toBe("HOLD");
  });
  it("isReduceOnly accepts only tighter stops behind the price and real exit fractions", () => {
    const t = mk("BUY"), base = { version: "adaptive-management-v1", reasons: [], unknownInputs: [], executed: false } as const;
    expect(isReduceOnly(t, 106, { ...base, action: "TIGHTEN_STOP", newStop: 102 })).toBe(true);
    expect(isReduceOnly(t, 106, { ...base, action: "TIGHTEN_STOP", newStop: 94 })).toBe(false); // widening
    expect(isReduceOnly(t, 106, { ...base, action: "TIGHTEN_STOP", newStop: 107 })).toBe(false); // through the price
    expect(isReduceOnly(t, 106, { ...base, action: "PARTIAL_EXIT", exitFraction: 1.5 })).toBe(false);
    expect(isReduceOnly(t, 106, { ...base, action: "HOLD", newStop: 100 })).toBe(false);
  });
  it("PROPERTY: for random open trades and contexts a proposed stop is always strictly tighter and behind the price, and a hold carries no change", () => {
    let seed = 99; const rnd = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let n = 0; n < 4000; n++) {
      const side = rnd() < 0.5 ? "BUY" : "SELL"; let t = mk(side); const s = side === "BUY" ? 1 : -1;
      t = { ...t, stop: t.stop + s * rnd() * 6, extreme: 100 + s * rnd() * 14 }; // a stop somewhere between initial and above entry
      const price = 100 + s * (rnd() * 20 - 6);
      const ctx: ManagementContext = { volatilityRatio: rnd() < 0.2 ? null : rnd() * 4, minutesToHighImpactEvent: rnd() < 0.3 ? null : rnd() * 120, minutesToSquareOff: rnd() < 0.3 ? null : rnd() * 90 };
      const p = proposeManagement(t, price, ctx);
      expect(isReduceOnly(t, price, p)).toBe(true);
      if (p.action === "TIGHTEN_STOP") expect(s * (p.newStop! - t.stop)).toBeGreaterThan(0);
    }
  });
});

describe("replayManagement (fixed rules versus fixed rules plus proposals)", () => {
  const ticks = (prices: number[], ctxAt: (i: number) => ManagementContext = () => quiet): ReplayTick[] => prices.map((price, i) => ({ price, at: at(2 + i), context: ctxAt(i) }));
  it("a reversal after a run-up: the proposals lock profit that the fixed rules give back", () => {
    const r = replayManagement(mk("BUY"), ticks([104, 108, 107, 104, 101, 96, 94]), cfg());
    expect(r.fixed.closeReason).toBe("STOP_LOSS"); expect(r.adaptive.closeReason).toBe("BREAKEVEN_STOP");
    expect(r.deltaR).toBeGreaterThan(0); expect(r.violations).toBe(0); expect(r.proposals.some((p) => p.action === "TIGHTEN_STOP")).toBe(true);
  });
  it("a trade that simply runs to its targets is unchanged (the proposals stay out of the way)", () => {
    const r = replayManagement(mk("BUY"), ticks([101, 103, 105, 111, 121, 131]), cfg());
    expect(r.deltaR).toBe(0); expect(r.fixed.finalR).toBe(r.adaptive.finalR);
  });
  it("a tighter stop can cost R when the market dips and then recovers (the comparison shows it honestly)", () => {
    const r = replayManagement(mk("BUY"), ticks([106, 106, 100, 108, 112, 122, 132], (i) => (i < 2 ? { ...quiet, minutesToHighImpactEvent: 20 } : quiet)), cfg());
    expect(r.adaptive.closeReason).toBe("BREAKEVEN_STOP"); expect(r.deltaR).toBeLessThan(0); expect(r.violations).toBe(0);
  });
  it("works for SELL trades and never widens: the adaptive stop is never looser than the fixed one at any step", () => {
    const start = mk("SELL"); const series = ticks([96, 92, 93, 96, 99, 104, 106]);
    const r = replayManagement(start, series, cfg()); expect(r.violations).toBe(0); expect(r.deltaR).toBeGreaterThanOrEqual(0);
    for (const p of r.proposals) if (p.newStop !== undefined) expect(p.newStop).toBeLessThan(start.stop);
  });
  it("records partial-exit proposals without simulating them in this slice", () => {
    const r = replayManagement(mk("BUY"), ticks([99, 99, 100], () => ({ ...quiet, minutesToHighImpactEvent: 10 })), cfg());
    expect(r.proposals.filter((p) => p.action === "PARTIAL_EXIT").length).toBeGreaterThan(0); expect(r.deltaR).toBe(0);
  });
  it("is pure: the same input gives the same output and the input trade is untouched", () => {
    const start = mk("BUY"), copy = JSON.stringify(start), series = ticks([104, 108, 104, 100, 94]);
    expect(JSON.stringify(replayManagement(start, series, cfg()))).toBe(JSON.stringify(replayManagement(start, series, cfg()))); expect(JSON.stringify(start)).toBe(copy);
    expect(DEFAULT_MANAGEMENT_POLICY.minBufferPct).toBeGreaterThan(0);
  });
});
