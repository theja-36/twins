import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_RULES, fileLastPriceProvider, fileOhlcProvider, historicalOhlcProvider, LAST_PRICE_FORMAT, loadAgentRulesConfig, OHLC_FORMAT, ohlcProblem, parseLastPriceFile, parseOhlcFile, resolveOhlcProviders, type AgentContractError } from "../../../packages/agents/src/index";
import { memoryProvider } from "../../../packages/historical/src/index";

type Rec = Record<string, ReturnType<typeof JSON.parse>>;
const tmp = (name: string, body: unknown): string => { const d = mkdtempSync(join(tmpdir(), "twins-ohlc-")); const p = join(d, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const file = () => ({ format: OHLC_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", series: { "NSE:ACME": { interval_seconds: 86400, bars: [
  { t: "2025-01-02T03:45:00Z", o: 100, h: 102, l: 99, c: 101, v: 1000 }, { t: "2025-01-03T03:45:00Z", o: 101, h: 103, l: 100, c: 102 }, { t: "2025-01-06T09:15:00+05:30", o: 102, h: 104, l: 101, c: 103.5 } ] } } });
const prices = () => ({ format: LAST_PRICE_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", prices: { "NSE:ACME": { price: 103.2, as_of: "2025-01-06T03:59:00Z" } } });
const err = (code: string) => expect.objectContaining({ code }) as AgentContractError;

describe("OHLC and last-price files", () => {
  it("parse valid files; the query returns the most recent bars at or before `to`", async () => {
    const p = fileOhlcProvider(tmp("o.json", file()));
    expect(p).toMatchObject({ name: "file:synthetic", asOf: "2025-01-06T04:00:00.000Z" });
    const s = await p.candles({ market: "nse", symbol: "acme", limit: 2, to: "2025-01-06T05:00:00Z" });
    expect(s?.intervalSeconds).toBe(86_400); expect(s?.bars.map((b) => [b.t, b.close, b.volume])).toEqual([["2025-01-03T03:45:00.000Z", 102, null], ["2025-01-06T03:45:00.000Z", 103.5, null]]);
    expect((await p.candles({ market: "NSE", symbol: "ACME", limit: 10, to: "2025-01-03T04:00:00Z" }))?.bars).toHaveLength(2);
    expect(await p.candles({ market: "NSE", symbol: "OTHER", limit: 10, to: "2025-01-06T05:00:00Z" })).toBeNull();
    const l = fileLastPriceProvider(tmp("l.json", prices()));
    expect(await l.price({ market: "nse", symbol: "acme" })).toEqual({ price: 103.2, asOf: "2025-01-06T03:59:00.000Z" });
    expect(await l.price({ market: "NSE", symbol: "OTHER" })).toBeNull();
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["no series", (b) => { b["series"] = {}; }], ["a bad key", (b) => { b["series"]["acme"] = b["series"]["NSE:ACME"]; delete b["series"]["NSE:ACME"]; }],
    ["a bad interval", (b) => { b["series"]["NSE:ACME"].interval_seconds = 0; }], ["a negative price", (b) => { b["series"]["NSE:ACME"].bars[0].l = -1; }], ["high below low", (b) => { b["series"]["NSE:ACME"].bars[0].h = 98; }],
    ["a close above the high", (b) => { b["series"]["NSE:ACME"].bars[0].c = 110; }], ["unsorted times", (b) => { b["series"]["NSE:ACME"].bars[1].t = "2025-01-01T03:45:00Z"; }], ["a time without an offset", (b) => { b["series"]["NSE:ACME"].bars[0].t = "2025-01-02T03:45:00"; }],
    ["a negative volume", (b) => { b["series"]["NSE:ACME"].bars[0].v = -1; }],
  ])("rejects an OHLC file with %s (nothing is repaired)", (_n, mutate) => { const b = structuredClone(file()) as Rec; mutate(b); expect(() => parseOhlcFile(b)).toThrowError(err("INVALID_OHLC_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["a bad key", (b) => { b["prices"]["acme"] = b["prices"]["NSE:ACME"]; delete b["prices"]["NSE:ACME"]; }], ["a non-positive price", (b) => { b["prices"]["NSE:ACME"].price = 0; }], ["no time", (b) => { delete b["prices"]["NSE:ACME"].as_of; }],
  ])("rejects a last-price file with %s", (_n, mutate) => { const b = structuredClone(prices()) as Rec; mutate(b); expect(() => parseLastPriceFile(b)).toThrowError(err("INVALID_OHLC_DATA")); });
  it("ohlcProblem names the first problem", () => {
    expect(ohlcProblem(null)).toBe("series"); expect(ohlcProblem({ symbol: "A", intervalSeconds: 60, bars: [{ t: "2025-01-01T00:00:00Z", open: 1, high: 0.5, low: 1, close: 1, volume: null }] })).toBe("ohlc");
  });
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files; resolveOhlcProviders resolves none / file and throws on a bad file", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-ohlc-"));
    writeFileSync(join(d, "bad.json"), "{nope"); writeFileSync(join(d, "x.csv"), "a,b"); writeFileSync(join(d, "id_rsa.json"), JSON.stringify(file()));
    symlinkSync(tmp("ok.json", file()), join(d, "link.json"));
    for (const p of ["bad.json", "x.csv", "id_rsa.json", "link.json", "missing.json"].map((f) => join(d, f))) { expect(() => fileOhlcProvider(p), p).toThrowError(err("INVALID_NEWS_DATA")); expect(() => fileLastPriceProvider(p), p).toThrow(); }
    expect(resolveOhlcProviders(DEFAULT_AGENT_RULES)).toEqual({ ohlcProvider: null, lastPriceProvider: null });
    const r = resolveOhlcProviders(loadAgentRulesConfig({ TWINS_AGENT_OHLC_PROVIDER: `file:${tmp("o.json", file())}`, TWINS_AGENT_LAST_PRICE_PROVIDER: `file:${tmp("l.json", prices())}` }));
    expect([r.ohlcProvider?.name, r.lastPriceProvider?.name]).toEqual(["file:synthetic", "file:synthetic"]);
    expect(() => resolveOhlcProviders(loadAgentRulesConfig({ TWINS_AGENT_OHLC_PROVIDER: `file:${tmp("bad.json", "{")}` }))).toThrow();
  });
  it("the historical adapter exposes an imported equity price series read-only", async () => {
    const hp = memoryProvider([{ format: "twins-historical-bars-v1", provider: "p", dataset_id: "d", dataset_version: "1", series: [{ kind: "equity_price", symbol: "ACME", market: "NSE", interval_seconds: 86400, allowed_gap_seconds: 259200, bars: [{ t: "2025-01-02T03:45:00Z", o: 100, h: 102, l: 99, c: 101 }, { t: "2025-01-03T03:45:00Z", o: 101, h: 103, l: 100, c: 102 }] }] }]);
    const a = historicalOhlcProvider(hp);
    expect(a.asOf).toBeNull();
    const s = await a.candles({ market: "NSE", symbol: "acme", limit: 5, to: "2025-01-06T00:00:00Z" });
    expect(s?.bars.map((b) => b.close)).toEqual([101, 102]); expect(ohlcProblem(s)).toBeNull();
    expect(await a.candles({ market: "NSE", symbol: "NOPE", limit: 5, to: "2025-01-06T00:00:00Z" })).toBeNull();
  });
});

