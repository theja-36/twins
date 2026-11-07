import { describe, expect, it } from "vitest";
import { analyzeTelegramText } from "../../../packages/signals/src/index";
import {
  buildChannelNewsFile, ChannelNewsFormatError, channelItemsToEvents, clusterChannelNews, combinedNewsImpact, dedupeChannelNews, extractChannelNews, parseChannelNewsFile,
  type ChannelMessage, type ChannelNewsItem, type MessageClassifier,
} from "../../../packages/agents/src/channelNews";
import type { NewsEvent } from "../../../packages/agents/src/newsImpact";

const NOW = new Date("2031-03-03T10:00:00Z");
const classify: MessageClassifier = (t) => { const a = analyzeTelegramText(t); return a.kind === "none" ? (a.reason === "result_report" ? "result_report" : "none") : "signal_or_claim"; };
const ctx = { symbols: new Set(["RELIANCE", "TCS", "NIFTY", "HDFCBANK"]), classify };
const msg = (id: string, text: string, minAgo = 10): ChannelMessage => ({ id, channel: "***2544", at: new Date(NOW.getTime() - minAgo * 60_000), text });
const item = (id: string, o: Partial<ChannelNewsItem> = {}): ChannelNewsItem => ({ id, channel: "***2544", publishedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), symbols: ["RELIANCE"], themes: [], polarity: -0.8, reliability: 0.3, ...o });

describe("extractChannelNews (structured fields only)", () => {
  it("extracts symbols, themes and polarity and copies no sentence", () => {
    const r = extractChannelNews(msg("1", "RELIANCE shares FALL after SEBI probe, crude PRICES weak"), ctx);
    if (!("item" in r)) throw new Error("expected an item");
    expect(r.item).toMatchObject({ symbols: ["RELIANCE"], themes: expect.arrayContaining(["regulation"]), reliability: 0.3 });
    expect(r.item.polarity).toBeLessThan(0);
    expect(JSON.stringify(r.item)).not.toMatch(/shares|after|weak/i);
  });
  it("polarity: positive, negative, balanced, none", () => {
    const pol = (t: string) => { const r = extractChannelNews(msg("p", t), ctx); return "item" in r ? r.item.polarity : null; };
    expect(pol("TCS RALLY on strong growth and BUYBACK")).toBe(1);
    expect(pol("TCS falls on weak guidance cut")).toBe(-1);
    expect(pol("TCS RALLY but HDFCBANK DROP")).toBe(0);
    expect(pol("TCS to announce dividend")).toBeGreaterThan(0);
    expect(pol("TCS board meeting today")).toBe(0);
  });
  it("skips signals, claims, result reports, empty and irrelevant messages with a reason", () => {
    const why = (t: string) => { const r = extractChannelNews(msg("s", t), ctx); return "skipped" in r ? r.skipped : "item"; };
    expect(why("BUY RELIANCE @ 2800 SL 2750 TGT 2900")).toBe("signal_or_claim");
    expect(why("BUY NIFTY 24500 CE ABOVE 120 SL 90 TGT 150")).toBe("signal_or_claim");
    expect(why("120 - 190 HIT IN NIFTY CALL\n\nALL TARGET ACHIEVED\n\nGAINING RS 5,000")).toBe("result_report");
    expect(why("   ")).toBe("empty");
    expect(why("good morning everyone have a nice day")).toBe("no_symbols_or_themes");
  });
  it("matches symbols only from the instrument reference and respects the configured reliability, clamped to [0,1]", () => {
    const r = extractChannelNews(msg("r", "XYZCORP and TCS in focus today"), { ...ctx, reliability: 5 });
    if (!("item" in r)) throw new Error("item");
    expect(r.item.symbols).toEqual(["TCS"]);
    expect(r.item.reliability).toBe(1);
  });
});

