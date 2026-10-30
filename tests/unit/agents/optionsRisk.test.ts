import { describe, expect, it } from "vitest";
import { optionsRiskAgent, OPTIONS_RISK_AGENT_ID, type AgentRulesConfig, type LastPriceProvider, type OhlcProvider, type OptionChain, type OptionQuote, type OptionsChainProvider, type OptionsQuoteProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW, optionInputs } from "../../support/agentFixtures";
import { at } from "../../support/calendarMacroFixtures";
import { ohlc, quiet } from "../../support/ohlcFixtures";
import { chains, goodChain, goodOption, optionQuotes, rulesWithQuotes } from "../../support/quoteFixtures";

interface Opt { rules?: AgentRulesConfig; expiry?: string; now?: Date; chain?: OptionChain | null; chainProvider?: OptionsChainProvider | null; provider?: OptionsQuoteProvider | null; ohlc?: OhlcProvider | null; price?: LastPriceProvider | null; inp?: Record<string, unknown> }
/** `q` is built relative to `now` when it is a function of the clock. */
const run = async (q: Partial<OptionQuote> | null, o: Opt = {}) => {
  const now = o.now ?? NOW, expiry = o.expiry ?? "2025-01-30";
  const key = `NSE:NIFTY:${expiry}:24500:CE`;
  const quote = q === null ? null : goodOption({ asOf: at(-1, now), ...q });
  const provider = o.provider === undefined ? (quote === null ? optionQuotes(goodOption(), "NSE:OTHER") : optionQuotes(quote, key)) : o.provider;
  const chainProvider = o.chainProvider !== undefined ? o.chainProvider : o.chain === null ? null : chains(o.chain ?? goodChain({ asOf: at(-1, now) }), `NSE:NIFTY:${expiry}`);
  const inp = o.inp ?? optionInputs({ rd: { expiry } });
  return (await evalAgents([optionsRiskAgent(o.rules ?? rulesWithQuotes(), provider, chainProvider, o.ohlc ?? null, o.price ?? null)], inp, {}, [], now)).byId(OPTIONS_RISK_AGENT_ID);
};
const SELL = (stop = 150) => optionInputs({ rd: { side: "SELL", stopLoss: stop, targets: [90, 60] }, sf: { side: "SELL" } });
const EXPIRY_TOMORROW = "2025-01-07"; // 29.9 hours after NOW: inside the 3-day caution window and the 2-day gamma window, beyond the 24-hour window
const LATE = new Date("2025-01-06T08:00:00.000Z"); // 2 hours before the 10:00Z expiry close of 2025-01-06

