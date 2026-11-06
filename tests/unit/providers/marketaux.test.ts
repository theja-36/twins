import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNewsFile, parseSentimentFile } from "../../../packages/agents/src/index";
import {
  buildMarketauxNews, createQuotaGuard, FILES, mapEntitySymbol, marketauxNewsDocument, marketauxSentimentDocument, marketauxUrl, MarketauxDataError, MarketauxLimitError, ProviderFetchError, runProviders, type Fetcher, type RunContext,
} from "../../../packages/providers/src/index";

// Synthetic fixtures only: no real Marketaux response is used and no request is made.
const KEY = "abcdef0123456789abcdef0123456789";
const NOW = new Date("2026-11-06T10:00:00.000Z");
const UNIVERSE = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "SBIN"]);
const ent = (symbol: string, sentiment_score?: unknown) => ({ symbol, type: "equity", country: "in", ...(sentiment_score === undefined ? {} : { sentiment_score }) });
const art = (uuid: string, title: string, minutesAgo: number, entities: unknown[], extra: Record<string, unknown> = {}) => ({
  uuid, title, url: `https://news.example/${uuid}`, source: "news.example", published_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), entities, description: "SECRET-DESCRIPTION-TEXT", snippet: "SECRET-SNIPPET-TEXT", ...extra,
});
const page = (data: unknown[]) => JSON.stringify({ meta: { found: data.length, returned: data.length, limit: 3, page: 1 }, data });
const fetcherOf = (pages: string[], calls: string[] = []): Fetcher => async (url) => { calls.push(url); const p = pages[Math.min(calls.length - 1, pages.length - 1)]; if (p === undefined) throw new Error("no page"); return p; };
const quota = (cap = 60) => createQuotaGuard({ dailyCap: cap, now: () => NOW });
// a pass asks for two pages; a single fixture page is followed by an empty one
const build = (pages: string[], o: { calls?: string[]; cap?: number; maxRequests?: number } = {}) => buildMarketauxNews({ fetcher: fetcherOf(pages.length === 1 ? [...pages, page([])] : pages, o.calls), apiKey: KEY, universe: UNIVERSE, now: () => NOW, quota: quota(o.cap), ...(o.maxRequests ? { maxRequests: o.maxRequests } : {}) });

describe("symbol mapping", () => {
  it("maps .NS to NSE, .BO to BSE and the index tickers; anything outside the universe stays unmapped", () => {
    expect(mapEntitySymbol("RELIANCE.NS", UNIVERSE)).toEqual({ symbol: "RELIANCE", market: "NSE" });
    expect(mapEntitySymbol("SBIN.BO", UNIVERSE)).toEqual({ symbol: "SBIN", market: "BSE" });
    expect(mapEntitySymbol("^NSEI", UNIVERSE)).toEqual({ symbol: "NIFTY", market: "NSE" });
    expect(mapEntitySymbol("^NSEBANK", UNIVERSE)).toEqual({ symbol: "BANKNIFTY", market: "NSE" });
    expect(mapEntitySymbol("^BSESN", UNIVERSE)).toEqual({ symbol: "SENSEX", market: "BSE" });
    for (const bad of ["UNKNOWNCO.NS", "RELIANCE", "RELIANCE.NSE", "^CNXIT", "AAPL", "reliance.ns", "", null, 7]) expect(mapEntitySymbol(bad, UNIVERSE), String(bad)).toBe("unmapped");
  });
});

