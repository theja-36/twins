import { describe, expect, it } from "vitest";
import { assessLiquidity, DEFAULT_LIQUIDITY_POLICY, DEFAULT_PRE_TRADE_LIMITS, onTick, validatePreTrade, type InstrumentRules, type MarketState, type OrderIntent } from "../../../packages/risk/src/index";

const rules: InstrumentRules = { lotSize: 25, tickSize: 0.05, freezeQuantity: 1800, tradable: true };
const mkt: MarketState = { referencePrice: 100, priceBandPct: 20, sessionOpen: true, quoteAgeSeconds: 5 };
const order: OrderIntent = { symbol: "X", side: "BUY", quantity: 50, limitPrice: 100.05, stopPrice: 98 };
const codes = (o: Partial<OrderIntent> = {}, r: Partial<InstrumentRules> = {}, m: Partial<MarketState> = {}, l = DEFAULT_PRE_TRADE_LIMITS) => validatePreTrade({ ...order, ...o }, { ...rules, ...r }, { ...mkt, ...m }, l).violations.map((v) => v.code);

describe("pre-trade validation (#9)", () => {
  it("passes a clean order and never grants approval", () => {
    const r = validatePreTrade(order, rules, mkt);
    expect(r).toMatchObject({ ok: true, blockCount: 0, grantsApproval: false });
    expect(r.notional).toBeCloseTo(5002.5);
  });
  it("tick alignment tolerates float error", () => {
    expect(onTick(100.05, 0.05)).toBe(true);
    expect(onTick(0.3, 0.1)).toBe(true);
    expect(onTick(100.03, 0.05)).toBe(false);
  });
  it("blocks quantity problems", () => {
    expect(codes({ quantity: 0 })).toContain("QTY_NOT_POSITIVE_INTEGER");
    expect(codes({ quantity: 1.5 })).toContain("QTY_NOT_POSITIVE_INTEGER");
    expect(codes({ quantity: 30 })).toContain("QTY_NOT_LOT_MULTIPLE");
    expect(codes({ quantity: 1830 })).toEqual(expect.arrayContaining(["QTY_ABOVE_FREEZE", "QTY_NOT_LOT_MULTIPLE"]));
    expect(codes({ quantity: 2000 })).toContain("QTY_ABOVE_FREEZE");
    expect(codes({ quantity: 200 }, {}, {}, { ...DEFAULT_PRE_TRADE_LIMITS, maxQuantity: 100 })).toContain("QTY_EXCEEDS_MAX");
  });
  it("blocks price problems and a market order by default", () => {
    expect(codes({ limitPrice: 100.03 })).toContain("PRICE_OFF_TICK");
    expect(codes({ limitPrice: -1 })).toContain("PRICE_NOT_POSITIVE");
    expect(codes({ limitPrice: 110 })).toContain("PRICE_DEVIATION");
    expect(codes({ limitPrice: 102 }, {}, { priceBandPct: 1 })).toContain("PRICE_OUTSIDE_BAND");
    expect(codes({ limitPrice: null })).toContain("MARKET_ORDER_NOT_ALLOWED");
    expect(codes({ limitPrice: null }, {}, {}, { ...DEFAULT_PRE_TRADE_LIMITS, allowMarketOrders: true })).not.toContain("MARKET_ORDER_NOT_ALLOWED");
  });
  it("requires a stop on the right side and on tick", () => {
    expect(codes({ stopPrice: null })).toContain("STOP_MISSING");
    expect(codes({ stopPrice: 101 })).toContain("STOP_WRONG_SIDE");
    expect(codes({ side: "SELL", stopPrice: 98 })).toContain("STOP_WRONG_SIDE");
    expect(codes({ side: "SELL", stopPrice: 102 })).not.toContain("STOP_WRONG_SIDE");
    expect(codes({ stopPrice: 98.03 })).toContain("STOP_OFF_TICK");
  });
  it("blocks when the market state is unusable and warns when it is unknown", () => {
    expect(codes({}, {}, { sessionOpen: false })).toContain("SESSION_CLOSED");
    expect(codes({}, {}, { referencePrice: null })).toContain("NO_REFERENCE_PRICE");
    expect(codes({}, {}, { quoteAgeSeconds: 600 })).toContain("STALE_QUOTE");
    const w = validatePreTrade(order, rules, { ...mkt, sessionOpen: null, quoteAgeSeconds: null });
    expect(w.ok).toBe(true);
    expect(w.violations.map((v) => v.code)).toEqual(["SESSION_UNKNOWN", "QUOTE_AGE_UNKNOWN"]);
    expect(codes({}, { tradable: false })).toContain("INSTRUMENT_NOT_TRADABLE");
  });
  it("checks notional against the limit and capital", () => {
    expect(codes({ quantity: 25 }, {}, {}, { ...DEFAULT_PRE_TRADE_LIMITS, maxOrderNotional: 1000 })).toContain("NOTIONAL_EXCEEDS_MAX");
    expect(codes({}, {}, {}, { ...DEFAULT_PRE_TRADE_LIMITS, availableCapital: 1000 })).toContain("NOTIONAL_EXCEEDS_CAPITAL");
  });
  it("refuses invalid rules and limits instead of guessing", () => {
    expect(codes({}, { lotSize: 0 })).toEqual(["RULES_INVALID"]);
    expect(codes({}, { tickSize: 0 })).toEqual(["RULES_INVALID"]);
    expect(codes({}, {}, {}, { ...DEFAULT_PRE_TRADE_LIMITS, maxQuantity: -1 })).toEqual(["LIMITS_INVALID"]);
  });
  it("property: any NaN or negative input never yields ok", () => {
    for (const bad of [NaN, -5, Infinity]) {
      expect(validatePreTrade({ ...order, quantity: bad }, rules, mkt).ok).toBe(false);
      expect(validatePreTrade({ ...order, limitPrice: bad }, rules, mkt).ok).toBe(false);
      expect(validatePreTrade({ ...order, stopPrice: bad }, rules, mkt).ok).toBe(false);
    }
  });
});

