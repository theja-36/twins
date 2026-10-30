import { describe, expect, it } from "vitest";
import { liquidityAgent, LIQUIDITY_AGENT_ID, memoryLastPrice, type AgentRulesConfig, type InstrumentQuote, type LastPriceProvider, type QuoteProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW, optionInputs } from "../../support/agentFixtures";
import { goodQuote, quotes, rulesWithQuotes } from "../../support/quoteFixtures";
import { at } from "../../support/calendarMacroFixtures";

const run = async (q: InstrumentQuote | null, inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; provider?: QuoteProvider | null; price?: LastPriceProvider | null } = {}) =>
  (await evalAgents([liquidityAgent(o.rules ?? rulesWithQuotes(), o.provider === undefined ? (q === null ? quotes(goodQuote(), "NSE:OTHER") : quotes(q)) : o.provider, o.price ?? null)], inp, {}, [], NOW)).byId(LIQUIDITY_AGENT_ID);
const SELL = () => inputs({ rd: { side: "SELL", stopLoss: 105, targets: [95, 90] }, sf: { side: "SELL" } });
const FUT = () => inputs({ rd: { instrumentType: "future", expiry: "2025-01-30" }, sf: { instrumentType: "FUTURE" } });
const futQuotes = (q: InstrumentQuote) => quotes(q, "NSE:ACME:2025-01-30");

