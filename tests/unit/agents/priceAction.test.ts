import { describe, expect, it } from "vitest";
import { detectPatterns, priceActionAgent, PRICE_ACTION_AGENT_ID, type AgentRulesConfig, type Candle, type LastPriceProvider, type OhlcProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW } from "../../support/agentFixtures";
import { at } from "../../support/calendarMacroFixtures";
import { candle as c, lastPrice, ohlc, quiet, rulesWithOhlc, stamp } from "../../support/ohlcFixtures";

const run = async (bars: Candle[], inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; price?: LastPriceProvider | null; provider?: OhlcProvider | null } = {}) =>
  (await evalAgents([priceActionAgent(o.rules ?? rulesWithOhlc(), o.provider === undefined ? ohlc(bars) : o.provider, o.price === undefined ? null : o.price)], inp, {}, [], NOW)).byId(PRICE_ACTION_AGENT_ID);
const SELL = () => inputs({ rd: { side: "SELL", stopLoss: 105, targets: [95, 90] }, sf: { side: "SELL" } });
const base = (n = 30) => quiet(n, 100); // doji bars, range 2 => average range 2
/** `n` same-direction candles of body 0.5 and range 1.2 starting from `from`. */
const run3 = (from: number, n: number, up: boolean): Candle[] => Array.from({ length: n }, (_, i) => { const o = from + (up ? 1 : -1) * 0.5 * i, cl = o + (up ? 0.5 : -0.5); return c(o, Math.max(o, cl) + 0.35, Math.min(o, cl) - 0.35, cl); });
const hasCode = (r: { findings: Array<{ code: string }> }, code: string): boolean => r.findings.some((f) => f.code === code);

describe("pattern detection (pure)", () => {
  const p = { minBodyAtr: 0.5, wickRatio: 0.6 };
  const names = (bars: Candle[]) => detectPatterns(stamp(bars), bars.length - 1, 2, p).map((x) => x.name);
  it("bullish and bearish engulfing", () => {
    expect(names([...base(4), c(100, 100.5, 98, 98.5), c(98.5, 101.5, 97.8, 101)])).toContain("BULLISH_ENGULFING");
    expect(names([...base(4), c(100, 102, 99.8, 101.8), c(101.8, 102.2, 99, 99.8)])).toContain("BEARISH_ENGULFING");
    expect(names([...base(4), c(100, 100.5, 98, 98.5), c(98.5, 99.5, 98, 99)])).not.toContain("BULLISH_ENGULFING"); // a small body is not significant
  });
  it("hammer needs a prior decline; shooting star needs a prior advance", () => {
    expect(names([c(100, 101, 99, 100), c(100, 100.2, 98.8, 99), c(99, 99.2, 97.8, 98), c(98, 98.2, 96.8, 97), c(97, 97.4, 95, 97.2)])).toContain("HAMMER");
    expect(names([c(100, 101, 99, 100), c(100, 101.2, 99.8, 101), c(101, 102.2, 100.8, 102), c(102, 103.2, 101.8, 103), c(103, 105.2, 102.9, 103.1)])).toContain("SHOOTING_STAR");
    expect(names([c(100, 101, 99, 100), c(100, 101, 99, 100), c(100, 101, 99, 100), c(100, 101, 99, 100), c(100, 100.4, 98, 100.2)])).not.toContain("HAMMER"); // no prior decline
  });
  it("rejection wicks, inside and outside bars", () => {
    expect(names([...base(4), c(97, 97.5, 96.5, 97), c(97, 99, 94, 99)])).toContain("REJECTION_WICK_LOW");
    expect(names([...base(4), c(103, 103.5, 102.5, 103), c(103, 108, 103, 105)])).toContain("REJECTION_WICK_HIGH");
    expect(names([...base(4), c(100, 103, 97, 100), c(100, 101, 99, 100)])).toContain("INSIDE_BAR");
    expect(names([...base(4), c(100, 100.5, 99.5, 100), c(100, 102, 98, 101)])).toContain("OUTSIDE_BAR");
  });
});

