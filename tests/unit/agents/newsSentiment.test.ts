import { describe, expect, it } from "vitest";
import { newsSentimentAgent, NEWS_SENTIMENT_AGENT_ID, type AgentRulesConfig, type NewsProvider, type SentimentProvider } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, NOW } from "../../support/agentFixtures";
import { at } from "../../support/calendarMacroFixtures";
import { aggregate, newsFeed, newsItem, rulesWithNews, sentimentFeed } from "../../support/newsConstituentFixtures";

const run = async (inp: Record<string, unknown> = inputs(), o: { rules?: AgentRulesConfig; news?: NewsProvider | null; sentiment?: SentimentProvider | null } = {}) =>
  (await evalAgents([newsSentimentAgent(o.rules ?? rulesWithNews(), o.news === undefined ? newsFeed() : o.news, o.sentiment === undefined ? null : o.sentiment)], inp, {}, [], NOW)).byId(NEWS_SENTIMENT_AGENT_ID);
const SELL = () => inputs({ rd: { side: "SELL", stopLoss: 105, targets: [95, 90] }, sf: { side: "SELL" } });
const neg = (o: Parameters<typeof newsItem>[0] = {}) => newsItem({ sentimentLabel: "NEGATIVE", sentimentScore: -0.7, ...o });

describe("News / Sentiment Agent: verdicts", () => {
  it("supportive news (medium impact, aligned, fresh feed) = SUPPORTIVE with item evidence", async () => {
    const item = newsItem({ impact: "HIGH" });
    const r = await run(inputs(), { news: newsFeed([item]) });
    expect(r).toMatchObject({ agentId: "news-sentiment-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(codesOf(r)).toContain("SUPPORTIVE_NEWS");
    expect(r.outputSnapshot).toMatchObject({ direction: "BULLISH", provider: "synthetic-news", itemsConsidered: 1, supportiveItems: 1, adverseItems: 0, feedAgeMinutes: 5, sourceIntelligenceStatus: "VALID" });
    expect(r.evidence.map((e) => e.ref)).toContain(`news_item:${item.id}`);
  });
  it("no news = NEUTRAL (a fresh feed with nothing relevant is not support)", async () => {
    const r = await run();
    expect(r).toMatchObject({ verdict: "NEUTRAL", confidence: 70 }); expect(codesOf(r)).toContain("NO_RECENT_NEWS");
  });
  it("neutral and low-impact items = NEUTRAL", async () => {
    const r = await run(inputs(), { news: newsFeed([newsItem({ sentimentLabel: "NEUTRAL", sentimentScore: 0 }), newsItem({ impact: "LOW" })]) });
    expect(r.verdict).toBe("NEUTRAL");
  });
  it.each<[string, Parameters<typeof neg>[0], string, string]>([
    ["a critical adverse item inside the near-term window", { impact: "CRITICAL", minutesAgo: 30 }, "BLOCKING", "CRITICAL_ADVERSE_NEWS_NEAR_TERM"],
    ["a critical adverse item older than the near-term window", { impact: "CRITICAL", minutesAgo: 600 }, "ADVERSE", "CRITICAL_ADVERSE_NEWS"],
    ["a high-impact adverse item", { impact: "HIGH" }, "ADVERSE", "HIGH_IMPACT_ADVERSE_NEWS"],
    ["a medium-impact adverse item", { impact: "MEDIUM" }, "CAUTION", "ADVERSE_NEWS"],
    ["a low-impact adverse item", { impact: "LOW" }, "NEUTRAL", "MINOR_ADVERSE_NEWS"],
    ["a critical adverse item from an unreliable source (downgraded one level)", { impact: "CRITICAL", minutesAgo: 30, sourceReliability: 0.2 }, "ADVERSE", "CRITICAL_ADVERSE_NEWS_NEAR_TERM"],
    ["a market-wide adverse item", { impact: "HIGH", symbols: ["*"] }, "ADVERSE", "HIGH_IMPACT_ADVERSE_NEWS"],
    ["an adverse item for ALL markets", { impact: "HIGH", markets: ["ALL"] }, "ADVERSE", "HIGH_IMPACT_ADVERSE_NEWS"],
  ])("%s => %s", async (_n, over, verdict, code) => {
    const r = await run(inputs(), { news: newsFeed([neg(over)]) });
    expect(r.verdict).toBe(verdict); expect(codesOf(r)).toContain(code);
  });
  it("the same negative item is SUPPORTIVE for a SELL signal; sentiment is judged against the derived direction (BUY PE = bearish)", async () => {
    const item = neg({ impact: "HIGH" });
    expect((await run(SELL(), { news: newsFeed([item]) })).verdict).toBe("SUPPORTIVE");
    const pe = await run(optionInputs({ rd: { symbol: "ACME", optionType: "PE" } }), { news: newsFeed([item]) });
    expect(pe.verdict).toBe("SUPPORTIVE"); expect(pe.outputSnapshot["direction"]).toBe("BEARISH");
  });
  it("conflicting news: medium items on both sides = CAUTION; high items on both sides = ADVERSE (not supportive)", async () => {
    const mild = await run(inputs(), { news: newsFeed([neg({ impact: "MEDIUM" }), newsItem({ impact: "MEDIUM" })]) });
    expect(mild.verdict).toBe("CAUTION"); expect(codesOf(mild)).toContain("CONFLICTING_NEWS");
    const strong = await run(inputs(), { news: newsFeed([neg({ impact: "HIGH", minutesAgo: 300 }), newsItem({ impact: "HIGH" })]) });
    expect(strong.verdict).toBe("ADVERSE"); expect(codesOf(strong)).toContain("CONFLICTING_NEWS");
  });
  it("high-impact news with no clear direction in the near term = CAUTION; a MIXED item is not a direction", async () => {
    const r = await run(inputs(), { news: newsFeed([newsItem({ impact: "HIGH", sentimentLabel: "MIXED", sentimentScore: null })]) });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("HIGH_IMPACT_NEWS_DIRECTION_UNCLEAR");
  });
  it("label-only items (no score) use the label; a mild score under the threshold is neutral", async () => {
    expect((await run(inputs(), { news: newsFeed([newsItem({ sentimentLabel: "NEGATIVE", sentimentScore: null, impact: "HIGH" })]) })).verdict).toBe("ADVERSE");
    expect((await run(inputs(), { news: newsFeed([newsItem({ sentimentLabel: "NEGATIVE", sentimentScore: -0.1, impact: "MEDIUM" })]) })).verdict).toBe("NEUTRAL");
  });
});

describe("News / Sentiment Agent: relevance, duplicates, staleness", () => {
  it("items for other underlyings or markets, outside the lookback or in the future are not assessed", async () => {
    const all = [neg({ impact: "CRITICAL", symbols: ["OTHER"] }), neg({ impact: "CRITICAL", markets: ["LSE"] }), neg({ impact: "CRITICAL", minutesAgo: 3000 }), neg({ impact: "CRITICAL", minutesAgo: -60 })];
    const r = await run(inputs(), { news: { name: "unfiltered", asOf: at(-5), items: async () => all } }); // a provider that ignores the query: the agent still filters
    expect(r.verdict).toBe("CAUTION"); // only the future-dated item is flagged
    expect(codesOf(r)).toEqual(expect.arrayContaining(["NEWS_FUTURE_DATED", "NO_RECENT_NEWS"])); expect(r.outputSnapshot["itemsConsidered"]).toBe(0);
  });
  it("duplicate news (same id, or same source and headline) counts once", async () => {
    const a = neg({ impact: "HIGH", id: "dup-1", headline: "Same Headline!" });
    const dupId = { ...a, headline: "Different words" }, dupText = { ...a, id: "dup-2", headline: "same headline" };
    const r = await run(inputs(), { news: newsFeed([a, dupId, dupText]) });
    expect(r.outputSnapshot).toMatchObject({ itemsConsidered: 1, duplicatesIgnored: 2, adverseItems: 1 });
    expect(codesOf(r)).toContain("DUPLICATE_NEWS_IGNORED");
    expect(r.findings.filter((f) => f.code === "HIGH_IMPACT_ADVERSE_NEWS")).toHaveLength(1);
  });
  it("stale feed = CAUTION; too old = UNAVAILABLE; undated = CAUTION; future-dated = UNAVAILABLE", async () => {
    const stale = await run(inputs(), { news: newsFeed([], { asOf: at(-300) }) });
    expect(stale.verdict).toBe("CAUTION"); expect(codesOf(stale)).toContain("NEWS_FEED_STALE");
    expect(await run(inputs(), { news: newsFeed([], { asOf: at(-3000) }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "NEWS_FEED_TOO_OLD" });
    expect(codesOf(await run(inputs(), { news: newsFeed([], { asOf: null }) }))).toContain("NEWS_FEED_AS_OF_UNKNOWN");
    expect(await run(inputs(), { news: newsFeed([], { asOf: at(90) }) })).toMatchObject({ status: "UNAVAILABLE", errorCode: "NEWS_FEED_FROM_FUTURE" });
  });
  it("the lookback, near-term window, thresholds and the critical severity are configurable", async () => {
    const item = neg({ impact: "CRITICAL", minutesAgo: 30 });
    expect((await run(inputs(), { news: newsFeed([item]), rules: rulesWithNews({ news: { criticalAdverse: "ADVERSE" } }) })).verdict).toBe("ADVERSE");
    expect((await run(inputs(), { news: newsFeed([item]), rules: rulesWithNews({ news: { nearTermMinutes: 10 } }) })).verdict).toBe("ADVERSE");
    expect((await run(inputs(), { news: newsFeed([item]), rules: rulesWithNews({ news: { lookbackMinutes: 20, nearTermMinutes: 10 } }) })).verdict).toBe("NEUTRAL");
    expect((await run(inputs(), { news: newsFeed([neg({ impact: "HIGH", sentimentScore: -0.4 })]), rules: rulesWithNews({ news: { sentimentThreshold: 0.5 } }) })).verdict).toBe("CAUTION"); // below the threshold the item has no direction, and a near-term high-impact item with no direction is a caution
    expect((await run(inputs(), { news: newsFeed([neg({ impact: "HIGH", sourceReliability: 0.6 })]), rules: rulesWithNews({ news: { minReliability: 0.7 } }) })).verdict).toBe("CAUTION");
  });
  it("more relevant items than the limit are truncated (CAUTION)", async () => {
    const r = await run(inputs(), { news: newsFeed([newsItem(), newsItem(), newsItem()]), rules: rulesWithNews({ news: { maxItems: 2 } }) });
    expect(codesOf(r)).toContain("NEWS_TRUNCATED"); expect(r.outputSnapshot["itemsConsidered"]).toBe(2);
  });
});

describe("News / Sentiment Agent: aggregate sentiment", () => {
  const sent = (s: ReturnType<typeof aggregate>) => sentimentFeed({ "NSE:ACME": s });
  it.each<[string, ReturnType<typeof aggregate>, string, string]>([
    ["strongly against with enough samples", aggregate(-0.7), "ADVERSE", "AGGREGATE_SENTIMENT_AGAINST"],
    ["strongly against with too few samples", aggregate(-0.7, { sampleSize: 2 }), "CAUTION", "AGGREGATE_SENTIMENT_AGAINST_LOW_SAMPLE"],
    ["leaning against", aggregate(-0.3), "CAUTION", "AGGREGATE_SENTIMENT_LEANS_AGAINST"],
    ["stale", aggregate(-0.9, { asOf: at(-600) }), "CAUTION", "SENTIMENT_STALE"],
    ["supportive", aggregate(0.5), "SUPPORTIVE", "AGGREGATE_SENTIMENT_SUPPORTIVE"],
    ["flat", aggregate(0.05), "NEUTRAL", "NO_RECENT_NEWS"],
  ])("aggregate %s => %s", async (_n, s, verdict, code) => {
    const r = await run(inputs(), { sentiment: sent(s) });
    expect(r.verdict).toBe(verdict); expect(codesOf(r)).toContain(code);
  });
  it("no aggregate for the underlying / no sentiment provider are noted (INFO); a throwing or malformed provider is UNAVAILABLE", async () => {
    expect(codesOf(await run(inputs(), { sentiment: sentimentFeed() }))).toContain("AGGREGATE_SENTIMENT_MISSING");
    expect(codesOf(await run())).toContain("SENTIMENT_PROVIDER_NOT_CONFIGURED");
    expect(await run(inputs(), { sentiment: { name: "x", sentiment: async () => { throw new Error("SECRET-DETAIL"); } } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "SENTIMENT_PROVIDER_UNAVAILABLE" });
    expect(await run(inputs(), { sentiment: { name: "x", sentiment: async () => ({ score: 5, label: "POSITIVE", sampleSize: 1, asOf: at(-1) }) } })).toMatchObject({ status: "UNAVAILABLE", errorCode: "SENTIMENT_DATA_MALFORMED" });
  });
});

describe("News / Sentiment Agent: no provider / no data => UNAVAILABLE, never a pass", () => {
  it.each<[string, Parameters<typeof run>[1], string]>([
    ["no news provider", { news: null }, "NEWS_PROVIDER_NOT_CONFIGURED"],
    ["a provider that throws", { news: { name: "x", asOf: null, items: async () => { throw new Error("connection refused SECRET-DETAIL"); } } }, "NEWS_PROVIDER_UNAVAILABLE"],
    ["a non-list result", { news: { name: "x", asOf: null, items: async () => ({}) as never } }, "NEWS_DATA_MALFORMED"],
    ["an item without an impact", { news: newsFeed([{ ...newsItem(), impact: undefined }]) }, "NEWS_DATA_MALFORMED"],
    ["an item time without an offset", { news: newsFeed([{ ...newsItem(), publishedAt: "2025-01-06T09:00:00" }]) }, "NEWS_DATA_MALFORMED"],
    ["an out-of-range sentiment score", { news: newsFeed([{ ...newsItem(), sentimentScore: 3 }]) }, "NEWS_DATA_MALFORMED"],
    ["an unsafe reference", { news: newsFeed([{ ...newsItem(), reference: "javascript:alert(1)" }]) }, "NEWS_DATA_MALFORMED"],
    ["an unknown sentiment label", { news: newsFeed([{ ...newsItem(), sentimentLabel: "ECSTATIC" }]) }, "NEWS_DATA_MALFORMED"],
    ["a non-object item", { news: newsFeed(["garbage"]) }, "NEWS_DATA_MALFORMED"],
  ])("%s", async (_n, o, code) => {
    const r = await run(inputs(), o);
    expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: code, findings: [] });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
  });
  it("a missing market or underlying is UNAVAILABLE; an unknown direction is a CAUTION", async () => {
    expect(await run(inputs({ rd: { market: null } }))).toMatchObject({ status: "UNAVAILABLE", errorCode: "MISSING_CONTEXT" });
    const r = await run(inputs({ rd: { side: "HOLD" } }), { news: newsFeed([neg({ impact: "CRITICAL" })]) });
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toContain("DIRECTION_UNKNOWN");
  });
});

describe("News / Sentiment Agent: language, determinism, privacy", () => {
  it("findings are evidence-only (no headline text, no causal language) and the contract is valid", async () => {
    const r = await run(inputs(), { news: newsFeed([neg({ impact: "HIGH", headline: "Totally secret headline content" }), neg({ impact: "MEDIUM" })]), sentiment: sentimentFeed({ "NSE:ACME": aggregate(-0.6) }) });
    const text = JSON.stringify([r.findings, r.outputSnapshot, r.evidence]);
    expect(text).not.toContain("Totally secret"); expect(text).not.toMatch(/\b(because|caused|due to|driven by|will|expect|predict|should)\b/i);
    expect(newsSentimentAgent(rulesWithNews(), null, null).contract).toMatchObject({ agentId: "news-sentiment-v1", canBlock: true, advisoryOnly: false, dependsOn: [], weight: 50, requiredInputs: ["risk_decision"] });
  });
  it("is deterministic and never reads message text", async () => {
    const a = await run(inputs(), { news: newsFeed([neg({ impact: "HIGH" })]) }), b = await run(inputs(), { news: newsFeed([neg({ impact: "HIGH" })]) });
    expect(a.verdict).toBe(b.verdict);
    expect(JSON.stringify([a.inputSnapshot, a.outputSnapshot])).not.toMatch(/rawText|raw_text|telegram/i);
  });
});