describe("Options Risk Agent: assessment", () => {
  it("a reasonable option = SUPPORTIVE with the risk profile summarised", async () => {
    const r = await run({});
    expect(r).toMatchObject({ agentId: "options-risk-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(r.outputSnapshot).toMatchObject({ applicable: true, provider: "synthetic-option-quotes", chainProvider: "synthetic-option-chains", side: "BUY", optionType: "CE", strike: 24_500, expiry: "2025-01-30", premium: 120, iv: 15, ivChangePct: 3.45, delta: 0.5,
      underlyingPrice: 24_500, underlyingSource: "quote", moneynessPct: 0, openInterest: 50_000, volume: 20_000, failedCodes: [] });
    expect(r.outputSnapshot["dimensionsAssessed"]).toBeGreaterThanOrEqual(4);
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "option_quote"]));
  });
  it("a non-option instrument = NEUTRAL with applicable false, and the providers are never touched", async () => {
    let touched = false;
    const p: OptionsQuoteProvider = { name: "x", quote: async () => { touched = true; return null; } };
    const r = await run({}, { provider: p, inp: inputs() });
    expect(r).toMatchObject({ status: "COMPLETED", verdict: "NEUTRAL", confidence: 70 });
    expect(r.outputSnapshot["applicable"]).toBe(false); expect(codesOf(r)).toEqual(["NOT_AN_OPTION"]); expect(touched).toBe(false);
    expect((await run({}, { provider: p, inp: inputs({ rd: { instrumentType: "future", expiry: "2025-01-30" } }) })).outputSnapshot["applicable"]).toBe(false);
  });
  it("implied volatility level: elevated = CAUTION, high = ADVERSE, extreme = BLOCKING (ADVERSE when configured)", async () => {
    const at_ = async (iv: number, rules?: AgentRulesConfig) => run({ iv, ivPrevious: iv - 0.5 }, { chain: goodChain({ rows: [{ strike: 24_500, optionType: "CE", iv, openInterest: 50_000, volume: 20_000 }], asOf: at(-1) }), ...(rules ? { rules } : {}) });
    const e = await at_(45); expect(e.verdict).toBe("CAUTION"); expect(codesOf(e)).toContain("IV_ELEVATED");
    const h = await at_(80); expect(h.verdict).toBe("ADVERSE"); expect(codesOf(h)).toContain("IV_HIGH");
    const x = await at_(130); expect(x.verdict).toBe("BLOCKING"); expect(codesOf(x)).toContain("IV_EXTREME");
    expect((await at_(130, rulesWithQuotes({ optionsRisk: { extremeSeverity: "ADVERSE" } }))).verdict).toBe("ADVERSE");
  });
  it("an implied-volatility rise against the previous session: 15% = CAUTION, 30% = ADVERSE, 60% = BLOCKING", async () => {
    const chg = async (iv: number) => run({ iv, ivPrevious: 15 }, { chain: goodChain({ rows: [{ strike: 24_500, optionType: "CE", iv, openInterest: 50_000, volume: 20_000 }], asOf: at(-1) }) });
    const a = await chg(17.5); expect(a.verdict).toBe("CAUTION"); expect(codesOf(a)).toContain("IV_RISING");
    const b = await chg(20); expect(b.verdict).toBe("ADVERSE"); expect(codesOf(b)).toContain("IV_SPIKE");
    const c = await chg(25); expect(c.verdict).toBe("BLOCKING"); expect(codesOf(c)).toContain("IV_SPIKE_EXTREME");
    expect(await chg(12)).toMatchObject({ verdict: "SUPPORTIVE" }); // a falling IV is not a risk finding
  });
  it("implied volatility above the at-the-money level of the chain = CAUTION", async () => {
    const r = await run({ iv: 24, ivPrevious: 23 });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("IV_ABOVE_ATM");
  });
  it("expiry proximity: 3 days = CAUTION, within 24 hours = ADVERSE, within 3 hours = BLOCKING, past = BLOCKING", async () => {
    const near = await run({}, { expiry: EXPIRY_TOMORROW });
    expect(near.verdict).toBe("CAUTION"); expect(codesOf(near)).toContain("EXPIRY_NEAR");
    const day = await run({}, { expiry: "2025-01-06" });
    expect(day.verdict).toBe("ADVERSE"); expect(codesOf(day)).toContain("EXPIRY_WITHIN_DAY");
    const imm = await run({}, { expiry: "2025-01-06", now: LATE });
    expect(imm.verdict).toBe("BLOCKING"); expect(codesOf(imm)).toContain("EXPIRY_IMMINENT");
    expect((await run({}, { expiry: "2025-01-06", now: LATE, rules: rulesWithQuotes({ optionsRisk: { extremeSeverity: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    const gone = await run({}, { expiry: "2025-01-06", now: new Date("2025-01-06T11:00:00.000Z") });
    expect(gone.verdict).toBe("BLOCKING"); expect(codesOf(gone)).toContain("OPTION_EXPIRED");
  });
  it("near-expiry time decay for a long option: 8% of the premium per day = ADVERSE, in the final hours = BLOCKING; moderate = CAUTION; a sale only informs", async () => {
    const th = async (theta: number, o: Opt = {}) => run({ theta }, { expiry: EXPIRY_TOMORROW, ...o });
    expect(codesOf(await th(-5.5))).toContain("THETA_DECAY_MODERATE");
    const hi = await th(-12); expect(hi.verdict).toBe("ADVERSE"); expect(codesOf(hi)).toContain("THETA_DECAY_HIGH");
    const ex = await run({ theta: -12 }, { expiry: "2025-01-06", now: LATE }); expect(codesOf(ex)).toContain("THETA_DECAY_EXTREME"); expect(ex.verdict).toBe("BLOCKING");
    const sale = await th(-12, { inp: optionInputs({ rd: { expiry: EXPIRY_TOMORROW, side: "SELL", stopLoss: 150, targets: [90, 60] }, sf: { side: "SELL" } }) });
    expect(codesOf(sale)).toContain("THETA_DECAY_FOR_SELLER"); expect(codesOf(sale)).not.toContain("THETA_DECAY_HIGH");
  });
  it("gamma near expiry: moderate = CAUTION, high = ADVERSE, in the final hours = BLOCKING; far from expiry it only informs", async () => {
    const g = async (gamma: number, o: Opt = {}) => run({ gamma }, { expiry: EXPIRY_TOMORROW, ...o });
    const m = await g(0.0005); expect(m.verdict).toBe("CAUTION"); expect(codesOf(m)).toContain("GAMMA_RISK_MODERATE");
    const h = await g(0.0009); expect(h.verdict).toBe("ADVERSE"); expect(codesOf(h)).toContain("GAMMA_RISK_HIGH");
    const x = await run({ gamma: 0.0009 }, { expiry: "2025-01-06", now: LATE }); expect(codesOf(x)).toContain("GAMMA_RISK_EXTREME"); expect(x.verdict).toBe("BLOCKING");
    const far = await run({ gamma: 0.0009 }); expect(codesOf(far)).toContain("GAMMA_OUTSIDE_WINDOW"); expect(far.verdict).toBe("SUPPORTIVE");
    expect((await g(0.0009, { rules: rulesWithQuotes({ optionsRisk: { gammaWindowDays: 1 } }) })).verdict).toBe("CAUTION"); // outside a 1-day window: informational only (expiry caution remains)
  });
  it("vega exposure matters when implied volatility is elevated", async () => {
    const r = await run({ iv: 45, ivPrevious: 44, vega: 14 }, { chain: goodChain({ rows: [{ strike: 24_500, optionType: "CE", iv: 45, openInterest: 50_000, volume: 20_000 }], asOf: at(-1) }) });
    expect(codesOf(r)).toContain("VEGA_EXPOSURE");
    expect(codesOf(await run({ vega: 14 }))).not.toContain("VEGA_EXPOSURE"); // IV 15 is not elevated
  });
  it("wide premium spread = ADVERSE; moderate = CAUTION; no market on the needed side = ADVERSE", async () => {
    const w = await run({ bid: 105, ask: 135 }); expect(w.verdict).toBe("ADVERSE"); expect(codesOf(w)).toContain("PREMIUM_SPREAD_WIDE");
    const m = await run({ bid: 115, ask: 125 }); expect(m.verdict).toBe("CAUTION"); expect(codesOf(m)).toContain("PREMIUM_SPREAD_MODERATE");
    const n = await run({ ask: null }); expect(n.verdict).toBe("ADVERSE"); expect(codesOf(n)).toContain("NO_MARKET_SIDE");
    const bidless = await run({ bid: null }); expect(bidless.verdict).toBe("CAUTION"); expect(codesOf(bidless)).toContain("ONE_SIDED_QUOTE");
  });
  it("open interest: low = CAUTION, poor = ADVERSE, missing = CAUTION; volume: low = CAUTION, none = ADVERSE", async () => {
    const lo = await run({ openInterest: 300 }); expect(lo.verdict).toBe("CAUTION"); expect(codesOf(lo)).toContain("OPEN_INTEREST_LOW");
    const po = await run({ openInterest: 20 }); expect(po.verdict).toBe("ADVERSE"); expect(codesOf(po)).toContain("OPEN_INTEREST_POOR");
    expect(codesOf(await run({ openInterest: null }))).toContain("OPEN_INTEREST_MISSING");
    const vl = await run({ volume: 50 }); expect(vl.verdict).toBe("CAUTION"); expect(codesOf(vl)).toContain("VOLUME_LOW");
    const vz = await run({ volume: 0 }); expect(vz.verdict).toBe("ADVERSE"); expect(codesOf(vz)).toContain("NO_TRADED_VOLUME");
  });
  it("strike distance: deep ITM = CAUTION; 5% OTM = CAUTION; 10% OTM = ADVERSE for a long and informational for a sale", async () => {
    const itm = await run({ underlyingPrice: 26_900, premium: 2_450, bid: 2_449, ask: 2_451 }, { inp: optionInputs({ rd: { expiry: "2025-01-30", entryPrice: 2_450, stopLoss: 2_000 } }) });
    expect(codesOf(itm)).toContain("STRIKE_DEEP_ITM");
    const otm5 = await run({ underlyingPrice: 23_000 }); expect(codesOf(otm5)).toContain("STRIKE_OTM"); expect(otm5.verdict).toBe("CAUTION");
    const otm10 = await run({ underlyingPrice: 22_000 }); expect(otm10.verdict).toBe("ADVERSE"); expect(codesOf(otm10)).toContain("STRIKE_FAR_OTM");
    expect(codesOf(await run({ underlyingPrice: 22_000 }, { inp: SELL() }))).toContain("STRIKE_OTM_FOR_SELLER");
  });
  it("a put is measured the other way around", async () => {
    const pe = optionInputs({ rd: { optionType: "PE", expiry: "2025-01-30" } });
    const p = optionsRiskAgent(rulesWithQuotes(), optionQuotes(goodOption({ delta: -0.5, underlyingPrice: 28_000 }), "NSE:NIFTY:2025-01-30:24500:PE"), null, null, null);
    const r = (await evalAgents([p], pe, {}, [], NOW)).byId(OPTIONS_RISK_AGENT_ID);
    expect(codesOf(r)).toContain("STRIKE_FAR_OTM"); expect(r.outputSnapshot["moneynessPct"]).toBeLessThan(0);
  });
  it("delta near 0 or 1 = CAUTION", async () => {
    expect(codesOf(await run({ delta: 0.05 }))).toContain("DELTA_LOW");
    expect(codesOf(await run({ delta: 0.95 }))).toContain("DELTA_HIGH");
  });
  it("premium sanity: very low, below intrinsic value, entry far from the quote", async () => {
    expect(codesOf(await run({ premium: 0.5, bid: 0.4, ask: 0.6 }))).toContain("PREMIUM_VERY_LOW");
    expect(codesOf(await run({ underlyingPrice: 24_900 }))).toContain("PREMIUM_BELOW_INTRINSIC"); // intrinsic 400 against a premium of 120
    const far = await run({ bid: 159, ask: 161 }); expect(far.verdict).toBe("ADVERSE"); expect(codesOf(far)).toContain("ENTRY_FAR_FROM_QUOTE");
    const away = await run({ bid: 134, ask: 136 }); expect(away.verdict).toBe("CAUTION"); expect(codesOf(away)).toContain("ENTRY_AWAY_FROM_QUOTE");
  });
  it("premium stop-loss coherence: already through the stop = BLOCKING (ADVERSE when configured); wrong side, inside the spread, within one day of decay", async () => {
    const through = await run({ bid: 84, ask: 86 }); expect(codesOf(through)).toContain("PREMIUM_THROUGH_STOP"); expect(through.verdict).toBe("BLOCKING");
    expect((await run({ bid: 84, ask: 86 }, { rules: rulesWithQuotes({ optionsRisk: { stopInvalidation: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    const wrong = await run({}, { inp: optionInputs({ rd: { stopLoss: 130 } }) }); expect(codesOf(wrong)).toContain("STOP_INCOHERENT"); expect(wrong.verdict).toBe("ADVERSE");
    const inside = await run({}, { inp: optionInputs({ rd: { stopLoss: 119 } }) }); expect(codesOf(inside)).toContain("STOP_INSIDE_SPREAD");
    const decay = await run({}, { inp: optionInputs({ rd: { stopLoss: 117 } }) }); expect(codesOf(decay)).toContain("STOP_WITHIN_DAILY_DECAY"); expect(decay.verdict).toBe("CAUTION");
    expect(codesOf(await run({}))).toContain("STOP_IMPLIED_UNDERLYING_MOVE");
    const sale = await run({ bid: 154, ask: 156, premium: 155 }, { inp: SELL(150) }); expect(codesOf(sale)).toContain("PREMIUM_THROUGH_STOP");
  });
  it("missing optional fields caution but are not failures: IV, greeks, open interest", async () => {
    const iv = await run({ iv: null, ivPrevious: null }); expect(iv.verdict).toBe("CAUTION"); expect(codesOf(iv)).toContain("IV_MISSING");
    const g = await run({ theta: null, vega: null }); expect(g.verdict).toBe("CAUTION"); expect(codesOf(g)).toContain("GREEKS_INCOMPLETE");
    expect(await run({ volume: null })).toMatchObject({ verdict: "SUPPORTIVE" });
  });
  it("too few dimensions assessed = NEUTRAL (never SUPPORTIVE)", async () => {
    const r = await run({ iv: null, ivPrevious: null, delta: null, gamma: null, theta: null, vega: null, openInterest: null, volume: null, bid: null, ask: 121 }, { chain: null, inp: SELL(150) });
    expect(r.verdict).not.toBe("SUPPORTIVE");
  });
});

describe("Options Risk Agent: the chain and the underlying price", () => {
  it("without a chain provider the chain is INFO only; a failing / empty chain cautions; a malformed chain = UNAVAILABLE", async () => {
    const none = await run({}, { chain: null }); expect(none.verdict).toBe("SUPPORTIVE"); expect(codesOf(none)).toContain("CHAIN_NOT_CONFIGURED");
    const failing = await run({}, { chainProvider: { name: "c", chain: async () => { throw new Error("SECRET-DETAIL"); } } });
    expect(failing.verdict).toBe("CAUTION"); expect(codesOf(failing)).toContain("CHAIN_UNAVAILABLE"); expect(JSON.stringify(failing)).not.toContain("SECRET-DETAIL");
    const empty = await run({}, { chainProvider: chains(goodChain(), "NSE:OTHER:2025-01-30") }); expect(codesOf(empty)).toContain("CHAIN_NOT_AVAILABLE");
    expect(await run({}, { chainProvider: { name: "c", chain: async () => ({ ...goodChain(), rows: [{ strike: -1, optionType: "CE", iv: 1, openInterest: 1, volume: 1 }] }) } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CHAIN_MALFORMED" });
  });
  it("a stale chain cautions; a chain too old to use is ignored with a caution", async () => {
    expect(codesOf(await run({}, { chain: goodChain({ asOf: at(-10) }) }))).toContain("CHAIN_STALE");
    expect(codesOf(await run({}, { chain: goodChain({ asOf: at(-120) }) }))).toContain("CHAIN_UNUSABLE");
  });
  it("a strike that is not in the chain = CAUTION", async () => {
    const r = await run({}, { chain: goodChain({ rows: [{ strike: 24_400, optionType: "CE", iv: 15, openInterest: 1, volume: 1 }] }) });
    expect(codesOf(r)).toContain("STRIKE_NOT_IN_CHAIN");
  });
  it("the underlying price comes from the quote, then the chain, then the OHLC provider; without any it is UNAVAILABLE", async () => {
    expect((await run({ underlyingPrice: null })).outputSnapshot).toMatchObject({ underlyingSource: "chain", underlyingPrice: 24_500 });
    expect((await run({ underlyingPrice: null }, { chain: goodChain({ underlyingPrice: null }), ohlc: ohlc(quiet(5, 24_500), { symbol: "NIFTY" }) })).outputSnapshot).toMatchObject({ underlyingSource: "ohlc" });
    expect(await run({ underlyingPrice: null }, { chain: null })).toMatchObject({ status: "UNAVAILABLE", errorCode: "UNDERLYING_PRICE_UNAVAILABLE" });
    expect(await run({ underlyingPrice: null }, { chain: null, ohlc: ohlc(quiet(5, 24_500), { symbol: "OTHER" }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "UNDERLYING_PRICE_UNAVAILABLE" });
  });
});

describe("Options Risk Agent: staleness", () => {
  it("a quote older than the caution limit = CAUTION; older than the unavailable limit or in the future = UNAVAILABLE", async () => {
    const stale = await run({ asOf: at(-10) }); expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("OPTION_QUOTE_STALE");
    expect(await run({ asOf: at(-60) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "OPTION_QUOTE_TOO_OLD" });
    expect(await run({ asOf: at(10) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "OPTION_QUOTE_FROM_FUTURE" });
  });
});

describe("Options Risk Agent: missing / failing / malformed data => UNAVAILABLE, never a pass", () => {
  it.each([
    ["no provider configured", { provider: null }, "OPTION_QUOTE_PROVIDER_NOT_CONFIGURED"],
    ["a provider that throws", { provider: { name: "x", quote: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "OPTION_QUOTE_PROVIDER_UNAVAILABLE"],
    ["no quote for the contract", {}, "OPTION_QUOTE_NOT_AVAILABLE"],
    ["no price and no market", { q: { premium: null, bid: null, ask: null } }, "OPTION_QUOTE_NO_PRICE"],
    ["a crossed quote", { q: { bid: 125, ask: 120 } }, "OPTION_QUOTE_MALFORMED"],
    ["a negative implied volatility", { q: { iv: -3 } }, "OPTION_QUOTE_MALFORMED"],
    ["a zero premium", { q: { premium: 0 } }, "OPTION_QUOTE_MALFORMED"],
    ["a delta of the wrong sign for a call", { q: { delta: -0.4 } }, "OPTION_QUOTE_MALFORMED"],
    ["a delta beyond 1", { q: { delta: 1.4 } }, "OPTION_QUOTE_MALFORMED"],
    ["a non-finite theta", { q: { theta: Number.NaN } }, "OPTION_QUOTE_MALFORMED"],
    ["a negative gamma", { q: { gamma: -0.1 } }, "OPTION_QUOTE_MALFORMED"],
    ["a malformed time", { q: { asOf: "soon" } }, "OPTION_QUOTE_MALFORMED"],
    ["a premium not below the underlying", { q: { premium: 30_000, bid: 29_999, ask: 30_001 } }, "OPTION_PREMIUM_IMPLAUSIBLE"],
    ["a non-object quote", { provider: { name: "x", quote: async () => "garbage" as never } }, "OPTION_QUOTE_MALFORMED"],
  ] as Array<[string, { provider?: OptionsQuoteProvider | null; q?: Partial<OptionQuote> }, string]>)("%s", async (name, o, code) => {
    const r = name === "no quote for the contract" ? await run(null) : await run(o.q ?? {}, o.provider === undefined ? {} : { provider: o.provider });
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("an incomplete option contract is UNAVAILABLE", async () => {
    expect(await run({}, { inp: optionInputs({ rd: { strike: null } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
    expect(await run({}, { inp: optionInputs({ rd: { expiry: null } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
    expect(await run({}, { inp: optionInputs({ rd: { optionType: null } }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "CONTRACT_INCOMPLETE" });
  });
});

describe("Options Risk Agent: safety", () => {
  it("is deterministic, never mutates the inputs and states evidence only", async () => {
    const inp = optionInputs(); const before = JSON.stringify(inp);
    const a = await run({ iv: 80, ivPrevious: 60 }, { inp }), b = await run({ iv: 80, ivPrevious: 60 }, { inp });
    expect(JSON.stringify(inp)).toBe(before);
    expect(JSON.stringify({ ...a, startedAt: 0, finishedAt: 0, durationMs: 0 })).toBe(JSON.stringify({ ...b, startedAt: 0, finishedAt: 0, durationMs: 0 }));
    expect(a.findings.map((f) => f.summary).join(" ")).not.toMatch(/\b(because|caused|due to|will|should|buy now|sell now)\b/i);
  });
  it("is a blocking-capable scoring agent with weight 50 and no dependencies", () => {
    expect(optionsRiskAgent(rulesWithQuotes(), null, null, null, null).contract).toMatchObject({ agentId: "options-risk-v1", canBlock: true, advisoryOnly: false, weight: 50, dependsOn: [] });
  });
});