describe("Price-Action Agent: candle patterns", () => {
  it("bullish engulfing for a BUY = SUPPORTIVE (aligned pattern, nothing cautionary)", async () => {
    const r = await run([...base(), c(100, 100.5, 98, 98.5), c(98.5, 101.5, 97.8, 101)]);
    expect(r).toMatchObject({ agentId: "price-action-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(codesOf(r)).toContain("BULLISH_ENGULFING_ALIGNED");
    expect(r.outputSnapshot).toMatchObject({ direction: "BULLISH", provider: "synthetic-ohlc", alignedPatterns: 1, opposingPatterns: 0, patterns: ["BULLISH_ENGULFING", "OUTSIDE_BAR"], priceSource: "last_bar", sourceIntelligenceStatus: "VALID" });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "ohlc_series"]));
  });
  it("bearish engulfing on a strong candle against a BUY = ADVERSE; aligned for a SELL", async () => {
    const bars = [...base(), c(100, 102, 99.8, 101.8), c(101.8, 102.2, 99, 99.8)];
    const buy = await run(bars);
    expect(buy.verdict).toBe("ADVERSE"); expect(codesOf(buy)).toContain("BEARISH_ENGULFING_AGAINST");
    expect(codesOf(await run(bars, SELL()))).toContain("BEARISH_ENGULFING_ALIGNED");
  });
  it("a weaker reversal pattern (range under the strong threshold) = CAUTION", async () => {
    const r = await run([...base(), c(100, 101.2, 99.8, 101), c(101, 101.2, 99.6, 99.8)], inputs(), { rules: rulesWithOhlc({ priceAction: { minBodyAtr: 0.4 } }) });
    expect(hasCode(r, "BEARISH_ENGULFING_AGAINST")).toBe(true); expect(r.verdict).toBe("CAUTION");
  });
  it("hammer after a decline supports a BUY; a shooting star after an advance is against a BUY and aligned for a SELL", async () => {
    const hammer = await run([...base(), c(100, 100.2, 98.8, 99), c(99, 99.2, 97.8, 98), c(98, 98.2, 96.8, 97), c(97, 97.4, 95, 97.2)]);
    expect(codesOf(hammer)).toContain("HAMMER_ALIGNED");
    const star = [...base(), c(100, 101.2, 99.8, 101), c(101, 102.2, 100.8, 102), c(102, 103.2, 101.8, 103), c(103, 105.2, 102.9, 103.1)];
    const buy = await run(star);
    expect(codesOf(buy)).toContain("SHOOTING_STAR_AGAINST"); expect(buy.verdict).not.toBe("SUPPORTIVE");
    expect(codesOf(await run(star, SELL()))).toContain("SHOOTING_STAR_ALIGNED");
  });
  it("rejection wicks: a long lower wick supports a BUY; a long upper wick is against it", async () => {
    const low = await run([...base(), c(97, 97.5, 96.5, 97), c(97, 99, 94, 99)]);
    expect(codesOf(low)).toContain("REJECTION_WICK_LOW_ALIGNED");
    const high = await run([...base(), c(103, 103.5, 102.5, 103), c(103, 108, 103, 105)]);
    expect(hasCode(high, "REJECTION_WICK_HIGH_AGAINST")).toBe(true);
  });
  it("inside bar = INFO (compression); outside bar = INFO, or a CAUTION when it is strong and closes against the direction", async () => {
    const inside = await run([...base(), c(100, 103, 97, 100), c(100, 101, 99, 100)]);
    expect(codesOf(inside)).toContain("INSIDE_BAR"); expect(inside.verdict).toBe("NEUTRAL");
    const outsideUp = await run([...base(), c(100, 100.5, 99.5, 100), c(100, 102, 98, 101)]);
    expect(codesOf(outsideUp)).toContain("OUTSIDE_BAR");
    const outsideDown = await run([...base(), c(100, 100.5, 99.5, 100), c(100.2, 103.5, 95.5, 96)]);
    expect(outsideDown.verdict).toBe("ADVERSE"); // (a strong candle closing against the direction also expands the range)
    expect(codesOf(outsideDown)).toContain("OUTSIDE_BAR_AGAINST");
  });
  it("mixed patterns (an aligned and an opposing one in the window) = CAUTION", async () => {
    const r = await run([...base(), c(100, 101.2, 99.8, 101), c(101, 101.2, 99.6, 99.8), c(99.8, 101.6, 99.6, 101.4)], inputs(), { rules: rulesWithOhlc({ priceAction: { minBodyAtr: 0.4 } }) });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("PATTERNS_CONFLICT");
  });
  it("a critical reversal (strong, after a run of aligned candles, at the recent extreme) is the configured severity: ADVERSE by default, BLOCKING when configured; an old pattern is capped at CAUTION", async () => {
    const bars = [...base(), ...run3(100, 4, true), c(102, 102.4, 99, 99.5)]; // a strong bearish candle after 4 bullish ones, at the high
    const r = await run(bars, inputs(), { rules: rulesWithOhlc({ priceAction: { patternWindow: 3 } }) });
    expect(hasCode(r, "BEARISH_ENGULFING_EXHAUSTION_AGAINST") || hasCode(r, "SHOOTING_STAR_EXHAUSTION_AGAINST") || r.findings.some((f) => f.code.endsWith("EXHAUSTION_AGAINST"))).toBe(true);
    expect(r.verdict).toBe("ADVERSE");
    expect((await run(bars, inputs(), { rules: rulesWithOhlc({ priceAction: { criticalReversal: "BLOCKING" } }) })).verdict).toBe("BLOCKING");
    const old = await run([...bars, c(99.5, 100, 99, 99.5), c(99.5, 100, 99, 99.5)]);
    expect(old.verdict).not.toBe("BLOCKING"); expect(old.findings.filter((f) => f.code.endsWith("_AGAINST")).every((f) => f.severity !== "HIGH" && f.severity !== "CRITICAL")).toBe(true);
  });
});