describe("dedupe and clustering", () => {
  it("collapses near-duplicates from the same channel and keeps distinct ones", () => {
    const base = Date.parse("2031-03-03T09:00:00Z");
    const at = (m: number) => new Date(base + m * 60_000).toISOString();
    const out = dedupeChannelNews([item("a", { publishedAt: at(0) }), item("b", { publishedAt: at(10) }), item("c", { publishedAt: at(25) }), item("d", { publishedAt: at(90) }), item("e", { publishedAt: at(5), polarity: 0.9 }), item("f", { publishedAt: at(1), channel: "***2041" })]);
    const a = out.find((o) => o.id === "a");
    expect(a?.duplicates).toBe(2);
    expect(out.map((o) => o.id).sort()).toEqual(["a", "d", "e", "f"]);
  });
  it("clusters by symbol, theme and 2-hour window, counts channels and flags mixed views", () => {
    const t = (m: number) => new Date(Date.parse("2031-03-03T08:10:00Z") + m * 60_000).toISOString();
    const cl = clusterChannelNews([item("1", { publishedAt: t(0), polarity: -0.9 }), item("2", { publishedAt: t(10), polarity: 0.8, channel: "***2041" }), item("3", { publishedAt: t(200), polarity: -0.9 })]);
    const first = cl.find((c) => c.symbol === "RELIANCE" && c.bucketStart === "2031-03-03T08:00:00.000Z");
    expect(first).toMatchObject({ items: 2, channels: 2, mixed: true });
    expect(cl.filter((c) => c.symbol === "RELIANCE")).toHaveLength(2);
    expect(clusterChannelNews([])).toEqual([]);
  });
});

describe("combined impact (corroboration, channel-only cap, asymmetry)", () => {
  const api = (id: string, minAgo: number, s: number): NewsEvent => ({ id, publishedAt: new Date(NOW.getTime() - minAgo * 60_000).toISOString(), sentiment: s, relevance: 0.9, reliability: 0.8, symbols: ["RELIANCE"], themes: [] });
  const T = { symbol: "RELIANCE" };
  it("API and channel agreeing is corroborated", () => {
    const r = combinedNewsImpact([api("a1", 10, -0.9), api("a2", 20, -0.8), api("a3", 30, -0.9)], [item("c1"), item("c2", { publishedAt: new Date(NOW.getTime() - 15 * 60_000).toISOString() })], T, NOW);
    expect(r.corroboration).toBe("API_AND_CHANNEL");
    expect(r.impact.direction).toBe("NEGATIVE");
  });
  it("channel-only evidence never escalates beyond CAUTION, even in a burst", () => {
    const burst = Array.from({ length: 12 }, (_, i) => item(`b${i}`, { publishedAt: new Date(NOW.getTime() - (5 + i * 2) * 60_000).toISOString(), reliability: 1 }));
    const r = combinedNewsImpact([], burst, T, NOW);
    expect(r.corroboration).toBe("CHANNEL_ONLY");
    expect(["NONE", "CAUTION"]).toContain(r.impact.recommendation);
  });
  it("positive channel news recommends nothing; no inputs is NONE/UNKNOWN", () => {
    const r = combinedNewsImpact([], [item("p", { polarity: 1 }), item("q", { polarity: 1, publishedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() })], T, NOW);
    expect(r.impact.recommendation).toBe("NONE");
    const none = combinedNewsImpact([], [], T, NOW);
    expect(none.corroboration).toBe("NONE");
    expect(none.impact.direction).toBe("UNKNOWN");
  });
  it("conversion keeps channel reliability and fixed relevance", () => {
    expect(channelItemsToEvents([item("x", { reliability: 0.3 })])[0]).toMatchObject({ reliability: 0.3, relevance: 0.5, sentiment: -0.8 });
  });
});

describe("twins-channel-news-v1 file", () => {
  it("round-trips and carries structured fields only", () => {
    const items = [item("1"), item("2", { themes: ["oil", "rates"], symbols: [] })];
    const file = buildChannelNewsFile(items, NOW);
    expect(parseChannelNewsFile(JSON.parse(JSON.stringify(file)))).toEqual(items);
    expect(Object.keys((file["items"] as Array<Record<string, unknown>>)[0] as object).sort()).toEqual(["channel", "id", "polarity", "published_at", "reliability", "symbols", "themes"]);
  });
  it("rejects malformed files instead of repairing them", () => {
    const good = JSON.parse(JSON.stringify(buildChannelNewsFile([item("1")], NOW)));
    const mutate = (f: (x: Record<string, any>) => void) => { const c = JSON.parse(JSON.stringify(good)); f(c); return c; };
    for (const bad of [null, [], { ...good, format: "x" }, mutate((c) => { c.as_of = "nope"; }), mutate((c) => { c.items[0].themes = ["free text"]; }), mutate((c) => { c.items[0].polarity = 2; }), mutate((c) => { c.items[0].symbols = ["lower"]; }), mutate((c) => { c.items.push({ ...c.items[0] }); }), mutate((c) => { c.items[0].channel = "has/slash"; })]) {
      expect(() => parseChannelNewsFile(bad)).toThrow(ChannelNewsFormatError);
    }
  });
});
