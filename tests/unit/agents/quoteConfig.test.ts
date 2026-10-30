import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chainProblem, contractKey, createProductionRegistry, DEFAULT_AGENT_RULES, fileOptionsChainProvider, fileOptionsQuoteProvider, fileQuoteProvider, INSTRUMENT_QUOTES_FORMAT, loadAgentRulesConfig, OPTION_CHAIN_FORMAT,
  OPTION_QUOTES_FORMAT, optionQuoteProblem, PRODUCTION_AGENT_IDS, quoteProblem, resolveQuoteProviders, type AgentContractError,
} from "../../../packages/agents/src/index";

type Rec = Record<string, ReturnType<typeof JSON.parse>>;
const tmp = (name: string, body: unknown): string => { const d = mkdtempSync(join(tmpdir(), "twins-quotes-")); const p = join(d, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const quotesFile = () => ({ format: INSTRUMENT_QUOTES_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", quotes: {
  "NSE:ACME": { bid: 99.9, ask: 100.1, last: 100, volume: 1000, avg_volume: 5000, open_interest: null, bid_depth: 100, ask_depth: 120, as_of: "2025-01-06T04:00:00Z" },
  "NSE:NIFTY:2025-01-30": { bid: 24_490, ask: 24_510, open_interest: 90_000, as_of: "2025-01-06T09:30:00+05:30" } } });
const optionFile = () => ({ format: OPTION_QUOTES_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", quotes: {
  "NSE:NIFTY:2025-01-30:24500:CE": { premium: 120, bid: 119, ask: 121, iv: 15, iv_previous: 14.5, delta: 0.5, gamma: 0.0004, theta: -4, vega: 12, open_interest: 50_000, volume: 20_000, underlying_price: 24_500, as_of: "2025-01-06T04:00:00Z" },
  "NSE:NIFTY:2025-01-30:24500:PE": { premium: 110, delta: -0.5, as_of: "2025-01-06T04:00:00Z" } } });
const chainFile = () => ({ format: OPTION_CHAIN_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", chains: {
  "NSE:NIFTY:2025-01-30": { underlying_price: 24_500, as_of: "2025-01-06T04:00:00Z", rows: [{ strike: 24_500, option_type: "CE", iv: 15, open_interest: 5000, volume: 100 }, { strike: 24_500, option_type: "PE", iv: null, open_interest: null, volume: null }] } } });
const err = (code: string) => expect.objectContaining({ code }) as AgentContractError;
const q = { market: "nse", symbol: "nifty", instrumentType: "option" as const, expiry: "2025-01-30", strike: 24_500, optionType: "CE" as const };

