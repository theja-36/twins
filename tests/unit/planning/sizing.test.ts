import { describe, expect, it } from "vitest";
import { ceilTo2, dec, div, fileSpecProvider, legCosts, memorySpecProvider, mul, onTick, roundTripCosts, sizePosition, specProblem, feeProblem, str, checkStop, wholeUnits } from "../../../packages/planning/src/index";
import { FEES, SPEC, base } from "./fixtures";

describe("fixed-point decimal", () => {
  it("is exact where binary floating point is not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(dec("0.1") + dec("0.2")).toBe(dec("0.3"));
    expect(str(mul(dec("19.99"), dec("3")), 2)).toBe("59.97");
    expect(str(dec(100.05) * 3n / 3n, 2)).toBe("100.05");
  });
  it("rounds in the stated direction and rejects junk", () => {
    expect(str(ceilTo2(dec("1.001")), 2)).toBe("1.01");
    expect(str(mul(dec("1.005"), dec("1"), "down"), 3)).toBe("1.005");
    expect(div(dec(1), dec(3), "up")).toBeGreaterThan(div(dec(1), dec(3), "down"));
    expect(() => dec("1e5")).toThrow(); expect(() => dec(Number.NaN)).toThrow(); expect(() => dec("1.123456789")).toThrow(); expect(() => div(dec(1), 0n)).toThrow();
    expect(wholeUnits(dec("10.9"), dec(3))).toBe(3n);
    expect(onTick(dec("100.05"), dec("0.05"))).toBe(true); expect(onTick(dec("100.07"), dec("0.05"))).toBe(false);
  });
});

describe("specifications and fees", () => {
  it("validates provenance and values; a malformed record is rejected, never repaired", () => {
    expect(specProblem(SPEC)).toBeNull(); expect(feeProblem(FEES)).toBeNull();
    expect(specProblem({ ...SPEC, sourceRef: null })).toBe("SPEC_OFFICIAL_NEEDS_REFERENCE");
    expect(specProblem({ ...SPEC, lotSize: "0" })).toBe("SPEC_LOT_OR_TICK");
    expect(specProblem({ ...SPEC, tickSize: "x" })).toBe("SPEC_LOT_OR_TICK");
    expect(specProblem(null)).toBe("SPEC_MISSING");
    expect(feeProblem({ ...FEES, gstPctOnServices: "-1" })).toBe("FEES_GSTPCTONSERVICES");
    expect(feeProblem({ ...FEES, brokerage: { kind: "PCT", percent: "x", capPerOrder: null } })).toBe("FEES_BROKERAGE");
  });
  it("selects the version in effect at the time and returns null when none applies", async () => {
    const p = memorySpecProvider({ instruments: [SPEC, { ...SPEC, specVersion: "test-spec-2", effectiveFrom: "2031-01-01T00:00:00Z", lotSize: "50" }, { ...SPEC, specVersion: "test-spec-0", effectiveFrom: "2029-06-01T00:00:00Z", effectiveTo: "2030-01-01T00:00:00Z" }], fees: [FEES] });
    const q = (at: string) => p.instrument({ exchange: "NSE", underlying: "ACME", instrumentType: "equity", at: new Date(at) });
    expect((await q("2029-09-01T00:00:00Z"))?.specVersion).toBe("test-spec-0");
    expect((await q("2030-03-01T00:00:00Z"))?.specVersion).toBe("test-spec-1");
    expect((await q("2031-02-01T00:00:00Z"))?.specVersion).toBe("test-spec-2");
    expect(await q("2029-01-01T00:00:00Z")).toBeNull();
    expect(await p.fees({ segment: "FO", at: new Date("2030-03-01T00:00:00Z") })).toBeNull();
  });
  it("a bad specification file THROWS at load", () => {
    expect(() => fileSpecProvider("/nonexistent/specs.json")).toThrow();
  });
});

describe("costs", () => {
  it("itemises a round trip and rounds every figure UP to the paisa", () => {
    const leg = legCosts(FEES, "SELL", dec("100"), 1000n);
    expect(str(leg.brokerage)).toBe("20.00");
    expect(str(leg.stt)).toBe("100.00");             // 0.1% of 100,000
    expect(str(leg.exchange)).toBe("2.97");          // 0.00297% of 100,000 = 2.97
    expect(str(leg.stampDuty)).toBe("0.00");         // sell side
    expect(leg.total).toBe(leg.brokerage + leg.exchange + leg.sebi + leg.stampDuty + leg.stt + leg.gst + leg.other);
    const rt = roundTripCosts(FEES, "BUY", dec("100"), dec("102"), 1000n);
    expect(rt.total).toBe(rt.entry.total + rt.exit.total);
    expect(str(rt.entry.stampDuty)).toBe("3.00");
    expect(legCosts(FEES, "BUY", dec("100"), 0n).total).toBe(0n);
  });
  it("supports a percentage brokerage with a cap", () => {
    const f = { ...FEES, brokerage: { kind: "PCT" as const, percent: "0.03", capPerOrder: "20" } };
    expect(str(legCosts(f, "BUY", dec("100"), 1000n).brokerage)).toBe("20.00");
    expect(str(legCosts(f, "BUY", dec("100"), 100n).brokerage)).toBe("3.00");
  });
});