describe("Liquidity Agent: assessment", () => {
  it("good liquidity = SUPPORTIVE with the quote summarised and no raw text", async () => {
    const r = await run(goodQuote());
    expect(r).toMatchObject({ agentId: "liquidity-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(r.outputSnapshot).toMatchObject({ provider: "synthetic-quotes", instrumentType: "equity", side: "BUY", bid: 99.95, ask: 100.05, spreadPct: 0.1, volumeRatio: 0.5, dimensionsAssessed: 3, quoteAgeMinutes: 1, failedCodes: [] });
    expect(codesOf(r)).toEqual(expect.arrayContaining(["SPREAD_TIGHT", "VOLUME_ADEQUATE"]));
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "quote"]));
  });
  it("spread: moderate = CAUTION, wide = ADVERSE, extreme = BLOCKING (ADVERSE when configured)", async () => {
    expect(await run(goodQuote({ bid: 99.6, ask: 100.4 }))).toMatchObject({ verdict: "CAUTION" }); // 0.8%
    const wide = await run(goodQuote({ bid: 98.5, ask: 100.5 })); // 2.0%
    expect(wide.verdict).toBe("ADVERSE"); expect(codesOf(wide)).toContain("SPREAD_WIDE");
    const ext = await run(goodQuote({ bid: 95, ask: 101 })); // 6.1%
    expect(ext.verdict).toBe("BLOCKING"); expect(codesOf(ext)).toContain("SPREAD_EXTREME");
    expect((await run(goodQuote({ bid: 95, ask: 101 }), inputs(), { rules: rulesWithQuotes({ liquidity: { extremeSeverity: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
  });
  it("options use their own, wider spread thresholds", async () => {
    const q = (bid: number, ask: number) => ({ ...goodQuote({ bid, ask, last: 120, avgVolume: 10_000, volume: 5000, openInterest: 50_000 }) });
    const go = async (bid: number, ask: number) => (await evalAgents([liquidityAgent(rulesWithQuotes(), quotes(q(bid, ask), "NSE:NIFTY:2025-01-30:24500:CE"), null)], optionInputs(), {}, [], NOW)).byId(LIQUIDITY_AGENT_ID);
    expect((await go(118, 122)).verdict).toBe("SUPPORTIVE"); // 3.3%
    expect((await go(115, 125)).verdict).toBe("CAUTION"); // 8.3%
    expect((await go(105, 135)).verdict).toBe("ADVERSE"); // 25%
    expect((await go(70, 170)).verdict).toBe("BLOCKING"); // 83%
  });
  it("thin volume against the average = CAUTION; poor average volume = ADVERSE", async () => {
    const thin = await run(goodQuote({ volume: 100_000 }));
    expect(thin.verdict).toBe("CAUTION"); expect(codesOf(thin)).toContain("THIN_VOLUME");
    const poor = await run(goodQuote({ avgVolume: 500, volume: 400 }));
    expect(poor.verdict).toBe("ADVERSE"); expect(codesOf(poor)).toContain("POOR_LIQUIDITY");
  });
  it("open interest on a future: low = CAUTION, poor = ADVERSE, missing = CAUTION, healthy = SUPPORTIVE", async () => {
    const f = async (oi: number | null) => run(null, FUT(), { provider: futQuotes(goodQuote({ openInterest: oi })) });
    expect((await f(500)).verdict).toBe("CAUTION"); expect(codesOf(await f(500))).toContain("OPEN_INTEREST_LOW");
    expect((await f(50)).verdict).toBe("ADVERSE"); expect(codesOf(await f(50))).toContain("OPEN_INTEREST_POOR");
    expect(codesOf(await f(null))).toContain("OPEN_INTEREST_MISSING"); expect((await f(null)).verdict).toBe("CAUTION");
    expect((await f(5000)).verdict).toBe("SUPPORTIVE");
  });
  it("no displayed depth on the needed side = BLOCKING (the other side does not matter); missing depth data is only INFO", async () => {
    const r = await run(goodQuote({ askDepth: 0 }));
    expect(r.verdict).toBe("BLOCKING"); expect(codesOf(r)).toContain("NO_DEPTH");
    expect((await run(goodQuote({ bidDepth: 0 }))).verdict).toBe("SUPPORTIVE");
    expect((await run(goodQuote({ bidDepth: 0 }), SELL())).verdict).toBe("BLOCKING"); // a SELL needs the bid
    const none = await run(goodQuote({ bidDepth: null, askDepth: null }));
    expect(none.verdict).toBe("SUPPORTIVE"); expect(codesOf(none)).toContain("DEPTH_NOT_PROVIDED");
    expect((await run(goodQuote({ askDepth: 0 }), inputs(), { rules: rulesWithQuotes({ liquidity: { minDepthQuantity: 0 } }) })).verdict).toBe("SUPPORTIVE");
  });
  it("no market on the needed side = BLOCKING; the other side missing = CAUTION", async () => {
    const noAsk = await run(goodQuote({ ask: null }));
    expect(noAsk.verdict).toBe("BLOCKING"); expect(codesOf(noAsk)).toContain("NO_MARKET_SIDE");
    const noBid = await run(goodQuote({ bid: null }));
    expect(noBid.verdict).toBe("CAUTION"); expect(codesOf(noBid)).toContain("ONE_SIDED_QUOTE");
    expect((await run(goodQuote({ bid: null }), SELL())).verdict).toBe("BLOCKING");
  });
  it("price sanity: the entry far from the quote and the last price outside the quote", async () => {
    const far = await run(goodQuote({ bid: 119.95, ask: 120.05, last: 120 }));
    expect(far.verdict).toBe("ADVERSE"); expect(codesOf(far)).toContain("ENTRY_FAR_FROM_QUOTE");
    const away = await run(goodQuote({ bid: 103.95, ask: 104.05, last: 104 }));
    expect(away.verdict).toBe("CAUTION"); expect(codesOf(away)).toContain("ENTRY_AWAY_FROM_QUOTE");
    const out = await run(goodQuote({ last: 105 }));
    expect(out.verdict).toBe("CAUTION"); expect(codesOf(out)).toContain("LAST_OUTSIDE_QUOTE");
  });
  it("the equity quote is cross-checked against the last-price provider (a failing or malformed provider only cautions)", async () => {
    const p = (price: number) => memoryLastPrice({ name: "p", prices: { "NSE:ACME": { price, asOf: at(-1) } } });
    expect(codesOf(await run(goodQuote(), inputs(), { price: p(110) }))).toContain("QUOTE_PRICE_DISCONNECT");
    expect((await run(goodQuote(), inputs(), { price: p(100.2) })).verdict).toBe("SUPPORTIVE");
    const failing = await run(goodQuote(), inputs(), { price: { name: "x", price: async () => { throw new Error("SECRET-DETAIL"); } } });
    expect(codesOf(failing)).toContain("LAST_PRICE_UNAVAILABLE"); expect(JSON.stringify(failing)).not.toContain("SECRET-DETAIL");
    expect(codesOf(await run(goodQuote(), inputs(), { price: { name: "x", price: async () => ({ price: -1, asOf: at(-1) }) } }))).toContain("LAST_PRICE_MALFORMED");
  });
  it("too few dimensions assessed = NEUTRAL (never SUPPORTIVE)", async () => {
    const r = await run(goodQuote({ avgVolume: null, bidDepth: null, askDepth: null }));
    expect(r).toMatchObject({ status: "COMPLETED", verdict: "NEUTRAL", confidence: 70 }); expect(r.outputSnapshot["dimensionsAssessed"]).toBe(1);
  });
  it("the worst finding decides the verdict", async () => {
    expect((await run(goodQuote({ bid: 98.5, ask: 100.5, volume: 10_000, askDepth: 0 }))).verdict).toBe("BLOCKING");
  });
});

describe("Liquidity Agent: staleness", () => {
  it("a quote older than the caution limit = CAUTION; older than the unavailable limit or in the future = UNAVAILABLE", async () => {
    const stale = await run(goodQuote({ asOf: at(-10) }));
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("QUOTE_STALE");
    expect(await run(goodQuote({ asOf: at(-60) }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "QUOTE_TOO_OLD" });
    expect(await run(goodQuote({ asOf: at(10) }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "QUOTE_FROM_FUTURE" });
  });
  it("the thresholds are configurable", async () => {
    expect((await run(goodQuote({ asOf: at(-10) }), inputs(), { rules: rulesWithQuotes({ quotes: { staleCautionMinutes: 20 } }) })).verdict).toBe("SUPPORTIVE");
    expect(await run(goodQuote({ asOf: at(-10) }), inputs(), { rules: rulesWithQuotes({ quotes: { staleCautionMinutes: 2, unavailableMinutes: 5 } }) })).toMatchObject({ status: "UNAVAILABLE" });
  });
});

describe("Liquidity Agent: missing / failing / malformed data => UNAVAILABLE, never a pass", () => {
  it.each([
    ["no provider configured", { provider: null }, "QUOTE_PROVIDER_NOT_CONFIGURED"],
    ["a provider that throws", { provider: { name: "x", quote: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "QUOTE_PROVIDER_UNAVAILABLE"],
    ["no quote for the contract", { provider: quotes(goodQuote(), "NSE:OTHER") }, "QUOTE_NOT_AVAILABLE"],
    ["neither bid nor ask", { provider: quotes(goodQuote({ bid: null, ask: null })) }, "QUOTE_NO_BID_ASK"],
    ["a crossed quote", { provider: quotes(goodQuote({ bid: 101, ask: 100 })) }, "QUOTE_MALFORMED"],
    ["a negative price", { provider: quotes(goodQuote({ bid: -1 })) }, "QUOTE_MALFORMED"],
    ["a non-finite size", { provider: quotes(goodQuote({ volume: Number.NaN })) }, "QUOTE_MALFORMED"],
    ["a zero ask", { provider: quotes(goodQuote({ ask: 0 })) }, "QUOTE_MALFORMED"],
    ["a malformed time", { provider: quotes(goodQuote({ asOf: "yesterday" })) }, "QUOTE_MALFORMED"],
    ["a non-object quote", { provider: { name: "x", quote: async () => "garbage" as never } }, "QUOTE_MALFORMED"],
  ] as Array<[string, { provider: QuoteProvider | null }, string]>)("%s", async (_n, o, code) => {
    const r = await run(null, inputs(), o);
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("an unsupported instrument type, an incomplete contract and a missing context", async () => {
    expect(await run(goodQuote(), inputs({ rd: { instrumentType: "bond" } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "INSTRUMENT_TYPE_UNSUPPORTED" });
    expect(await run(goodQuote(), inputs({ rd: { instrumentType: "future", expiry: null } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
    expect(await run(goodQuote(), inputs({ rd: { symbol: "UNKNOWN" } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
    expect(await run(goodQuote(), optionInputs({ rd: { strike: null } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
  });
});

describe("Liquidity Agent: safety", () => {
  it("is deterministic, never mutates the inputs and states evidence only", async () => {
    const inp = inputs(); const before = JSON.stringify(inp);
    const a = await run(goodQuote({ bid: 98.5, ask: 100.5 }), inp), b = await run(goodQuote({ bid: 98.5, ask: 100.5 }), inp);
    expect(JSON.stringify(inp)).toBe(before);
    expect(JSON.stringify({ ...a, startedAt: 0, finishedAt: 0, durationMs: 0 })).toBe(JSON.stringify({ ...b, startedAt: 0, finishedAt: 0, durationMs: 0 }));
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|will|should|buy now|sell now)\b/i);
  });
  it("is a blocking-capable scoring agent with weight 50 and no dependencies", () => {
    expect(liquidityAgent(rulesWithQuotes(), null, null).contract).toMatchObject({ agentId: "liquidity-v1", canBlock: true, advisoryOnly: false, weight: 50, dependsOn: [] });
  });
});
