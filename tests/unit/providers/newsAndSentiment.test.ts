import { describe, expect, it } from "vitest";
import { parseNewsFile, parseSentimentFile } from "../../../packages/agents/src/index";
import { buildNews, buildSentiment, DEFAULT_WATCH, labelOf, ProviderFetchError, watchQuery, type Fetcher } from "../../../packages/providers/src/index";

const NOW = new Date("2026-11-05T09:00:00.000Z");
const art = (title: string, url: string, seen = "20261105T081500Z", domain = "economictimes.indiatimes.com") => ({ url, url_mobile: "", title, seendate: seen, socialimage: "", domain, language: "English", sourcecountry: "India" });
const transport = (articles: unknown[] | "empty" | "bad") => async () => ({ status: 200, bodyText: articles === "empty" ? '{"articles":[]}' : articles === "bad" ? "<html>" : JSON.stringify({ articles }) });

describe("news from GDELT", () => {
  it("writes a file the agents' strict parser accepts, tags symbols by keyword, and dedupes", async () => {
    const b = await buildNews({ now: () => NOW, transport: transport([art("Nifty 50 ends higher as banks rally", "https://x.example/a"), art("Sensex slips on global cues", "https://x.example/b"), art("RBI keeps rates unchanged", "https://x.example/c"), art("Nifty 50 ends higher as banks rally", "https://x.example/a")]) });
    expect(b.items).toBe(3); expect(b.tagged).toBe(2);
    const items = (b.document["items"] as Array<Record<string, unknown>>);
    expect(items.find((i) => String(i["headline"]).startsWith("Nifty"))).toMatchObject({ symbols: ["NIFTY"], markets: ["NSE"] });
    expect(items.find((i) => String(i["headline"]).startsWith("Sensex"))).toMatchObject({ symbols: ["SENSEX"], markets: ["BSE"] });
    expect(items.find((i) => String(i["headline"]).startsWith("RBI"))).toMatchObject({ symbols: ["*"], markets: ["ALL"] });
    expect(() => parseNewsFile(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
  });
  it("claims nothing it does not know: neutral, no score, LOW impact, unclassified, low reliability", async () => {
    const b = await buildNews({ now: () => NOW, transport: transport([art("Nifty rallies", "https://x.example/a")]) });
    expect((b.document["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({ sentiment_label: "NEUTRAL", impact: "LOW", category: "unclassified", source_reliability: 0.3 });
    expect((b.document["items"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("sentiment_score");
  });
  it("an empty result is a valid empty file; a malformed answer is an error, not an empty file", async () => {
    const e = await buildNews({ now: () => NOW, transport: transport("empty") }); expect(e.items).toBe(0); expect(() => parseNewsFile(JSON.parse(JSON.stringify(e.document)))).not.toThrow();
    await expect(buildNews({ now: () => NOW, transport: transport("bad") })).rejects.toThrow();
  });
  it("builds one explicit query from the watch list", () => {
    expect(watchQuery(DEFAULT_WATCH)).toBe('("nifty 50" OR nifty OR "bank nifty" OR banknifty OR sensex) sourcecountry:india');
  });
});

describe("sentiment from GDELT's aggregate tone", () => {
  const series = (values: number[]) => JSON.stringify({ timeline: [{ series: "x", data: values.map((value, i) => ({ date: `2026110${i}T000000Z`, value })) }] });
  const fetcherOf = (tone: number[] | null, vol: number[] | null): Fetcher => async (u) => { const body = u.includes("mode=timelinetone") ? (tone ? series(tone) : "{}") : (vol ? series(vol) : "{}"); return body; };
  it("turns average tone into a bounded score with the article count as sample size, and the parser accepts it", async () => {
    const b = await buildSentiment({ now: () => NOW, fetcher: fetcherOf([-4, -6, -5], [10, 20, 12]), watch: DEFAULT_WATCH.slice(0, 1) });
    expect(b.entries).toBe(1);
    expect((b.document["entries"] as Record<string, unknown>)["NSE:NIFTY"]).toMatchObject({ score: -0.5, label: "NEGATIVE", sample_size: 42 });
    expect(() => parseSentimentFile(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
  });
  it("clamps extreme tone, and thresholds the label", async () => {
    const b = await buildSentiment({ now: () => NOW, fetcher: fetcherOf([30], [5]), watch: DEFAULT_WATCH.slice(0, 1) });
    expect((b.document["entries"] as Record<string, { score: number; label: string }>)["NSE:NIFTY"]).toMatchObject({ score: 1, label: "POSITIVE" });
    expect([labelOf(0.14), labelOf(-0.14), labelOf(0.15), labelOf(-0.15)]).toEqual(["NEUTRAL", "NEUTRAL", "POSITIVE", "NEGATIVE"]);
  });
  it("no data is NOT neutral: the entry is absent and reported", async () => {
    const b = await buildSentiment({ now: () => NOW, fetcher: fetcherOf(null, null), watch: DEFAULT_WATCH });
    expect(b.entries).toBe(0); expect(b.skipped).toEqual(["NIFTY", "BANKNIFTY", "SENSEX"]); expect(b.errorCodes).toEqual([]); // no data is not an error
    expect((await buildSentiment({ now: () => NOW, fetcher: fetcherOf(null, null) })).skipped).toEqual(["NIFTY"]); // by default only the index-level entry is requested
  });
  it("a failing request skips only that symbol", async () => {
    const f: Fetcher = async (u) => { if (u.includes("sensex")) throw new Error("x"); return u.includes("mode=timelinetone") ? series([2]) : series([4]); };
    const b = await buildSentiment({ now: () => NOW, fetcher: f, watch: DEFAULT_WATCH });
    expect(Object.keys(b.document["entries"] as object).sort()).toEqual(["NSE:BANKNIFTY", "NSE:NIFTY"]); expect(b.skipped).toEqual(["SENSEX"]);
  });
});

describe("sentiment rate limiting", () => {
  it("stops asking after the first rate limit and reports the code, so one pass never hammers the provider", async () => {
    let calls = 0; const f: Fetcher = async () => { calls += 1; throw new ProviderFetchError("rate_limited", 429); };
    const b = await buildSentiment({ now: () => NOW, fetcher: f, watch: DEFAULT_WATCH });
    expect(calls).toBe(1); expect(b.errorCodes).toEqual(["rate_limited_429"]); expect(b.entries).toBe(0);
  });
});