describe("structural stop checks", () => {
  const ok = { side: "BUY", entry: 100, stop: 98, stopBasis: "price", instrumentType: "equity" as const, tick: "0.05" };
  it("accepts a sane stop and refuses every unsafe one with a reason code", () => {
    expect(checkStop(ok)).toEqual({ ok: true });
    const code = (o: Record<string, unknown>) => { const r = checkStop({ ...ok, ...o } as never); return r.ok ? "OK" : r.code; };
    expect(code({ stop: null })).toBe("STOP_MISSING"); expect(code({ stop: undefined })).toBe("STOP_MISSING");
    expect(code({ stop: 0 })).toBe("STOP_INVALID"); expect(code({ stop: -1 })).toBe("STOP_INVALID"); expect(code({ stop: "abc" })).toBe("STOP_INVALID");
    expect(code({ stop: 101 })).toBe("STOP_WRONG_SIDE"); expect(code({ side: "SELL", stop: 98 })).toBe("STOP_WRONG_SIDE");
    expect(code({ stop: 100 })).toBe("STOP_EQUALS_ENTRY");
    expect(code({ stopBasis: "pips" })).toBe("STOP_BASIS_INVALID"); expect(code({ stopBasis: null })).toBe("STOP_BASIS_INVALID");
    expect(code({ instrumentType: "option" })).toBe("STOP_BASIS_MISMATCH"); expect(code({ stopBasis: "premium" })).toBe("STOP_BASIS_MISMATCH");
    expect(code({ entry: 0 })).toBe("ENTRY_INVALID"); expect(code({ entry: null })).toBe("ENTRY_INVALID");
    expect(code({ stop: 98.03 })).toBe("PRICE_OFF_TICK");
    expect(code({ side: "HOLD" })).toBe("SIDE_INVALID");
  });
});