describe("quote files", () => {
  it("parse valid files and look contracts up by market, symbol, expiry, strike and type", async () => {
    const p = fileQuoteProvider(tmp("q.json", quotesFile()));
    expect(p.name).toBe("file:synthetic");
    expect(await p.quote({ market: "nse", symbol: "acme", instrumentType: "equity", expiry: null, strike: null, optionType: null })).toEqual({ bid: 99.9, ask: 100.1, last: 100, volume: 1000, avgVolume: 5000, openInterest: null, bidDepth: 100, askDepth: 120, asOf: "2025-01-06T04:00:00.000Z" });
    expect(await p.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2025-01-30", strike: null, optionType: null })).toMatchObject({ bid: 24_490, openInterest: 90_000, last: null, asOf: "2025-01-06T04:00:00.000Z" });
    expect(await p.quote({ market: "NSE", symbol: "OTHER", instrumentType: "equity", expiry: null, strike: null, optionType: null })).toBeNull();
    const o = fileOptionsQuoteProvider(tmp("o.json", optionFile()));
    expect(await o.quote(q)).toMatchObject({ premium: 120, ivPrevious: 14.5, underlyingPrice: 24_500, asOf: "2025-01-06T04:00:00.000Z" });
    expect(await o.quote({ ...q, optionType: "PE" })).toMatchObject({ premium: 110, delta: -0.5, iv: null });
    const c = fileOptionsChainProvider(tmp("c.json", chainFile()));
    expect(await c.chain({ market: "nse", underlying: "nifty", expiry: "2025-01-30" })).toMatchObject({ underlyingPrice: 24_500, rows: [{ strike: 24_500, optionType: "CE", iv: 15 }, { iv: null }] });
    expect(await c.chain({ market: "NSE", underlying: "NIFTY", expiry: "2025-02-27" })).toBeNull();
  });
  it("contractKey", () => {
    expect(contractKey(q)).toBe("NSE:NIFTY:2025-01-30:24500:CE");
    expect(contractKey({ market: "nse", symbol: "acme", expiry: null, strike: null, optionType: null })).toBe("NSE:ACME");
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["no quotes", (b) => { b["quotes"] = {}; }], ["a bad key", (b) => { b["quotes"]["acme"] = b["quotes"]["NSE:ACME"]; }],
    ["a negative bid", (b) => { b["quotes"]["NSE:ACME"].bid = -1; }], ["a crossed market", (b) => { b["quotes"]["NSE:ACME"].bid = 101; }], ["a zero ask", (b) => { b["quotes"]["NSE:ACME"].ask = 0; }],
    ["a negative volume", (b) => { b["quotes"]["NSE:ACME"].volume = -5; }], ["a string depth", (b) => { b["quotes"]["NSE:ACME"].bid_depth = "5"; }], ["a quote without a time", (b) => { delete b["quotes"]["NSE:ACME"].as_of; }],
    ["a time without an offset", (b) => { b["quotes"]["NSE:ACME"].as_of = "2025-01-06T04:00:00"; }],
  ])("a quote file with %s is refused at load", (_n, mutate) => { const b = quotesFile() as Rec; mutate(b); expect(() => fileQuoteProvider(tmp("q.json", b))).toThrowError(err("INVALID_QUOTE_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "twins-quotes-v1"; }], ["a key that is not an option contract", (b) => { b["quotes"]["NSE:NIFTY"] = b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"]; }],
    ["a crossed market", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].bid = 130; }], ["a negative implied volatility", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].iv = -1; }],
    ["a call delta below zero", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].delta = -0.2; }], ["a put delta above zero", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:PE"].delta = 0.2; }],
    ["a delta beyond 1", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].delta = 1.5; }], ["a negative gamma", (b) => { b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].gamma = -1; }], ["no time", (b) => { delete b["quotes"]["NSE:NIFTY:2025-01-30:24500:CE"].as_of; }],
  ])("an option quote file with %s is refused at load", (_n, mutate) => { const b = optionFile() as Rec; mutate(b); expect(() => fileOptionsQuoteProvider(tmp("o.json", b))).toThrowError(err("INVALID_QUOTE_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["a key without an expiry", (b) => { b["chains"]["NSE:NIFTY"] = b["chains"]["NSE:NIFTY:2025-01-30"]; }], ["a bad option type", (b) => { b["chains"]["NSE:NIFTY:2025-01-30"].rows[0].option_type = "XX"; }],
    ["a negative strike", (b) => { b["chains"]["NSE:NIFTY:2025-01-30"].rows[0].strike = -1; }], ["a zero underlying price", (b) => { b["chains"]["NSE:NIFTY:2025-01-30"].underlying_price = 0; }], ["rows that are not a list", (b) => { b["chains"]["NSE:NIFTY:2025-01-30"].rows = {}; }],
  ])("a chain file with %s is refused at load", (_n, mutate) => { const b = chainFile() as Rec; mutate(b); expect(() => fileOptionsChainProvider(tmp("c.json", b))).toThrowError(err("INVALID_QUOTE_DATA")); });
  it("the problem checks name the first problem and accept clean data", () => {
    const good = { bid: 1, ask: 2, last: null, volume: 0, avgVolume: null, openInterest: 0, bidDepth: null, askDepth: null, asOf: "2025-01-06T04:00:00Z" };
    expect(quoteProblem(good)).toBeNull(); expect(quoteProblem({ ...good, bid: 3 })).toBe("crossed"); expect(quoteProblem({ ...good, volume: -1 })).toBe("size"); expect(quoteProblem(null)).toBe("not an object");
    expect(optionQuoteProblem({ premium: 1, bid: null, ask: null, iv: null, ivPrevious: null, delta: -0.3, gamma: null, theta: null, vega: null, openInterest: null, volume: null, underlyingPrice: null, asOf: "2025-01-06T04:00:00Z" }, "PE")).toBeNull();
    expect(chainProblem({ underlyingPrice: null, asOf: "2025-01-06T04:00:00Z", rows: [] })).toBeNull(); expect(chainProblem({ asOf: "x", rows: [] })).toBe("shape");
  });
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files; resolveQuoteProviders resolves none / file and throws on a bad file", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-quotes-"));
    writeFileSync(join(d, "bad.json"), "{nope"); writeFileSync(join(d, "x.csv"), "a,b"); writeFileSync(join(d, "id_rsa.json"), JSON.stringify(quotesFile()));
    symlinkSync(tmp("ok.json", quotesFile()), join(d, "link.json"));
    for (const p of ["bad.json", "x.csv", "id_rsa.json", "link.json", "missing.json"].map((f) => join(d, f))) { expect(() => fileQuoteProvider(p), p).toThrow(); expect(() => fileOptionsQuoteProvider(p), p).toThrow(); expect(() => fileOptionsChainProvider(p), p).toThrow(); }
    expect(resolveQuoteProviders(DEFAULT_AGENT_RULES)).toEqual({ quoteProvider: null, optionsQuoteProvider: null, optionsChainProvider: null });
    const r = resolveQuoteProviders(loadAgentRulesConfig({ TWINS_AGENT_QUOTE_PROVIDER: `file:${tmp("q.json", quotesFile())}`, TWINS_AGENT_OPTION_QUOTE_PROVIDER: `file:${tmp("o.json", optionFile())}`, TWINS_AGENT_OPTION_CHAIN_PROVIDER: `file:${tmp("c.json", chainFile())}` }));
    expect([r.quoteProvider?.name, r.optionsQuoteProvider?.name, r.optionsChainProvider?.name]).toEqual(["file:synthetic", "file:synthetic", "file:synthetic"]);
    expect(() => resolveQuoteProviders(loadAgentRulesConfig({ TWINS_AGENT_QUOTE_PROVIDER: `file:${tmp("bad.json", "{")}` }))).toThrow();
  });
});