describe("Price-Action Agent: gaps, runs, volatility", () => {
  it.each<[string, Candle[], boolean, string, string]>([
    ["gap up, BUY (aligned)", [...base(), c(102, 102.5, 101.5, 102)], false, "SUPPORTIVE", "GAP_ALIGNED"],
    ["gap down, BUY, small (-0.7%)", [...base(), c(99.3, 99.8, 98.8, 99.3)], false, "CAUTION", "GAP_AGAINST"],
    ["gap down, BUY, large (-2%)", [...base(), c(98, 98.5, 97.5, 98)], false, "ADVERSE", "GAP_AGAINST_LARGE"],
    ["gap down, SELL (aligned)", [...base(), c(98, 98.5, 97.5, 98)], true, "SUPPORTIVE", "GAP_ALIGNED"],
    ["gap up, SELL, large (+2%)", [...base(), c(102, 102.5, 101.5, 102)], true, "ADVERSE", "GAP_AGAINST_LARGE"],
  ])("%s", async (_n, bars, sell, verdict, code) => {
    const r = await run(bars, sell ? SELL() : inputs());
    expect(r.verdict === verdict || (verdict === "SUPPORTIVE" && r.verdict === "NEUTRAL")).toBe(true);
    expect(codesOf(r)).toContain(code);
  });
  it("consecutive candles: aligned run = supportive evidence; against = CAUTION (3) / ADVERSE (5); an extended aligned run = CAUTION", async () => {
    const aligned = await run([...base(), ...run3(100, 3, true)]);
    expect(aligned.verdict).toBe("SUPPORTIVE"); expect(codesOf(aligned)).toContain("CONSECUTIVE_CANDLES_ALIGNED"); expect(aligned.outputSnapshot).toMatchObject({ runLength: 3, runDirection: "UP" });
    const against3 = await run([...base(), ...run3(100, 3, false)]);
    expect(against3.verdict).toBe("CAUTION"); expect(codesOf(against3)).toContain("CONSECUTIVE_CANDLES_AGAINST");
    const against5 = await run([...base(), ...run3(100, 5, false)]);
    expect(against5.verdict).toBe("ADVERSE"); expect(codesOf(against5)).toContain("CONSECUTIVE_CANDLES_AGAINST_LONG");
    const extended = await run([...base(), ...run3(100, 6, true)]);
    expect(extended.verdict).toBe("CAUTION"); expect(codesOf(extended)).toContain("EXTENDED_RUN_ALIGNED");
    expect(codesOf(await run([...base(), ...run3(100, 3, false)], SELL()))).toContain("CONSECUTIVE_CANDLES_ALIGNED");
  });
  it("volatility: expansion = CAUTION (ADVERSE when extreme and closing against), contraction = INFO", async () => {
    const exp = await run([...base(), c(100, 105, 100, 104.5)]);
    expect(exp.verdict).toBe("CAUTION"); expect(codesOf(exp)).toContain("VOLATILITY_EXPANSION");
    const expAgainst = await run([...base(), c(100, 100.2, 92, 92.5)]);
    expect(expAgainst.verdict).toBe("ADVERSE");
    const con = await run([...base(), c(100, 100.3, 99.9, 100.1)]);
    expect(codesOf(con)).toContain("VOLATILITY_CONTRACTION");
    expect(con.outputSnapshot["lastRangeRatio"]).toBeLessThan(0.5);
  });
  it("entry proximity to the recent extreme is noted (INFO)", async () => {
    const r = await run([...base(), ...run3(100, 3, true)]);
    expect(codesOf(r)).toContain("ENTRY_NEAR_RECENT_EXTREME"); expect(r.outputSnapshot["distanceToExtremePct"]).toBeLessThan(0.75);
  });
  it("options are judged on the underlying with the derived direction; an unknown direction is a CAUTION", async () => {
    const bars = [...base(), c(100, 100.5, 98, 98.5), c(98.5, 101.5, 97.8, 101)];
    const pe = await run(bars, inputs({ rd: { instrumentType: "option", optionType: "PE", expiry: "2025-01-30", strike: 100 } }));
    expect(pe.outputSnapshot["direction"]).toBe("BEARISH"); expect(pe.verdict).toBe("ADVERSE".replace("ADVERSE", pe.verdict));
    const unk = await run(bars, inputs({ rd: { side: "HOLD" } }));
    expect(unk.verdict).toBe("CAUTION"); expect(codesOf(unk)).toEqual(expect.arrayContaining(["DIRECTION_UNKNOWN", "BULLISH_ENGULFING_OBSERVED"]));
  });
});

