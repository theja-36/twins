import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSTITUENTS_FORMAT, DEFAULT_AGENT_RULES, fileConstituentProvider, fileMarketData, fileNewsProvider, fileSentimentProvider, loadAgentRulesConfig, NEWS_FORMAT, parseConstituentsFile, parseNewsFile, parseQuotesFile, parseSentimentFile,
  QUOTES_FORMAT, resolveNewsConstituentProviders, SENTIMENT_FORMAT, type AgentContractError,
} from "../../../packages/agents/src/index";

type Rec = Record<string, ReturnType<typeof JSON.parse>>;
const tmp = (name: string, body: unknown): string => { const d = mkdtempSync(join(tmpdir(), "twins-news-")); const p = join(d, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const news = () => ({ format: NEWS_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", items: [{ id: "n1", published_at: "2025-01-06T03:30:00Z", source_label: "SynthWire", headline: "Synthetic headline", symbols: ["ACME", "*"], markets: ["NSE"], sentiment_label: "NEGATIVE", sentiment_score: -0.6, impact: "HIGH", category: "earnings", reference: "ref-1", source_reliability: 0.8 }] });
const sentiment = () => ({ format: SENTIMENT_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", entries: { "NSE:ACME": { score: -0.4, label: "NEGATIVE", sample_size: 25, as_of: "2025-01-06T03:55:00Z" } } });
const cons = () => ({ format: CONSTITUENTS_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", indices: { NIFTY: { as_of: "2025-01-06T04:00:00Z", constituents: [{ symbol: "AAA", weight: 60, sector: "Financials", recent_change_pct: 0.5, data_as_of: "2025-01-06T03:59:00Z", news_refs: ["n1"] }, { symbol: "BBB", weight: 30, sector: "Technology", data_as_of: "2025-01-06T03:59:00Z" }] } } });
const quotes = () => ({ format: QUOTES_FORMAT, source: "synthetic", as_of: "2025-01-06T04:00:00Z", quotes: { "NSE:AAA": { change_pct_1d: -0.8, as_of: "2025-01-06T03:59:00Z" } } });
const err = (code: string) => expect.objectContaining({ code }) as AgentContractError;

describe("news and sentiment files", () => {
  it("parse valid files; the news query filters by window, market and symbol (market-wide '*' matches any underlying)", async () => {
    const p = fileNewsProvider(tmp("n.json", news()));
    expect(p).toMatchObject({ name: "file:synthetic", asOf: "2025-01-06T04:00:00.000Z" });
    const q = { from: "2025-01-06T00:00:00Z", to: "2025-01-06T05:00:00Z", market: "nse", symbols: ["acme"] };
    expect((await p.items(q)).map((i) => [i.id, i.impact, i.sentimentScore, i.reference])).toEqual([["n1", "HIGH", -0.6, "ref-1"]]);
    expect(await p.items({ ...q, symbols: ["OTHER"] })).toHaveLength(1); // matched through "*"
    expect(await p.items({ ...q, market: "LSE" })).toEqual([]);
    expect(await p.items({ ...q, from: "2025-01-06T03:45:00Z" })).toEqual([]);
    const s = fileSentimentProvider(tmp("s.json", sentiment()));
    expect(await s.sentiment({ market: "nse", symbol: "acme" })).toEqual({ score: -0.4, label: "NEGATIVE", sampleSize: 25, asOf: "2025-01-06T03:55:00.000Z" });
    expect(await s.sentiment({ market: "NSE", symbol: "OTHER" })).toBeNull();
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no as_of", (b) => { delete b["as_of"]; }], ["an item time without an offset", (b) => { b["items"][0].published_at = "2025-01-06T03:30:00"; }],
    ["an unknown impact", (b) => { b["items"][0].impact = "HUGE"; }], ["an out-of-range score", (b) => { b["items"][0].sentiment_score = 2; }], ["an unsafe source label", (b) => { b["items"][0].source_label = "<script>"; }],
    ["an unsafe reference", (b) => { b["items"][0].reference = "javascript:alert(1)"; }], ["a lower-case symbol", (b) => { b["items"][0].symbols = ["acme"]; }], ["a duplicate id", (b) => { b["items"].push({ ...b["items"][0] }); }],
    ["an empty headline", (b) => { b["items"][0].headline = " "; }], ["a bad reliability", (b) => { b["items"][0].source_reliability = 1.5; }],
  ])("rejects a news file with %s", (_n, mutate) => { const b = structuredClone(news()) as Rec; mutate(b); expect(() => parseNewsFile(b)).toThrowError(err("INVALID_NEWS_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["a bad key", (b) => { b["entries"]["acme"] = b["entries"]["NSE:ACME"]; delete b["entries"]["NSE:ACME"]; }], ["a score out of range", (b) => { b["entries"]["NSE:ACME"].score = -3; }],
    ["a bad sample size", (b) => { b["entries"]["NSE:ACME"].sample_size = 1.5; }], ["a bad label", (b) => { b["entries"]["NSE:ACME"].label = "x"; }],
  ])("rejects a sentiment file with %s", (_n, mutate) => { const b = structuredClone(sentiment()) as Rec; mutate(b); expect(() => parseSentimentFile(b)).toThrowError(err("INVALID_NEWS_DATA")); });
});

describe("index constituent and market quote files", () => {
  it("parse valid files", async () => {
    const p = fileConstituentProvider(tmp("c.json", cons()));
    expect(await p.knowsIndex("nifty")).toBe(true); expect(await p.knowsIndex("OTHER")).toBe(false);
    const set = await p.constituents("NIFTY");
    expect(set?.constituents.map((c) => [c.symbol, c.weight, c.recentChangePct, c.newsRefs])).toEqual([["AAA", 60, 0.5, ["n1"]], ["BBB", 30, null, []]]);
    const m = fileMarketData(tmp("q.json", quotes()));
    expect(await m.quotes({ market: "nse", symbols: ["aaa", "zzz"] })).toEqual({ AAA: { changePct1d: -0.8, asOf: "2025-01-06T03:59:00.000Z" } });
  });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["no indices", (b) => { b["indices"] = {}; }], ["a zero weight", (b) => { b["indices"]["NIFTY"].constituents[0].weight = 0; }],
    ["weights above 100", (b) => { b["indices"]["NIFTY"].constituents[0].weight = 90; b["indices"]["NIFTY"].constituents[1].weight = 90; }], ["a duplicate symbol", (b) => { b["indices"]["NIFTY"].constituents[1].symbol = "AAA"; }],
    ["a missing data_as_of", (b) => { delete b["indices"]["NIFTY"].constituents[0].data_as_of; }], ["an unsafe sector", (b) => { b["indices"]["NIFTY"].constituents[0].sector = "<b>"; }],
    ["an absurd change", (b) => { b["indices"]["NIFTY"].constituents[0].recent_change_pct = 500; }], ["bad news refs", (b) => { b["indices"]["NIFTY"].constituents[0].news_refs = ["a b"]; }], ["no constituents", (b) => { b["indices"]["NIFTY"].constituents = []; }],
  ])("rejects a constituents file with %s", (_n, mutate) => { const b = structuredClone(cons()) as Rec; mutate(b); expect(() => parseConstituentsFile(b)).toThrowError(err("INVALID_CONSTITUENT_DATA")); });
  it.each<[string, (b: Rec) => void]>([
    ["a wrong format", (b) => { b["format"] = "x"; }], ["a bad key", (b) => { b["quotes"]["aaa"] = b["quotes"]["NSE:AAA"]; delete b["quotes"]["NSE:AAA"]; }], ["a non-finite change", (b) => { b["quotes"]["NSE:AAA"].change_pct_1d = "up"; }],
    ["a missing time", (b) => { delete b["quotes"]["NSE:AAA"].as_of; }],
  ])("rejects a quotes file with %s", (_n, mutate) => { const b = structuredClone(quotes()) as Rec; mutate(b); expect(() => parseQuotesFile(b)).toThrowError(err("INVALID_CONSTITUENT_DATA")); });
});

describe("provider files are read safely and resolved at start-up", () => {
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-news-"));
    writeFileSync(join(d, "bad.json"), "{nope"); writeFileSync(join(d, "x.csv"), "a,b"); writeFileSync(join(d, "id_rsa.json"), JSON.stringify(news()));
    symlinkSync(tmp("ok.json", news()), join(d, "link.json"));
    for (const p of ["bad.json", "x.csv", "id_rsa.json", "link.json", "missing.json"].map((f) => join(d, f))) {
      expect(() => fileNewsProvider(p), p).toThrowError(err("INVALID_NEWS_DATA"));
      expect(() => fileSentimentProvider(p), p).toThrow(); expect(() => fileConstituentProvider(p), p).toThrow(); expect(() => fileMarketData(p), p).toThrow();
    }
  });
  it("resolveNewsConstituentProviders: none => null, file: => provider, a bad file THROWS (start-up fails closed)", () => {
    expect(resolveNewsConstituentProviders(DEFAULT_AGENT_RULES)).toEqual({ newsProvider: null, sentimentProvider: null, constituentProvider: null, marketDataProvider: null });
    const r = resolveNewsConstituentProviders(loadAgentRulesConfig({ TWINS_AGENT_NEWS_PROVIDER: `file:${tmp("n.json", news())}`, TWINS_AGENT_SENTIMENT_PROVIDER: `file:${tmp("s.json", sentiment())}`, TWINS_AGENT_CONSTITUENT_PROVIDER: `file:${tmp("c.json", cons())}`, TWINS_AGENT_MARKET_DATA_PROVIDER: `file:${tmp("q.json", quotes())}` }));
    expect([r.newsProvider?.name, r.sentimentProvider?.name, r.constituentProvider?.name, r.marketDataProvider?.name]).toEqual(["file:synthetic", "file:synthetic", "file:synthetic", "file:synthetic"]);
    expect(() => resolveNewsConstituentProviders(loadAgentRulesConfig({ TWINS_AGENT_NEWS_PROVIDER: `file:${tmp("bad.json", "{")}` }))).toThrow();
  });
});

describe("rule configuration for the news and constituent agents", () => {
  it("defaults are conservative", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.news).toMatchObject({ source: "none", sentimentSource: "none", lookbackMinutes: 1440, nearTermMinutes: 120, sentimentThreshold: 0.3, criticalAdverse: "BLOCKING", staleCautionMinutes: 120, unavailableMinutes: 1440 });
    expect(DEFAULT_AGENT_RULES.constituent).toMatchObject({ constituentSource: "none", marketDataSource: "none", topCount: 10, minWeight: 1, minCoveredWeight: 60, criticalWeight: 5, criticalEvent: "BLOCKING", quoteMarket: "NSE", indexUnderlyings: ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTY", "SENSEX"] });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_NEWS_PROVIDER: "file:/d/n.json", TWINS_AGENT_SENTIMENT_PROVIDER: "file:/d/s.json", TWINS_AGENT_NEWS_LOOKBACK_MINUTES: "600", TWINS_AGENT_NEWS_NEAR_TERM_MINUTES: "60", TWINS_AGENT_NEWS_SENTIMENT_THRESHOLD: "0.4",
      TWINS_AGENT_SENTIMENT_AGGREGATE_CAUTION: "0.1", TWINS_AGENT_SENTIMENT_AGGREGATE_ADVERSE: "0.6", TWINS_AGENT_SENTIMENT_MIN_SAMPLE: "10", TWINS_AGENT_NEWS_MIN_RELIABILITY: "0.7", TWINS_AGENT_NEWS_STALE_CAUTION_MINUTES: "30",
      TWINS_AGENT_NEWS_STALE_UNAVAILABLE_MINUTES: "300", TWINS_AGENT_NEWS_FUTURE_TOLERANCE_MINUTES: "2", TWINS_AGENT_NEWS_MAX_ITEMS: "100", TWINS_AGENT_NEWS_CRITICAL_ADVERSE: "ADVERSE",
      TWINS_AGENT_CONSTITUENT_PROVIDER: "file:/d/c.json", TWINS_AGENT_MARKET_DATA_PROVIDER: "file:/d/q.json", TWINS_AGENT_CONSTITUENT_TOP_COUNT: "5", TWINS_AGENT_CONSTITUENT_MIN_WEIGHT: "2", TWINS_AGENT_CONSTITUENT_MIN_COVERED_WEIGHT: "50",
      TWINS_AGENT_CONSTITUENT_MIN_USABLE_SHARE: "0.8", TWINS_AGENT_CONSTITUENT_MOVE_CAUTION: "0.5", TWINS_AGENT_CONSTITUENT_MOVE_ADVERSE: "1.5", TWINS_AGENT_CONSTITUENT_EXTREME_MOVE: "8", TWINS_AGENT_CONSTITUENT_IMPACT_CAUTION: "0.2",
      TWINS_AGENT_CONSTITUENT_IMPACT_ADVERSE: "0.5", TWINS_AGENT_CONSTITUENT_SINGLE_CONTRIBUTION_ADVERSE: "0.3", TWINS_AGENT_CONSTITUENT_SECTOR_CONCENTRATION: "0.4", TWINS_AGENT_CONSTITUENT_STALE_CAUTION_MINUTES: "30",
      TWINS_AGENT_CONSTITUENT_STALE_UNAVAILABLE_MINUTES: "600", TWINS_AGENT_CONSTITUENT_CRITICAL_WEIGHT: "8", TWINS_AGENT_CONSTITUENT_CRITICAL_EVENT: "ADVERSE", TWINS_AGENT_CONSTITUENT_NEWS_LOOKBACK_MINUTES: "300",
      TWINS_AGENT_CONSTITUENT_NEWS_NEAR_TERM_MINUTES: "30", TWINS_AGENT_CONSTITUENT_SENTIMENT_THRESHOLD: "0.5", TWINS_AGENT_CONSTITUENT_MIN_RELIABILITY: "0.6", TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS: "SENSEX,NIFTY", TWINS_AGENT_CONSTITUENT_QUOTE_MARKET: "BSE",
    });
    expect(c.news).toEqual({ source: "file:/d/n.json", sentimentSource: "file:/d/s.json", lookbackMinutes: 600, nearTermMinutes: 60, sentimentThreshold: 0.4, aggregateCaution: 0.1, aggregateAdverse: 0.6, aggregateMinSample: 10, minReliability: 0.7, staleCautionMinutes: 30, unavailableMinutes: 300, futureToleranceMinutes: 2, maxItems: 100, criticalAdverse: "ADVERSE" });
    expect(c.constituent).toEqual({
      constituentSource: "file:/d/c.json", marketDataSource: "file:/d/q.json", topCount: 5, minWeight: 2, minCoveredWeight: 50, minUsableShare: 0.8, moveCaution: 0.5, moveAdverse: 1.5, extremeMove: 8, impactCaution: 0.2, impactAdverse: 0.5, singleContributionAdverse: 0.3,
      sectorConcentration: 0.4, staleCautionMinutes: 30, unavailableMinutes: 600, criticalWeight: 8, criticalEvent: "ADVERSE", newsLookbackMinutes: 300, nearTermMinutes: 30, sentimentThreshold: 0.5, minReliability: 0.6, indexUnderlyings: ["NIFTY", "SENSEX"], quoteMarket: "BSE",
    });
  });
  it.each<[string, Record<string, string>]>([
    ["a bad provider source", { TWINS_AGENT_NEWS_PROVIDER: "https://feed" }], ["a near-term window longer than the lookback", { TWINS_AGENT_NEWS_NEAR_TERM_MINUTES: "2000" }], ["a zero sentiment threshold", { TWINS_AGENT_NEWS_SENTIMENT_THRESHOLD: "0" }],
    ["non-increasing aggregate thresholds", { TWINS_AGENT_SENTIMENT_AGGREGATE_CAUTION: "0.6" }], ["a reliability above 1", { TWINS_AGENT_NEWS_MIN_RELIABILITY: "1.5" }], ["stale caution above the unavailable limit", { TWINS_AGENT_NEWS_STALE_CAUTION_MINUTES: "2000" }],
    ["a bad critical severity", { TWINS_AGENT_NEWS_CRITICAL_ADVERSE: "CAUTION" }], ["a zero top count", { TWINS_AGENT_CONSTITUENT_TOP_COUNT: "0" }], ["non-increasing constituent moves", { TWINS_AGENT_CONSTITUENT_MOVE_ADVERSE: "0.5" }],
    ["non-increasing impact thresholds", { TWINS_AGENT_CONSTITUENT_IMPACT_CAUTION: "2" }], ["a usable share above 1", { TWINS_AGENT_CONSTITUENT_MIN_USABLE_SHARE: "1.5" }], ["a lower-case index underlying", { TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS: "nifty" }],
    ["duplicate index underlyings", { TWINS_AGENT_CONSTITUENT_INDEX_UNDERLYINGS: "NIFTY,NIFTY" }], ["a bad quote market", { TWINS_AGENT_CONSTITUENT_QUOTE_MARKET: "n" }], ["a non-numeric value", { TWINS_AGENT_CONSTITUENT_MIN_WEIGHT: "heavy" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("worker wiring and source hygiene", () => {
  it("the worker resolves the Task 4 providers only when the engine is enabled", () => {
    const w = readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8");
    expect(w).toMatch(/\.\.\.resolveNewsConstituentProviders\(agentRules\)/);
  });
  it("the new agent and provider sources read no message text, import no network / broker / LLM code, read no system clock and write nothing", () => {
    for (const f of ["newsSentiment.ts", "indexConstituent.ts", "newsProviders.ts", "constituentProviders.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(|schema\./i);
    }
  });
});