describe("rule configuration for the liquidity and options-risk agents", () => {
  it("defaults are conservative", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.quotes).toEqual({ source: "none", optionSource: "none", chainSource: "none", staleCautionMinutes: 5, unavailableMinutes: 30, futureToleranceMinutes: 2 });
    expect(DEFAULT_AGENT_RULES.liquidity).toMatchObject({ spreadCautionPct: 0.5, spreadAdversePct: 1.5, spreadExtremePct: 5, extremeSeverity: "BLOCKING", minDepthQuantity: 1, volumeThinRatio: 0.25 });
    expect(DEFAULT_AGENT_RULES.optionsRisk).toMatchObject({ ivCaution: 40, ivAdverse: 70, ivExtreme: 120, expiryExtremeHours: 3, gammaWindowDays: 2, stopInvalidation: "BLOCKING", extremeSeverity: "BLOCKING", poorVolume: 0 });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_QUOTE_PROVIDER: "file:/d/q.json", TWINS_AGENT_OPTION_QUOTE_PROVIDER: "file:/d/o.json", TWINS_AGENT_OPTION_CHAIN_PROVIDER: "file:/d/c.json", TWINS_AGENT_QUOTE_STALE_CAUTION_MINUTES: "2", TWINS_AGENT_QUOTE_STALE_UNAVAILABLE_MINUTES: "10",
      TWINS_AGENT_QUOTE_FUTURE_TOLERANCE_MINUTES: "1",
      TWINS_AGENT_LIQ_SPREAD_CAUTION_PCT: "0.3", TWINS_AGENT_LIQ_SPREAD_ADVERSE_PCT: "1", TWINS_AGENT_LIQ_SPREAD_EXTREME_PCT: "3", TWINS_AGENT_LIQ_OPTION_SPREAD_CAUTION_PCT: "4", TWINS_AGENT_LIQ_OPTION_SPREAD_ADVERSE_PCT: "12",
      TWINS_AGENT_LIQ_OPTION_SPREAD_EXTREME_PCT: "30", TWINS_AGENT_LIQ_EXTREME_SEVERITY: "ADVERSE", TWINS_AGENT_LIQ_VOLUME_THIN_RATIO: "0.1", TWINS_AGENT_LIQ_POOR_AVG_VOLUME: "500", TWINS_AGENT_LIQ_MIN_OPEN_INTEREST: "2000",
      TWINS_AGENT_LIQ_POOR_OPEN_INTEREST: "200", TWINS_AGENT_LIQ_MIN_DEPTH_QUANTITY: "10", TWINS_AGENT_LIQ_LAST_OUTSIDE_QUOTE_PCT: "1", TWINS_AGENT_LIQ_ENTRY_DEVIATION_CAUTION_PCT: "2", TWINS_AGENT_LIQ_ENTRY_DEVIATION_ADVERSE_PCT: "8",
      TWINS_AGENT_LIQ_OPTION_DEVIATION_MULTIPLIER: "4", TWINS_AGENT_LIQ_LAST_PRICE_DISCONNECT_PCT: "3",
      TWINS_AGENT_OPT_IV_CAUTION: "30", TWINS_AGENT_OPT_IV_ADVERSE: "60", TWINS_AGENT_OPT_IV_EXTREME: "100", TWINS_AGENT_OPT_IV_SPIKE_CAUTION_PCT: "10", TWINS_AGENT_OPT_IV_SPIKE_ADVERSE_PCT: "20", TWINS_AGENT_OPT_IV_SPIKE_EXTREME_PCT: "50",
      TWINS_AGENT_OPT_IV_ATM_RATIO_CAUTION: "1.3", TWINS_AGENT_OPT_EXPIRY_CAUTION_DAYS: "5", TWINS_AGENT_OPT_EXPIRY_ADVERSE_HOURS: "48", TWINS_AGENT_OPT_EXPIRY_EXTREME_HOURS: "4", TWINS_AGENT_OPT_EXPIRY_CLOSE_UTC: "09:30",
      TWINS_AGENT_OPT_THETA_CAUTION_PCT: "3", TWINS_AGENT_OPT_THETA_ADVERSE_PCT: "6", TWINS_AGENT_OPT_GAMMA_WINDOW_DAYS: "3", TWINS_AGENT_OPT_GAMMA_CAUTION: "0.08", TWINS_AGENT_OPT_GAMMA_ADVERSE: "0.15", TWINS_AGENT_OPT_VEGA_CAUTION_PCT: "6",
      TWINS_AGENT_OPT_DELTA_LOW: "0.15", TWINS_AGENT_OPT_DELTA_HIGH: "0.85", TWINS_AGENT_OPT_OTM_CAUTION_PCT: "4", TWINS_AGENT_OPT_OTM_ADVERSE_PCT: "8", TWINS_AGENT_OPT_ITM_CAUTION_PCT: "6", TWINS_AGENT_OPT_MIN_PREMIUM: "2",
      TWINS_AGENT_OPT_SPREAD_CAUTION_PCT: "4", TWINS_AGENT_OPT_SPREAD_ADVERSE_PCT: "8", TWINS_AGENT_OPT_ENTRY_DEVIATION_CAUTION_PCT: "8", TWINS_AGENT_OPT_ENTRY_DEVIATION_ADVERSE_PCT: "20", TWINS_AGENT_OPT_MIN_OPEN_INTEREST: "800",
      TWINS_AGENT_OPT_POOR_OPEN_INTEREST: "80", TWINS_AGENT_OPT_MIN_VOLUME: "200", TWINS_AGENT_OPT_POOR_VOLUME: "10", TWINS_AGENT_OPT_STOP_INVALIDATION: "ADVERSE", TWINS_AGENT_OPT_EXTREME_SEVERITY: "ADVERSE",
    });
    expect(c.quotes).toEqual({ source: "file:/d/q.json", optionSource: "file:/d/o.json", chainSource: "file:/d/c.json", staleCautionMinutes: 2, unavailableMinutes: 10, futureToleranceMinutes: 1 });
    expect(c.liquidity).toEqual({ spreadCautionPct: 0.3, spreadAdversePct: 1, spreadExtremePct: 3, optionSpreadCautionPct: 4, optionSpreadAdversePct: 12, optionSpreadExtremePct: 30, extremeSeverity: "ADVERSE", volumeThinRatio: 0.1, poorAvgVolume: 500, minOpenInterest: 2000,
      poorOpenInterest: 200, minDepthQuantity: 10, lastOutsideQuotePct: 1, entryDeviationCautionPct: 2, entryDeviationAdversePct: 8, optionDeviationMultiplier: 4, lastPriceDisconnectPct: 3 });
    expect(c.optionsRisk).toEqual({ ivCaution: 30, ivAdverse: 60, ivExtreme: 100, ivSpikeCautionPct: 10, ivSpikeAdversePct: 20, ivSpikeExtremePct: 50, ivAtmRatioCaution: 1.3, expiryCautionDays: 5, expiryAdverseHours: 48, expiryExtremeHours: 4, expiryCloseUtc: "09:30",
      thetaCautionPct: 3, thetaAdversePct: 6, gammaWindowDays: 3, gammaCaution: 0.08, gammaAdverse: 0.15, vegaCautionPct: 6, deltaLow: 0.15, deltaHigh: 0.85, otmCautionPct: 4, otmAdversePct: 8, itmCautionPct: 6, minPremium: 2, spreadCautionPct: 4, spreadAdversePct: 8,
      entryDeviationCautionPct: 8, entryDeviationAdversePct: 20, minOpenInterest: 800, poorOpenInterest: 80, minVolume: 200, poorVolume: 10, stopInvalidation: "ADVERSE", extremeSeverity: "ADVERSE" });
  });
  it.each<[string, Record<string, string>]>([
    ["a bad provider source", { TWINS_AGENT_QUOTE_PROVIDER: "https://feed" }], ["stale caution at the unavailable limit", { TWINS_AGENT_QUOTE_STALE_CAUTION_MINUTES: "30" }], ["a quote limit beyond a day", { TWINS_AGENT_QUOTE_STALE_UNAVAILABLE_MINUTES: "2000" }],
    ["non-increasing spread thresholds", { TWINS_AGENT_LIQ_SPREAD_CAUTION_PCT: "2" }], ["non-increasing option spread thresholds", { TWINS_AGENT_LIQ_OPTION_SPREAD_CAUTION_PCT: "20" }], ["poor open interest above the minimum", { TWINS_AGENT_LIQ_POOR_OPEN_INTEREST: "5000" }],
    ["non-increasing entry deviations", { TWINS_AGENT_LIQ_ENTRY_DEVIATION_CAUTION_PCT: "20" }], ["a bad extreme severity", { TWINS_AGENT_LIQ_EXTREME_SEVERITY: "CAUTION" }], ["non-increasing IV levels", { TWINS_AGENT_OPT_IV_CAUTION: "80" }],
    ["non-increasing IV spikes", { TWINS_AGENT_OPT_IV_SPIKE_CAUTION_PCT: "40" }], ["an ATM ratio at or below 1", { TWINS_AGENT_OPT_IV_ATM_RATIO_CAUTION: "1" }], ["an extreme window not below the adverse window", { TWINS_AGENT_OPT_EXPIRY_EXTREME_HOURS: "24" }],
    ["an adverse window beyond the caution window", { TWINS_AGENT_OPT_EXPIRY_ADVERSE_HOURS: "100" }], ["a bad close time", { TWINS_AGENT_OPT_EXPIRY_CLOSE_UTC: "25:00" }], ["non-increasing theta thresholds", { TWINS_AGENT_OPT_THETA_CAUTION_PCT: "9" }],
    ["non-increasing gamma thresholds", { TWINS_AGENT_OPT_GAMMA_CAUTION: "0.3" }], ["a delta window that is not ordered", { TWINS_AGENT_OPT_DELTA_LOW: "0.95" }], ["non-increasing OTM thresholds", { TWINS_AGENT_OPT_OTM_CAUTION_PCT: "12" }],
    ["poor volume above the minimum", { TWINS_AGENT_OPT_POOR_VOLUME: "500" }], ["a bad stop severity", { TWINS_AGENT_OPT_STOP_INVALIDATION: "CAUTION" }], ["a non-numeric value", { TWINS_AGENT_OPT_IV_CAUTION: "high" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("registration, worker wiring and source hygiene", () => {
  it("the twelve production agents include liquidity-v1 and options-risk-v1; a missing provider never throws at registration", () => {
    expect([...PRODUCTION_AGENT_IDS].slice(-4, -2)).toEqual(["liquidity-v1", "options-risk-v1"]);
    const ids = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).snapshot().map((x) => x.agentId);
    expect(ids).toHaveLength(12); expect(ids).toEqual(expect.arrayContaining(["liquidity-v1", "options-risk-v1"]));
  });
  it("the worker resolves the quote providers only when the engine is enabled", () => {
    expect(readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8")).toMatch(/\.\.\.resolveQuoteProviders\(agentRules\), \.\.\.resolveHistoricalProviders\(agentRules\) \} : null;/);
  });
  it("the new agent and provider sources read no message text, import no network / broker / LLM code, read no system clock and write nothing", () => {
    for (const f of ["liquidity.ts", "optionsRisk.ts", "quoteProviders.ts", "quoteCommon.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(|schema\./i);
    }
  });
});