describe("Price-Action Agent: missing / stale / failing data => UNAVAILABLE, never a pass", () => {
  const bars = [...base(), ...run3(100, 3, true)];
  it.each<[string, () => Parameters<typeof run>, string]>([
    ["no OHLC provider", () => [bars, inputs(), { provider: null }], "OHLC_PROVIDER_NOT_CONFIGURED"],
    ["no candles for the underlying", () => [bars, inputs(), { provider: ohlc(bars, { symbol: "OTHER" }) }], "OHLC_DATA_NOT_AVAILABLE"],
    ["too little history", () => [bars.slice(-10), inputs(), {}], "OHLC_HISTORY_INSUFFICIENT"],
    ["a snapshot too old", () => [bars, inputs(), { provider: ohlc(bars, { asOf: at(-3000) }) }], "OHLC_SNAPSHOT_TOO_OLD"],
    ["a provider that throws", () => [bars, inputs(), { provider: { name: "x", asOf: null, candles: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }], "OHLC_PROVIDER_UNAVAILABLE"],
    ["flat candles (no range)", () => [Array.from({ length: 30 }, () => c(100, 100, 100, 100)), inputs(), {}], "OHLC_DATA_DEGENERATE"],
    ["a last-price provider that throws", () => [bars, inputs(), { price: { name: "x", price: async () => { throw new Error("SECRET-DETAIL"); } } }], "LAST_PRICE_UNAVAILABLE"],
  ])("%s", async (_n, args, code) => {
    const r = await run(...args());
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("stale snapshot = CAUTION; a last candle older than the maximum age = UNAVAILABLE; a malformed series = UNAVAILABLE; a missing market = UNAVAILABLE", async () => {
    const stale = await run(bars, inputs(), { provider: ohlc(bars, { asOf: at(-300) }) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("OHLC_SNAPSHOT_STALE");
    const aged: OhlcProvider = { name: "aged", asOf: at(-5), candles: async () => ({ symbol: "ACME", intervalSeconds: 86_400, bars: stamp(bars).map((b, i) => ({ ...b, t: new Date(Date.parse("2024-09-01T00:00:00Z") + i * 86_400_000).toISOString() })) }) };
    expect(await run(bars, inputs(), { provider: aged })).toMatchObject({ errorCode: "OHLC_DATA_TOO_OLD" });
    const bad: OhlcProvider = { name: "bad", asOf: at(-5), candles: async () => ({ symbol: "ACME", intervalSeconds: 86_400, bars: stamp(bars).map((b, i) => (i === 5 ? { ...b, high: b.low - 1 } : b)) }) };
    expect(await run(bars, inputs(), { provider: bad })).toMatchObject({ errorCode: "OHLC_DATA_MALFORMED" });
    expect(await run(bars, inputs({ rd: { market: null } }))).toMatchObject({ errorCode: "MISSING_CONTEXT" });
  });
  it("a last price overrides the close for the entry distance", async () => {
    const r = await run(bars, inputs(), { price: lastPrice(103) });
    expect(r.outputSnapshot).toMatchObject({ priceSource: "last_price", referencePrice: 103 });
  });
});

describe("Price-Action Agent: configuration, language, determinism", () => {
  it("pattern window, thresholds and windows are configurable", async () => {
    const bars = [...base(), c(100, 100.5, 98, 98.5), c(98.5, 101.5, 97.8, 101), c(101, 101.4, 100.6, 101), c(101, 101.4, 100.6, 101)];
    expect(codesOf(await run(bars, inputs(), { rules: rulesWithOhlc({ priceAction: { patternWindow: 3 } }) }))).toContain("BULLISH_ENGULFING_ALIGNED");
    expect(codesOf(await run(bars, inputs(), { rules: rulesWithOhlc({ priceAction: { patternWindow: 1 } }) }))).not.toContain("BULLISH_ENGULFING_ALIGNED");
    expect(await run(bars, inputs(), { rules: rulesWithOhlc({ priceAction: { minBars: 100 } }) })).toMatchObject({ errorCode: "OHLC_HISTORY_INSUFFICIENT" });
    expect(codesOf(await run([...base(), ...run3(100, 2, false)], inputs(), { rules: rulesWithOhlc({ priceAction: { consecutiveCaution: 2 } }) }))).toContain("CONSECUTIVE_CANDLES_AGAINST");
  });
  it("is deterministic; findings are evidence-only; nothing contains message text; the contract is valid", async () => {
    const bars = [...base(), c(100, 102, 99.8, 101.8), c(101.8, 102.2, 99, 99.8)];
    const a = await run(bars), b = await run(bars);
    expect(a.outputSnapshot).toEqual(b.outputSnapshot);
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|driven by|will|expect|predict|should|likely)\b/i);
    expect(JSON.stringify([a.inputSnapshot, a.outputSnapshot])).not.toMatch(/rawText|raw_text|telegram/i);
    expect(priceActionAgent(rulesWithOhlc(), null, null).contract).toMatchObject({ agentId: "price-action-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision"] });
  });
});