describe("rule configuration for the technical and price-action agents", () => {
  it("defaults are conservative", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.ohlc).toMatchObject({ source: "none", priceSource: "none", market: "NSE", staleCautionMinutes: 120, unavailableMinutes: 1440, maxBarAgeDays: 5 });
    expect(DEFAULT_AGENT_RULES.technical).toMatchObject({ minBars: 60, shortLookback: 10, longLookback: 30, trendAdversePct: 4, breakdownAgainst: "ADVERSE", invalidation: "BLOCKING" });
    expect(DEFAULT_AGENT_RULES.priceAction).toMatchObject({ minBars: 30, atrPeriod: 14, patternWindow: 3, criticalReversal: "ADVERSE", consecutiveCaution: 3, consecutiveAdverse: 5 });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_OHLC_PROVIDER: "file:/d/o.json", TWINS_AGENT_LAST_PRICE_PROVIDER: "file:/d/l.json", TWINS_AGENT_OHLC_MARKET: "BSE", TWINS_AGENT_OHLC_STALE_CAUTION_MINUTES: "30", TWINS_AGENT_OHLC_STALE_UNAVAILABLE_MINUTES: "600",
      TWINS_AGENT_OHLC_MAX_BAR_AGE_DAYS: "3", TWINS_AGENT_OHLC_FUTURE_TOLERANCE_MINUTES: "2", TWINS_AGENT_OHLC_PRICE_DISCONNECT_PCT: "3",
      TWINS_AGENT_TECH_MIN_BARS: "80", TWINS_AGENT_TECH_SHORT_LOOKBACK: "5", TWINS_AGENT_TECH_LONG_LOOKBACK: "40", TWINS_AGENT_TECH_TREND_CAUTION_PCT: "2", TWINS_AGENT_TECH_TREND_ADVERSE_PCT: "6", TWINS_AGENT_TECH_SWING_STRENGTH: "3",
      TWINS_AGENT_TECH_BREAKOUT_LOOKBACK: "30", TWINS_AGENT_TECH_SR_PROXIMITY_PCT: "1", TWINS_AGENT_TECH_FAST_MA: "8", TWINS_AGENT_TECH_SLOW_MA: "50", TWINS_AGENT_TECH_RSI_PERIOD: "10", TWINS_AGENT_TECH_RSI_STRETCHED: "80",
      TWINS_AGENT_TECH_MOMENTUM_AGAINST: "20", TWINS_AGENT_TECH_RANGE_EFFICIENCY: "0.3", TWINS_AGENT_TECH_BREAKDOWN_AGAINST: "BLOCKING", TWINS_AGENT_TECH_INVALIDATION: "ADVERSE",
      TWINS_AGENT_PA_MIN_BARS: "40", TWINS_AGENT_PA_ATR_PERIOD: "10", TWINS_AGENT_PA_PATTERN_WINDOW: "5", TWINS_AGENT_PA_MIN_BODY_ATR: "0.4", TWINS_AGENT_PA_WICK_RATIO: "0.7", TWINS_AGENT_PA_STRONG_RANGE_ATR: "2", TWINS_AGENT_PA_GAP_CAUTION_PCT: "0.4",
      TWINS_AGENT_PA_GAP_ADVERSE_PCT: "2", TWINS_AGENT_PA_CONSECUTIVE_CAUTION: "2", TWINS_AGENT_PA_CONSECUTIVE_ADVERSE: "4", TWINS_AGENT_PA_EXPANSION_RATIO: "2.5", TWINS_AGENT_PA_EXPANSION_ADVERSE_RATIO: "4", TWINS_AGENT_PA_CONTRACTION_RATIO: "0.4",
      TWINS_AGENT_PA_EXTREME_LOOKBACK: "25", TWINS_AGENT_PA_EXTREME_PROXIMITY_PCT: "1", TWINS_AGENT_PA_EXHAUSTION_RUN: "4", TWINS_AGENT_PA_CRITICAL_REVERSAL: "BLOCKING",
    });
    expect(c.ohlc).toEqual({ source: "file:/d/o.json", priceSource: "file:/d/l.json", market: "BSE", staleCautionMinutes: 30, unavailableMinutes: 600, maxBarAgeDays: 3, futureToleranceMinutes: 2, priceDisconnectPct: 3 });
    expect(c.technical).toEqual({ minBars: 80, shortLookback: 5, longLookback: 40, trendCautionPct: 2, trendAdversePct: 6, swingStrength: 3, breakoutLookback: 30, srProximityPct: 1, fastMa: 8, slowMa: 50, rsiPeriod: 10, rsiStretched: 80, momentumAgainst: 20, rangeEfficiency: 0.3, breakdownAgainst: "BLOCKING", invalidation: "ADVERSE" });
    expect(c.priceAction).toEqual({ minBars: 40, atrPeriod: 10, patternWindow: 5, minBodyAtr: 0.4, wickRatio: 0.7, strongRangeAtr: 2, gapCautionPct: 0.4, gapAdversePct: 2, consecutiveCaution: 2, consecutiveAdverse: 4, expansionRatio: 2.5, expansionAdverseRatio: 4, contractionRatio: 0.4, extremeLookback: 25, extremeProximityPct: 1, exhaustionRun: 4, criticalReversal: "BLOCKING" });
  });
  it.each<[string, Record<string, string>]>([
    ["a bad provider source", { TWINS_AGENT_OHLC_PROVIDER: "https://feed" }], ["a bad market", { TWINS_AGENT_OHLC_MARKET: "n" }], ["stale caution above the unavailable limit", { TWINS_AGENT_OHLC_STALE_CAUTION_MINUTES: "2000" }],
    ["a short lookback not below the long one", { TWINS_AGENT_TECH_SHORT_LOOKBACK: "30" }], ["min bars that do not cover the lookbacks", { TWINS_AGENT_TECH_MIN_BARS: "20" }], ["a fast average not below the slow one", { TWINS_AGENT_TECH_FAST_MA: "30" }],
    ["non-increasing trend thresholds", { TWINS_AGENT_TECH_TREND_CAUTION_PCT: "5" }], ["an RSI limit at or below 50", { TWINS_AGENT_TECH_RSI_STRETCHED: "40" }], ["a bad severity", { TWINS_AGENT_TECH_INVALIDATION: "CAUTION" }],
    ["price-action min bars below the extreme lookback", { TWINS_AGENT_PA_MIN_BARS: "10" }], ["consecutive thresholds not increasing", { TWINS_AGENT_PA_CONSECUTIVE_CAUTION: "6" }], ["a wick ratio at or below 0.3", { TWINS_AGENT_PA_WICK_RATIO: "0.2" }],
    ["non-increasing gap thresholds", { TWINS_AGENT_PA_GAP_CAUTION_PCT: "3" }], ["an expansion ratio at or below 1", { TWINS_AGENT_PA_EXPANSION_RATIO: "1" }], ["a non-numeric value", { TWINS_AGENT_PA_ATR_PERIOD: "many" }],
    ["a bad critical severity", { TWINS_AGENT_PA_CRITICAL_REVERSAL: "INFO" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("worker wiring and source hygiene", () => {
  it("the worker resolves the OHLC providers only when the engine is enabled", () => {
    expect(readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8")).toMatch(/\.\.\.resolveOhlcProviders\(agentRules\)/);
  });
  it("the new agent and provider sources read no message text, import no network / broker / LLM code, read no system clock and write nothing", () => {
    for (const f of ["technicalStructure.ts", "priceAction.ts", "ohlcProviders.ts", "ohlcCommon.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(|schema\./i);
    }
  });
});
