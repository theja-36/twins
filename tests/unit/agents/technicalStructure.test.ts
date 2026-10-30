import { describe, expect, it } from "vitest";
import { rsi, swings, technicalStructureAgent, TECHNICAL_STRUCTURE_AGENT_ID, type AgentRulesConfig, type Candle, type LastPriceProvider, type OhlcProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, NOW } from "../../support/agentFixtures";
import { at } from "../../support/calendarMacroFixtures";
import { candle, fromCloses, lastPrice, ohlc, quiet, rulesWithOhlc, wave } from "../../support/ohlcFixtures";

const run = async (inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; ohlc?: OhlcProvider | null; price?: LastPriceProvider | null } = {}) =>
  (await evalAgents([technicalStructureAgent(o.rules ?? rulesWithOhlc(), o.ohlc === undefined ? ohlc(fromCloses(wave(70, 80, 0.5))) : o.ohlc, o.price === undefined ? null : o.price)], inp, {}, [], NOW)).byId(TECHNICAL_STRUCTURE_AGENT_ID);
const noStop = (o: Parameters<typeof inputs>[0] = {}) => inputs({ ...o, rd: { stopLoss: null, ...o.rd } });
const SELL = (o: Parameters<typeof inputs>[0] = {}) => inputs({ ...o, rd: { side: "SELL", stopLoss: 500, targets: [95, 90], ...o.rd }, sf: { side: "SELL" } });
const up = () => ohlc(fromCloses(wave(70, 80, 0.5)));        // rising with swings: ends near 115
const down = () => ohlc(fromCloses(wave(70, 120, -0.5)));    // falling with swings
const range = () => ohlc(fromCloses(wave(70, 100, 0, 2)));   // oscillating around 100

describe("indicator helpers", () => {
  it("RSI is 100 on a pure rise, 0 on a pure fall, 50 on a flat series", () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14)).toBe(100);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14)).toBeCloseTo(0, 6);
    expect(rsi(Array.from({ length: 30 }, () => 100), 14)).toBe(50);
  });
  it("swings need a bar strictly beyond the k bars before it (and not exceeded by the k after); the first of equal extremes counts", () => {
    const s = swings([1, 2, 5, 2, 1, 2, 6, 3, 1], [0, 1, 4, 1, 0, 1, 5, 2, 0], 2);
    expect(s.highs.map((x) => x.i)).toEqual([2, 6]); expect(s.lows.map((x) => x.i)).toEqual([4]);
  });
});