describe("liquidity and slippage guard (#8)", () => {
  const q = { bid: 99.95, ask: 100.05, touchSize: 5000, avgDailyVolume: 1_000_000 };
  it("small order in a liquid book is OK", () => {
    const a = assessLiquidity(100, q);
    expect(a.verdict).toBe("OK");
    expect(a.spreadBps).toBeCloseTo(10, 1);
    expect(a.suggestedMaxQuantity).toBeLessThanOrEqual(100);
    expect(a.grantsApproval).toBe(false);
  });
  it("a large order is TOO_LARGE and the suggestion is smaller but never larger", () => {
    const a = assessLiquidity(50_000, q);
    expect(a.verdict).toBe("TOO_LARGE");
    expect(a.suggestedMaxQuantity).toBeLessThan(50_000);
    const b = assessLiquidity(a.suggestedMaxQuantity, q);
    expect(b.verdict).not.toBe("TOO_LARGE");
  });
  it("a wide spread blocks any size", () => {
    const a = assessLiquidity(10, { ...q, bid: 99, ask: 101 });
    expect(a.verdict).toBe("TOO_LARGE");
    expect(a.reasons).toContain("SPREAD_TOO_WIDE");
    expect(a.suggestedMaxQuantity).toBe(0);
  });
  it("lists unknown inputs and still checks the spread; unusable quote gives UNKNOWN", () => {
    const a = assessLiquidity(100, { bid: 99.95, ask: 100.05, touchSize: null, avgDailyVolume: null });
    expect(a.unknownInputs).toEqual(["avgDailyVolume", "touchSize"]);
    expect(a.verdict).toBe("OK");
    expect(assessLiquidity(100, { bid: null, ask: null, touchSize: null, avgDailyVolume: null }).verdict).toBe("UNKNOWN");
    expect(assessLiquidity(100, { ...q, bid: 101, ask: 100 }).verdict).toBe("UNKNOWN");
    expect(assessLiquidity(0, q).verdict).toBe("UNKNOWN");
  });
  it("order larger than displayed depth is flagged", () => {
    expect(assessLiquidity(6000, { ...q, touchSize: 5000, avgDailyVolume: 1e9 }).reasons).toContain("ORDER_EXCEEDS_DISPLAYED_DEPTH");
  });
  it("property: the suggestion never exceeds the request and satisfies the participation cap", () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 3000; i++) {
      const qty = 1 + Math.floor(rnd() * 200_000), adv = rnd() < 0.2 ? null : 1000 + rnd() * 5e6, mid = 50 + rnd() * 500, half = rnd() * 0.01 * mid;
      const a = assessLiquidity(qty, { bid: mid - half, ask: mid + half, touchSize: rnd() < 0.3 ? null : 100 + rnd() * 1e5, avgDailyVolume: adv });
      expect(a.suggestedMaxQuantity).toBeLessThanOrEqual(qty);
      expect(a.suggestedMaxQuantity).toBeGreaterThanOrEqual(0);
      if (adv !== null) expect(a.suggestedMaxQuantity).toBeLessThanOrEqual(Math.floor(DEFAULT_LIQUIDITY_POLICY.maxParticipation * adv) + 0);
    }
  });
  it("rejects an invalid policy", () => {
    expect(() => assessLiquidity(10, q, { ...DEFAULT_LIQUIDITY_POLICY, cautionSlippageBps: 99 })).toThrow();
  });
});