describe("entity-specific sentiment", () => {
  it("one item per (article, entity) with that entity's own score; different companies are never averaged together", async () => {
    const b = await build([page([art("a1", "Reliance up, HDFC Bank down", 30, [ent("RELIANCE.NS", 0.6), ent("HDFCBANK.NS", -0.4), ent("^NSEI", 0.05)])])]);
    const by = Object.fromEntries(b.items.map((i) => [`${(i["markets"] as string[])[0]}:${(i["symbols"] as string[])[0]}`, i]));
    expect(Object.keys(by).sort()).toEqual(["NSE:HDFCBANK", "NSE:NIFTY", "NSE:RELIANCE"]);
    expect(by["NSE:RELIANCE"]!["sentiment_score"]).toBe(0.6); expect(by["NSE:RELIANCE"]!["sentiment_label"]).toBe("POSITIVE");
    expect(by["NSE:HDFCBANK"]!["sentiment_score"]).toBe(-0.4); expect(by["NSE:HDFCBANK"]!["sentiment_label"]).toBe("NEGATIVE");
    expect(by["NSE:NIFTY"]!["sentiment_label"]).toBe("NEUTRAL"); // a real score near zero, not a missing one
    for (const i of b.items) expect((i["symbols"] as string[]).length).toBe(1);
  });
  it("a missing or invalid score is dropped (unavailable), never turned into NEUTRAL", async () => {
    const b = await build([page([art("a1", "No score", 30, [ent("RELIANCE.NS"), ent("SBIN.NS", null), ent("HDFCBANK.NS", "0.5"), ent("^NSEI", Number.NaN), ent("^NSEBANK", 1.5)])])]);
    expect(b.items).toEqual([]); expect(b.stats.noScore).toBe(5);
    expect(marketauxSentimentDocument(b).entries).toBe(0); // no entry at all for an entity without a scored article
  });
  it("unknown symbols are counted and dropped, not turned into instruments", async () => {
    const b = await build([page([art("a1", "Mystery", 30, [ent("UNKNOWNCO.NS", 0.9), ent("AAPL", 0.9), ent("^CNXIT", 0.9), ent("SBIN.NS", 0.3)])])]);
    expect(b.items.map((i) => (i["symbols"] as string[])[0])).toEqual(["SBIN"]); expect(b.stats.unmapped).toBe(3);
  });
  it("the sentiment file is a DERIVED per-entity mean: its own scores only, honest sample size, newest contributing time, labelled derived", async () => {
    const b = await build([page([
      art("a1", "Reliance one", 30, [ent("RELIANCE.NS", 0.8), ent("HDFCBANK.NS", -0.9)]),
      art("a2", "Reliance two", 90, [ent("RELIANCE.NS", 0.2)]),
      art("a3", "SBI", 10, [ent("SBIN.NS", 0.4)]),
    ])]);
    const s = marketauxSentimentDocument(b);
    const e = s.document["entries"] as Record<string, { score: number; label: string; sample_size: number; as_of: string }>;
    expect(e["NSE:RELIANCE"]).toEqual({ score: 0.5, label: "POSITIVE", sample_size: 2, as_of: new Date(NOW.getTime() - 30 * 60_000).toISOString() });
    expect(e["NSE:HDFCBANK"]!.score).toBe(-0.9); expect(e["NSE:HDFCBANK"]!.sample_size).toBe(1); // thin coverage is reported as 1, never inflated
    expect(e["NSE:SBIN"]!.sample_size).toBe(1);
    expect(s.document["source"]).toBe("marketaux-derived-entity-mean");
    expect(() => parseSentimentFile(JSON.parse(JSON.stringify(s.document)))).not.toThrow();
  });
});

describe("news file", () => {
  it("keeps provider fields, uses honest placeholders for the rest and stores no snippet or description; the agents' parser accepts it", async () => {
    const b = await build([page([art("a1", "Nifty ends flat", 20, [ent("^NSEI", 0.02)])])]);
    const doc = marketauxNewsDocument(b);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/SECRET-(DESCRIPTION|SNIPPET)-TEXT/);
    const it0 = b.items[0]!;
    expect(it0).toMatchObject({ source_label: "news.example", headline: "Nifty ends flat", symbols: ["NIFTY"], markets: ["NSE"], impact: "LOW", category: "unclassified", source_reliability: 0.4, published_at: new Date(NOW.getTime() - 20 * 60_000).toISOString() });
    expect(doc["source"]).toBe("marketaux");
    expect(() => parseNewsFile(JSON.parse(text))).not.toThrow();
  });
  it("an answer with no articles is a valid empty file; a different universe changes what is kept", async () => {
    expect((await build([page([])])).items).toEqual([]);
    const b = await buildMarketauxNews({ fetcher: fetcherOf([page([art("a1", "SBI", 5, [ent("SBIN.NS", 0.3)]), ]), page([])]), apiKey: KEY, universe: new Set(["NIFTY"]), now: () => NOW, quota: quota() });
    expect(b.items).toEqual([]); expect(b.stats.unmapped).toBe(1);
  });
});