describe("Technical Structure Agent: structure verdicts", () => {
  it("an uptrend with higher highs / higher lows, stacked averages and aligned momentum = SUPPORTIVE for a BUY, with the facts and evidence", async () => {
    const r = await run(noStop());
    expect(r).toMatchObject({ agentId: "technical-structure-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(codesOf(r)).toEqual(expect.arrayContaining(["TREND_ALIGNED", "STRUCTURE_ALIGNED", "MA_ALIGNED", "REGIME_TRENDING"]));
    expect(r.outputSnapshot).toMatchObject({ direction: "BULLISH", provider: "synthetic-ohlc", barsUsed: 70, intervalSeconds: 86_400, priceSource: "last_bar", structure: "HIGHER_HIGHS_HIGHER_LOWS", regime: "TRENDING", sourceIntelligenceStatus: "VALID" });
    expect(r.outputSnapshot["supportiveSignals"]).toBeGreaterThanOrEqual(2);
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "ohlc_series"]));
  });
  it("the same uptrend is not supportive for a SELL: the trend, structure and averages are against it (ADVERSE)", async () => {
    const r = await run(SELL());
    expect(r.verdict).toBe("ADVERSE"); expect(codesOf(r)).toEqual(expect.arrayContaining(["TREND_AGAINST_STRONG", "STRUCTURE_AGAINST", "MA_CONFLICT"]));
  });
  it("a downtrend: ADVERSE for a BUY (stop removed to isolate the structure), SUPPORTIVE for a SELL", async () => {
    const buy = await run(noStop(), { ohlc: down() });
    expect(buy.verdict).toBe("ADVERSE"); expect(codesOf(buy)).toEqual(expect.arrayContaining(["TREND_AGAINST_STRONG", "STRUCTURE_AGAINST", "MA_CONFLICT"])); expect(buy.outputSnapshot["structure"]).toBe("LOWER_HIGHS_LOWER_LOWS");
    expect((await run(SELL(), { ohlc: ohlc(fromCloses(wave(70, 110, -0.3))) })).verdict).toBe("SUPPORTIVE");
    expect(codesOf(await run(SELL(), { ohlc: down() }))).toContain("MOMENTUM_STRETCHED"); // an oversold series is stretched in the SELL direction
  });
  it("a range-bound series: regime RANGE, never SUPPORTIVE (NEUTRAL or CAUTION)", async () => {
    const r = await run(noStop(), { ohlc: range() });
    expect(r.outputSnapshot["regime"]).toBe("RANGE"); expect(codesOf(r)).toContain("REGIME_RANGE"); expect(r.verdict).not.toBe("SUPPORTIVE");
  });
  it("a breakout above the prior range is aligned for a BUY and AGAINST a SELL; a breakdown the reverse (severity configurable)", async () => {
    const base = [...quiet(60, 100)];
    const breakout = ohlc([...base, candle(100, 106, 99.5, 105.5)]);
    const buy = await run(noStop(), { ohlc: breakout });
    expect(codesOf(buy)).toContain("BREAKOUT_ALIGNED");
    const sell = await run(SELL(), { ohlc: breakout });
    expect(sell.verdict).toBe("ADVERSE"); expect(codesOf(sell)).toContain("BREAKOUT_AGAINST");
    const breakdown = ohlc([...base, candle(100, 100.5, 94, 94.5)]);
    const buyD = await run(noStop(), { ohlc: breakdown });
    expect(buyD.verdict).toBe("ADVERSE"); expect(codesOf(buyD)).toContain("BREAKDOWN_AGAINST");
    expect(codesOf(await run(SELL(), { ohlc: breakdown }))).toContain("BREAKDOWN_ALIGNED");
    expect((await run(noStop(), { ohlc: breakdown, rules: rulesWithOhlc({ technical: { breakdownAgainst: "BLOCKING" } }) })).verdict).toBe("BLOCKING");
  });
  it("support / resistance proximity: a swing high just above is a CAUTION for a BUY; a swing low just below is a CAUTION for a SELL", async () => {
    // a double-top shape: price returns to within 0.75% below an earlier swing high
    const closes = [...Array.from({ length: 40 }, (_, i) => 100 + Math.min(i, 8) * 0.0), ...[101, 103, 106, 103, 101, 100, 101, 103, 105.6]];
    const bars = fromCloses([...Array.from({ length: 21 }, () => 100), ...closes.slice(40)].map((x, i) => (i < 21 ? x : x)), 0.3);
    const prov = ohlc([...fromCloses(Array.from({ length: 51 }, () => 100), 0.3), ...bars.slice(21)]);
    const buy = await run(noStop(), { ohlc: prov });
    expect(codesOf(buy)).toContain("NEAR_RESISTANCE");
    const trough = ohlc([...fromCloses(Array.from({ length: 51 }, () => 100), 0.3), ...fromCloses([99, 97, 94, 97, 99, 100, 99, 97, 94.4], 0.3)]);
    expect(codesOf(await run(SELL(), { ohlc: trough }))).toContain("NEAR_SUPPORT");
  });
  it("moving-average alignment / conflict / mixed", async () => {
    expect(codesOf(await run(noStop()))).toContain("MA_ALIGNED");
    expect(codesOf(await run(noStop(), { ohlc: down() }))).toContain("MA_CONFLICT");
    expect(codesOf(await run(noStop(), { ohlc: range() })).some((c) => c === "MA_MIXED" || c === "MA_ALIGNED" || c === "MA_CONFLICT")).toBe(true);
  });
  it("momentum: stretched (RSI above the limit) and against are cautions", async () => {
    const stretched = await run(noStop(), { ohlc: ohlc(fromCloses(Array.from({ length: 70 }, (_, i) => 100 + i * 0.8))) });
    expect(codesOf(stretched)).toContain("MOMENTUM_STRETCHED");
    const against = await run(noStop(), { ohlc: down() });
    expect(codesOf(against)).toEqual(expect.arrayContaining(["MOMENTUM_AGAINST"]));
  });
  it("mixed structure: short and long lookbacks pointing in opposite directions = CAUTION", async () => {
    const closes = [...Array.from({ length: 60 }, (_, i) => 100 + 0.4 * i), ...Array.from({ length: 10 }, (_, i) => 124 - 0.2 * (i + 1))];
    const r = await run(noStop(), { ohlc: ohlc(fromCloses(closes)), rules: rulesWithOhlc({ technical: { trendCautionPct: 1 } }) });
    expect(codesOf(r)).toEqual(expect.arrayContaining(["TREND_TIMEFRAMES_DISAGREE"])); expect(r.verdict).not.toBe("SUPPORTIVE");
  });
  it("invalidation: price already through the stop-loss (equity / future) = BLOCKING (configurable); not applied to options", async () => {
    const r = await run(inputs({ rd: { stopLoss: 120 } })); // up() ends near 115, below a BUY stop of 120
    expect(r.verdict).toBe("BLOCKING"); expect(codesOf(r)).toContain("PRICE_THROUGH_STOP");
    expect((await run(inputs({ rd: { stopLoss: 120 } }), { rules: rulesWithOhlc({ technical: { invalidation: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    const sell = await run(SELL({ rd: { stopLoss: 110 } }), { ohlc: down() });
    expect(codesOf(sell)).not.toContain("PRICE_THROUGH_STOP");
    expect(codesOf(await run(optionInputs({ rd: { symbol: "ACME", optionType: "CE", stopLoss: 500 } })))).not.toContain("PRICE_THROUGH_STOP");
  });
  it("options are judged on the underlying and the derived direction (BUY PE = bearish)", async () => {
    const pe = await run(optionInputs({ rd: { symbol: "ACME", optionType: "PE", stopLoss: 90 } }));
    expect(pe.outputSnapshot["direction"]).toBe("BEARISH"); expect(pe.verdict).toBe("ADVERSE");
    expect((await run(optionInputs({ rd: { symbol: "ACME", optionType: "CE" } }))).verdict).toBe("SUPPORTIVE");
  });
  it("an unknown direction is a CAUTION (alignment not assessed)", async () => {
    const r = await run(inputs({ rd: { side: "HOLD" } }));
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("DIRECTION_UNKNOWN");
  });
});

describe("Technical Structure Agent: last price, configuration", () => {
  it("a last-price provider overrides the candle close; a stale one is a CAUTION; a disconnect is a CAUTION; a missing price falls back with INFO", async () => {
    const r = await run(noStop(), { price: lastPrice(116) });
    expect(r.outputSnapshot).toMatchObject({ priceSource: "last_price", referencePrice: 116 });
    expect(codesOf(await run(noStop(), { price: lastPrice(116, at(-300)) }))).toContain("LAST_PRICE_STALE");
    expect(codesOf(await run(noStop(), { price: lastPrice(116, at(-3000)) }))).toContain("LAST_PRICE_UNUSABLE");
    expect(codesOf(await run(noStop(), { price: lastPrice(140) }))).toContain("PRICE_CANDLE_DISCONNECT");
    expect(codesOf(await run(noStop(), { price: lastPrice(116, at(-1), "OTHER") }))).toContain("LAST_PRICE_MISSING");
  });
  it("the lookbacks, thresholds and severities are configurable", async () => {
    const strict = await run(SELL(), { rules: rulesWithOhlc({ technical: { trendAdversePct: 50, trendCautionPct: 40 } }) });
    expect(codesOf(strict)).not.toContain("TREND_AGAINST_STRONG");
    const r = await run(noStop(), { rules: rulesWithOhlc({ technical: { shortLookback: 5, longLookback: 20, fastMa: 5, slowMa: 20, minBars: 40 } }) });
    expect(r.outputSnapshot["trendLongPct"]).toBeDefined();
    expect(await run(noStop(), { rules: rulesWithOhlc({ technical: { minBars: 80 } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "OHLC_HISTORY_INSUFFICIENT" });
  });
});

describe("Technical Structure Agent: missing / stale / failing data => UNAVAILABLE, never a pass", () => {
  const bars = fromCloses(wave(70, 80, 0.5));
  it.each<[string, Parameters<typeof run>[1], string]>([
    ["no OHLC provider", { ohlc: null }, "OHLC_PROVIDER_NOT_CONFIGURED"],
    ["no candles for the underlying", { ohlc: ohlc(bars, { symbol: "OTHER" }) }, "OHLC_DATA_NOT_AVAILABLE"],
    ["too little history", { ohlc: ohlc(bars.slice(-30)) }, "OHLC_HISTORY_INSUFFICIENT"],
    ["a snapshot too old", { ohlc: ohlc(bars, { asOf: at(-3000) }) }, "OHLC_SNAPSHOT_TOO_OLD"],
    ["a snapshot from the future", { ohlc: ohlc(bars, { asOf: at(90) }) }, "OHLC_DATA_FROM_FUTURE"],
    ["a provider that throws", { ohlc: { name: "x", asOf: null, candles: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "OHLC_PROVIDER_UNAVAILABLE"],
    ["a last-price provider that throws", { price: { name: "x", price: async () => { throw new Error("SECRET-DETAIL"); } } }, "LAST_PRICE_UNAVAILABLE"],
    ["a malformed last price", { price: { name: "x", price: async () => ({ price: -1, asOf: at(-1) }) } }, "LAST_PRICE_MALFORMED"],
  ])("%s", async (_n, o, code) => {
    const r = await run(noStop(), o);
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("stale candles: a snapshot older than the caution limit = CAUTION; a last candle older than the maximum age = UNAVAILABLE; an undated snapshot = CAUTION", async () => {
    const stale = await run(noStop(), { ohlc: ohlc(bars, { asOf: at(-300) }) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("OHLC_SNAPSHOT_STALE");
    const aged: OhlcProvider = { name: "aged", asOf: at(-5), candles: async () => ({ symbol: "ACME", intervalSeconds: 86_400, bars: bars.map((b, i) => ({ ...b, t: new Date(Date.parse("2024-09-01T00:00:00Z") + i * 86_400_000).toISOString() })) }) };
    expect(await run(noStop(), { ohlc: aged })).toMatchObject({ status: "UNAVAILABLE", errorCode: "OHLC_DATA_TOO_OLD" });
    expect(codesOf(await run(noStop(), { ohlc: ohlc(bars, { asOf: null }) }))).toContain("OHLC_AS_OF_UNKNOWN");
  });
  it.each<[string, (b: Candle[]) => Candle[]]>([
    ["a negative price", (b) => b.map((x, i) => (i === 10 ? { ...x, low: -1 } : x))],
    ["high below low", (b) => b.map((x, i) => (i === 10 ? { ...x, high: x.low - 1 } : x))],
    ["a close above the high", (b) => b.map((x, i) => (i === 10 ? { ...x, close: x.high + 5 } : x))],
    ["a NaN", (b) => b.map((x, i) => (i === 10 ? { ...x, open: Number.NaN } : x))],
    ["a duplicate time", (b) => b.map((x, i) => (i === 11 ? { ...x, t: (b[10] as Candle).t } : x))],
    ["a time without an offset", (b) => b.map((x, i) => (i === 10 ? { ...x, t: "2025-01-01T00:00:00" } : x))],
    ["a negative volume", (b) => b.map((x, i) => (i === 10 ? { ...x, volume: -5 } : x))],
  ])("malformed candles (%s) => UNAVAILABLE", async (_n, mutate) => {
    const stamped = ohlc(bars); const good = (await stamped.candles({ market: "NSE", symbol: "ACME", limit: 250, to: at(60) })) as { bars: Candle[] };
    const r = await run(noStop(), { ohlc: { name: "bad", asOf: at(-5), candles: async () => ({ symbol: "ACME", intervalSeconds: 86_400, bars: mutate(good.bars) }) } });
    expect(r).toMatchObject({ status: "UNAVAILABLE", errorCode: "OHLC_DATA_MALFORMED" });
  });
  it("a series for another instrument is a mismatch; a latest candle from the future is refused", async () => {
    const good = (await ohlc(bars).candles({ market: "NSE", symbol: "ACME", limit: 250, to: at(60) })) as { bars: Candle[] };
    expect(await run(noStop(), { ohlc: { name: "x", asOf: at(-5), candles: async () => ({ symbol: "OTHER", intervalSeconds: 86_400, bars: good.bars }) } })).toMatchObject({ errorCode: "OHLC_SYMBOL_MISMATCH" });
    const fut = good.bars.map((b, i) => (i === good.bars.length - 1 ? { ...b, t: at(600) } : b));
    expect(await run(noStop(), { ohlc: { name: "x", asOf: at(-5), candles: async () => ({ symbol: "ACME", intervalSeconds: 86_400, bars: fut }) } })).toMatchObject({ errorCode: "OHLC_DATA_FROM_FUTURE" });
  });
  it("a missing market or underlying is UNAVAILABLE", async () => {
    expect(await run(inputs({ rd: { market: null } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "MISSING_CONTEXT" });
  });
});

describe("Technical Structure Agent: language, determinism", () => {
  it("findings are evidence-only (no causal or predictive language), the output is deterministic and the contract valid", async () => {
    const a = await run(SELL()), b = await run(SELL());
    expect(a.outputSnapshot).toEqual(b.outputSnapshot);
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|driven by|will|expect|predict|should|likely)\b/i);
    expect(JSON.stringify([a.inputSnapshot, a.outputSnapshot])).not.toMatch(/rawText|raw_text|telegram/i);
    expect(technicalStructureAgent(rulesWithOhlc(), null, null).contract).toMatchObject({ agentId: "technical-structure-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision"] });
  });
});