describe("position sizing", () => {
  it("sizes from the money at risk, includes costs, and stays inside the budget", () => {
    const r = sizePosition(base());
    expect(r.status).toBe("SIZED");
    expect(r.quantity).toBe(r.lots * 25);
    expect(dec(r.riskPerLot) * BigInt(r.lots)).toBeGreaterThanOrEqual(dec(r.maxLossAtStop));
    expect(dec(r.maxLossAtStop)).toBeLessThanOrEqual(dec("10000"));
    expect(dec(r.maxLossAtStop)).toBeGreaterThan(dec(r.stopLossGross));   // costs are inside the loss
    expect(r.riskBudget.binding).toBe("risk_percent");
    expect(r.specVersion).toBe("test-spec-1"); expect(r.feeVersion).toBe("test-fees-1"); expect(r.grantsApproval).toBe(false);
    // one more lot would break the budget
    const more = sizePosition(base({ policy: { ...base().policy, maxLots: r.lots + 1 } }));
    expect(more.lots).toBe(r.lots);
  });
  it("reports target outcomes, reward-to-risk and a breakeven that includes costs", () => {
    const r = sizePosition(base());
    expect(dec(r.targets[0]!.netProfit)).toBeLessThan(dec(r.targets[0]!.grossProfit));
    expect(dec(r.targets[0]!.costs)).toBeGreaterThan(0n);
    expect(Number(r.targets[0]!.grossRewardToRisk)).toBeCloseTo(2, 0);
    expect(Number(r.breakevenPrice)).toBeGreaterThan(100);
    const s = sizePosition(base({ side: "SELL", entry: 100, stop: 102, targets: [96] }));
    expect(s.status).toBe("SIZED"); expect(Number(s.breakevenPrice)).toBeLessThan(100);
  });
  it("never exceeds capital, the policy's lots, the specification's lots or the freeze quantity", () => {
    expect(sizePosition(base({ capital: { total: "100000", available: "100000" }, policy: { ...base().policy, riskPercent: "5" } })).lots).toBeLessThanOrEqual(40); // 100,000 / (100 x 25)
    expect(sizePosition(base({ policy: { ...base().policy, maxLots: 7 } })).lots).toBe(7);
    expect(sizePosition(base({ spec: { ...SPEC, maxLots: 3 } })).lots).toBe(3);
    expect(sizePosition(base({ spec: { ...SPEC, freezeQuantity: 100 } })).quantity).toBeLessThanOrEqual(100);
    expect(sizePosition(base({ policy: { ...base().policy, maxPositionNotionalPct: "10" } })).grossExposure <= "100000.00").toBe(true);
  });
  it("only ever shrinks: a multiplier above 1 or below/at 0 is refused", () => {
    const full = sizePosition(base()), half = sizePosition(base({ sizeMultiplier: 0.5 }));
    expect(half.lots).toBeLessThan(full.lots); expect(half.lots).toBeGreaterThan(0);
    for (const m of [1.01, 2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(sizePosition(base({ sizeMultiplier: m })).reason).toBe("MULTIPLIER_INVALID");
  });
  it("every cap narrows the budget and names the binding one", () => {
    const daily = sizePosition(base({ caps: { remainingDailyRisk: "2000", remainingPortfolioRisk: null, remainingGroupRisk: null } }));
    expect(daily.riskBudget.binding).toBe("daily_loss_headroom"); expect(dec(daily.maxLossAtStop)).toBeLessThanOrEqual(dec("2000"));
    const perTrade = sizePosition(base({ policy: { ...base().policy, maxRiskPerTrade: "3000" } }));
    expect(perTrade.riskBudget.binding).toBe("max_risk_per_trade");
    expect(sizePosition(base({ caps: { remainingDailyRisk: "0", remainingPortfolioRisk: null, remainingGroupRisk: null } })).reason).toBe("BUDGET_NOT_POSITIVE");
  });
  it("refuses to size when the stop, specification, fees, capital or instrument cannot support it", () => {
    const why = (o: Parameters<typeof base>[0]) => sizePosition(base(o)).reason;
    expect(why({ stop: null })).toBe("STOP_MISSING"); expect(why({ stop: 101 })).toBe("STOP_WRONG_SIDE"); expect(why({ stopBasis: "premium" })).toBe("STOP_BASIS_MISMATCH");
    expect(why({ spec: null })).toBe("SPEC_UNAVAILABLE"); expect(why({ fees: null })).toBe("FEES_UNAVAILABLE");
    expect(why({ capital: { total: "100", available: "200" } })).toBe("CAPITAL_INVALID"); expect(why({ capital: { total: "0", available: "0" } })).toBe("CAPITAL_INVALID");
    expect(why({ entry: "abc" })).toBe("ENTRY_INVALID"); expect(why({ capital: { total: "x", available: "1" } })).toBe("INPUT_INVALID");
    expect(why({ capital: { total: "2000", available: "2000" }, policy: { ...base().policy, riskPercent: "5" } })).toBe("ONE_LOT_EXCEEDS_CAPITAL");
    expect(why({ policy: { ...base().policy, maxRiskPerTrade: "10" } })).toBe("ONE_LOT_EXCEEDS_RISK_BUDGET");
    expect(why({ spec: { ...SPEC, instrumentType: "future" }, side: "SELL", entry: 100, stop: 102, stopBasis: "price" })).toBe("MARGIN_MODEL_UNAVAILABLE");
    expect(why({ spec: { ...SPEC, freezeQuantity: 10 } })).toBe("ONE_LOT_EXCEEDS_FREEZE_LIMIT");
    const n = sizePosition(base({ stop: null }));
    expect(n.status).toBe("NOT_SIZED"); expect(n.lots).toBe(0); expect(n.quantity).toBe(0); expect(n.maxLossAtStop).toBe("0.00");
  });
  it("is deterministic and slippage can only enlarge the loss (and so shrink the size)", () => {
    expect(JSON.stringify(sizePosition(base()))).toBe(JSON.stringify(sizePosition(base())));
    const slip = sizePosition(base({ slippageBps: { entry: 20, exit: 20 } })), none = sizePosition(base());
    expect(slip.lots).toBeLessThanOrEqual(none.lots); expect(dec(slip.slippageAtStop)).toBeGreaterThan(0n);
  });
  it("invariants hold across a wide sweep of inputs (property test)", () => {
    let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const entry = Math.round((20 + rnd() * 900) * 20) / 20, dist = Math.max(0.05, Math.round(rnd() * 25 * 20) / 20), buy = rnd() > 0.5;
      const cap = Math.round(50_000 + rnd() * 5_000_000), rp = String(Math.round((0.1 + rnd() * 4.9) * 10) / 10), mult = Math.round((0.1 + rnd() * 0.9) * 100) / 100;
      const r = sizePosition(base({ side: buy ? "BUY" : "SELL", entry, stop: Math.round((buy ? entry - dist : entry + dist) * 20) / 20, targets: [buy ? entry + dist * 2 : entry - dist * 2], capital: { total: String(cap), available: String(cap) }, policy: { riskPercent: rp, maxRiskPerTrade: null, maxLots: 1 + Math.floor(rnd() * 200), maxPositionNotionalPct: null }, sizeMultiplier: mult, slippageBps: { entry: Math.floor(rnd() * 30), exit: Math.floor(rnd() * 30) } }));
      if (r.status !== "SIZED") continue;
      const budget = dec(r.riskBudget.effectiveBudget);
      expect(dec(r.maxLossAtStop)).toBeLessThanOrEqual(budget);
      expect(dec(r.maxLossAtStop)).toBeLessThanOrEqual(mul(dec(cap), div(dec(rp), dec(100))));
      if (buy) expect(dec(r.grossExposure)).toBeLessThanOrEqual(dec(cap));
      expect(r.lots).toBeGreaterThanOrEqual(1); expect(r.quantity % 25).toBe(0);
    }
  });
});