describe("deduplication and freshness", () => {
  it("the same article on two pages, or the same headline syndicated under another id, is kept once", async () => {
    const a1 = art("a1", "Reliance wins order", 30, [ent("RELIANCE.NS", 0.5)]);
    const copy = art("a2", "RELIANCE  wins order!", 25, [ent("RELIANCE.NS", 0.5)]);
    const b = await build([page([a1]), page([a1, copy])]);
    expect(b.items.length).toBe(1); expect(b.stats.duplicates).toBe(2); expect(b.stats.requests).toBe(2);
    expect(new Set(b.items.map((i) => i["id"])).size).toBe(b.items.length);
  });
  it("stale and future articles are dropped; the window is 24 hours back, 5 minutes forward", async () => {
    const b = await build([page([
      art("old", "Old", 24 * 60 + 1, [ent("SBIN.NS", 0.3)]), art("edge", "Edge", 24 * 60 - 1, [ent("SBIN.NS", 0.3)]),
      art("soon", "Soon", -4, [ent("RELIANCE.NS", 0.3)]), art("future", "Future", -6, [ent("HDFCBANK.NS", 0.3)]),
    ])]);
    expect(b.items.map((i) => i["headline"]).sort()).toEqual(["Edge", "Soon"]); expect(b.stats.stale).toBe(1); expect(b.stats.future).toBe(1);
  });
  it("asks for India, English, newest first and an entity-tagged article only; the pass makes at most two requests", async () => {
    const calls: string[] = [];
    await build([page([])], { calls, maxRequests: 5 }).catch(() => undefined);
    const b = await build([page([])], { calls });
    expect(b.stats.requests).toBe(2);
    const u = new URL(calls[calls.length - 1]!);
    expect(u.hostname).toBe("api.marketaux.com");
    expect(Object.fromEntries(["countries", "language", "sort", "sort_order", "must_have_entities", "limit"].map((k) => [k, u.searchParams.get(k)]))).toEqual({ countries: "in", language: "en", sort: "published_at", sort_order: "desc", must_have_entities: "true", limit: "3" });
    expect(u.searchParams.get("published_after")).toBe("2026-11-05T10:00:00");
  });
});

describe("quota, rate limit and malformed answers", () => {
  it("the daily cap stops requests: none left at the start is a limit error, mid-pass it just ends the pass; it resets the next UTC day", async () => {
    await expect(build([page([])], { cap: 0 })).rejects.toMatchObject({ kind: "quota_exhausted" });
    const calls: string[] = [];
    const b = await build([page([])], { cap: 1, calls }); expect(b.stats.requests).toBe(1); expect(calls.length).toBe(1);
    let t = NOW; const g = createQuotaGuard({ dailyCap: 1, now: () => t });
    expect([g.take(), g.take()]).toEqual([true, false]); t = new Date("2026-11-07T00:00:01Z"); expect(g.take()).toBe(true);
  });
  it("HTTP 402 is quota exhausted and a rate-limited 429 is rate limited; both stop the pass at once", async () => {
    const f402: Fetcher = async () => { throw new ProviderFetchError("http_error", 402); };
    const f429: Fetcher = async () => { throw new ProviderFetchError("rate_limited", 429); };
    const run = (fetcher: Fetcher) => buildMarketauxNews({ fetcher, apiKey: KEY, universe: UNIVERSE, now: () => NOW, quota: quota() });
    await expect(run(f402)).rejects.toMatchObject({ kind: "quota_exhausted" });
    await expect(run(f429)).rejects.toBeInstanceOf(MarketauxLimitError);
    await expect(run(async () => { throw new ProviderFetchError("http_error", 500); })).rejects.toBeInstanceOf(ProviderFetchError); // other failures are not disguised
  });
  it("malformed answers are refused, never written as a valid-looking empty file", async () => {
    const bads = ["not json", "{}", JSON.stringify({ data: {} }), page([{ title: "no uuid", url: "u", source: "s", entities: [], published_at: NOW.toISOString() }]), page([art("a", "bad time", 5, [], { published_at: "yesterday" })]), page([art("a", "no offset", 5, [], { published_at: "2026-11-06T09:00:00" })]), page([art("a", "entities", 5, [], { entities: "x" })])];
    for (const body of bads) await expect(build([body]), body.slice(0, 40)).rejects.toBeInstanceOf(MarketauxDataError);
  });
  it("the key never appears in an error and a malformed key is refused without being echoed", () => {
    expect(() => marketauxUrl("short key!", { publishedAfter: NOW, page: 1 })).toThrow(/unexpected shape/);
    try { marketauxUrl("short key!", { publishedAfter: NOW, page: 1 }); } catch (e) { expect(String(e)).not.toContain("short key!"); }
    expect(marketauxUrl(KEY, { publishedAfter: NOW, page: 1 })).toMatch(/^https:\/\/api\.marketaux\.com\/v1\/news\/all\?/);
  });
});

describe("in the exporter run", () => {
  const dirs = () => { const d = mkdtempSync(join(tmpdir(), "mx-")); return { providersDir: join(d, "out"), snapshotDir: d }; };
  const fake = (responses: Array<() => Response>, seen: string[]): typeof fetch => (async (input: string) => { seen.push(String(input)); return responses[Math.min(seen.length - 1, responses.length - 1)]!(); }) as unknown as typeof fetch; // a fresh Response per call (a cloned body cannot be cancelled)
  const ok = (data: unknown[]) => () => new Response(page(data), { status: 200 });
  const ctx = (o: Partial<RunContext>): RunContext => ({ ...dirs(), now: () => NOW, sleep: async () => undefined, newsSource: "marketaux", marketauxApiKey: KEY, constituents: { csv: "RELIANCE,2,Energy\n", index: "NIFTY" }, ...o });

  it("publishes news and sentiment from ONE fetch (the sentiment file is derived, not a second request); both files pass the agents' parsers", async () => {
    const seen: string[] = [];
    const c = ctx({ fetchFn: fake([ok([art("a1", "Reliance gains", 15, [ent("RELIANCE.NS", 0.5)])])], seen) });
    const r = await runProviders(["news", "sentiment"], c);
    expect(r.map((x) => `${x.provider}:${x.status}`)).toEqual(["news:published", "sentiment:published"]);
    expect(seen.length).toBe(2); // two pages for the one pass, shared by both providers
    expect(() => parseNewsFile(JSON.parse(readFileSync(join(c.providersDir, FILES.news), "utf8")))).not.toThrow();
    expect(() => parseSentimentFile(JSON.parse(readFileSync(join(c.providersDir, FILES.sentiment), "utf8")))).not.toThrow();
    expect(seen.every((u) => new URL(u).hostname === "api.marketaux.com")).toBe(true);
  });
  it("the universe is the configured constituents plus the three indices: a stock outside it is not published", async () => {
    const c = ctx({ fetchFn: fake([ok([art("a1", "Two names", 15, [ent("RELIANCE.NS", 0.5), ent("SBIN.NS", 0.5), ent("^NSEI", 0.1)])])], []) });
    await runProviders(["news"], c);
    const doc = JSON.parse(readFileSync(join(c.providersDir, FILES.news), "utf8")) as { items: Array<{ symbols: string[] }> };
    expect(doc.items.map((i) => i.symbols[0]!).sort()).toEqual(["NIFTY", "RELIANCE"]);
  });
  it("429 fails news with a fixed reason, skips sentiment, and stops asking", async () => {
    const seen: string[] = [];
    const c = ctx({ fetchFn: fake([() => new Response("slow down", { status: 429, headers: { "retry-after": "600" } })], seen) });
    const r = await runProviders(["news", "sentiment"], c);
    expect(r.map((x) => (x.status === "published" ? "published" : `${x.status}:${x.reason}`))).toEqual(["failed:rate_limited", "failed:provider_rate_limited"]);
    expect(seen.length).toBe(1); expect(existsSync(join(c.providersDir, FILES.news))).toBe(false);
  });
  it("a malformed answer fails with a fixed reason and writes no file; a missing key skips", async () => {
    const c = ctx({ fetchFn: fake([() => new Response("{}", { status: 200 })], []) });
    const r = await runProviders(["news"], c);
    expect(r[0]).toMatchObject({ status: "failed", reason: "response_invalid" }); expect(existsSync(join(c.providersDir, FILES.news))).toBe(false);
    const noKey = ctx({ fetchFn: fake([ok([])], []), marketauxApiKey: undefined as never });
    expect((await runProviders(["news", "sentiment"], noKey)).map((x) => (x.status === "skipped" ? x.reason : x.status))).toEqual(["key_missing", "key_missing"]);
  });
  it("the daily cap is shared across passes through the quota guard; the default source stays GDELT", async () => {
    const q = createQuotaGuard({ dailyCap: 2, now: () => NOW }); const seen: string[] = [];
    const c = ctx({ marketauxQuota: q, fetchFn: fake([ok([])], seen) });
    await runProviders(["news"], c);
    const r = await runProviders(["news"], { ...c, providersDir: join(mkdtempSync(join(tmpdir(), "mx2-")), "out") });
    expect(r[0]).toMatchObject({ status: "failed", reason: "quota_exhausted" }); expect(seen.length).toBe(2);
    const gd: string[] = []; const g = ctx({ newsSource: undefined as never, fetchFn: fake([() => new Response("{}", { status: 200 })], gd) });
    await runProviders(["news"], g); expect(gd.every((u) => new URL(u).hostname === "api.gdeltproject.org")).toBe(true);
  });
});
