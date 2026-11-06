import { describe, expect, it } from "vitest";
import { parseConstituentsFile, parseEconomicCalendar, parseHolidayCalendar, parseMacroContext, parseQuotesFile } from "../../../packages/agents/src/index";
import { buildConstituents, buildEconomicCalendar, buildHolidayCalendar, buildMacro, buildMarketQuotes, ConstituentsCsvError, createFredClient, easternInstant, FOMC_DECISION_DATES, HolidayCsvError, indexContexts, sessionStatus, type Fetcher } from "../../../packages/providers/src/index";

const KEY = "abcdef0123456789abcdef0123456789";
const NOW = new Date("2026-11-05T09:00:00.000Z"); // 14:30 IST on a Thursday
const fredFetcher = (routes: Record<string, unknown>): { fetcher: Fetcher; urls: string[] } => { const urls: string[] = []; return { urls, fetcher: async (u) => { urls.push(u); const hit = Object.entries(routes).find(([k]) => u.includes(k)); if (!hit) throw new Error("no route"); return JSON.stringify(hit[1]); } }; };

describe("FRED client", () => {
  it("refuses a key of the wrong shape without echoing it", () => { expect(() => createFredClient({ apiKey: "short key!", fetcher: async () => "" })).toThrow(/unexpected shape/); try { createFredClient({ apiKey: "short key!", fetcher: async () => "" }); } catch (e) { expect(String(e)).not.toContain("short key"); } });
  it("parses observations oldest-first and drops FRED's '.' missing marker", async () => {
    const { fetcher, urls } = fredFetcher({ "series/observations": { observations: [{ date: "2026-11-04", value: "6850.5" }, { date: "2026-11-03", value: "." }, { date: "2026-11-02", value: "6800.0" }] } });
    const o = await createFredClient({ apiKey: KEY, fetcher }).observations("SP500", 5);
    expect(o).toEqual([{ date: "2026-11-02", value: 6800 }, { date: "2026-11-04", value: 6850.5 }]); expect(urls[0]).toContain("file_type=json");
  });
  it("rejects a bad series id and an unexpected answer", async () => {
    const c = createFredClient({ apiKey: KEY, fetcher: async () => JSON.stringify({ nope: 1 }) });
    await expect(c.observations("sp 500")).rejects.toThrow(); await expect(c.observations("SP500")).rejects.toThrow(); await expect(c.releaseDates("2026-13-01", "2026-11-01")).rejects.toThrow();
  });
});

describe("economic calendar from FRED release dates", () => {
  const rows = { release_dates: [{ release_id: 10, release_name: "Consumer Price Index", date: "2026-11-12" }, { release_id: 101, release_name: "FOMC Press Release", date: "2026-11-18" }, { release_id: 99, release_name: "Some Obscure Survey", date: "2026-11-10" }, { release_id: 50, release_name: "Employment Situation", date: "2026-11-06" }, { release_id: 50, release_name: "Employment Situation", date: "2026-11-06" }] };
  it("keeps only the named market-moving releases, de-duplicated and sorted, and the agents' parser accepts the file", async () => {
    const b = await buildEconomicCalendar({ now: () => NOW, fred: createFredClient({ apiKey: KEY, fetcher: fredFetcher({ "releases/dates": rows }).fetcher }) });
    const ev = b.document["events"] as Array<{ id: string; impact: string; at: string; name: string }>;
    expect(ev.map((e) => e.id)).toEqual(["fred-nfp-2026-11-06", "fred-cpi-2026-11-12"]); // FRED's FOMC Press Release row (2026-11-18) is NOT a rate decision
    expect(() => parseEconomicCalendar(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
  });
  it("never invents Fed decisions: a daily FRED 'FOMC Press Release' yields none; real meeting days come only from the fixed list", async () => {
    const daily = Array.from({ length: 24 }, (_, i) => ({ release_id: 101, release_name: "FOMC Press Release", date: `2026-11-${String(4 + i).padStart(2, "0")}` }));
    const quiet = await buildEconomicCalendar({ now: () => NOW, fred: createFredClient({ apiKey: KEY, fetcher: fredFetcher({ "releases/dates": { release_dates: daily } }).fetcher }) });
    expect((quiet.document["events"] as Array<{ name: string }>).filter((e) => e.name.includes("Fed"))).toEqual([]);
    const dec = await buildEconomicCalendar({ now: () => new Date("2026-12-05T12:00:00Z"), fred: createFredClient({ apiKey: KEY, fetcher: fredFetcher({ "releases/dates": { release_dates: daily } }).fetcher }) });
    const fed = (dec.document["events"] as Array<{ id: string; at: string; impact: string }>).filter((e) => e.id.startsWith("fomc-"));
    expect(fed).toEqual([{ id: "fomc-2026-12-09", name: "US Fed rate decision", at: "2026-12-09T19:00:00.000Z", impact: "CRITICAL", markets: ["ALL"], category: "central_bank" }]);
    expect(() => parseEconomicCalendar(JSON.parse(JSON.stringify(dec.document)))).not.toThrow();
    expect(FOMC_DECISION_DATES.every((d) => /^2026-\d\d-\d\d$/.test(d))).toBe(true);
  });
  it("uses the right New York offset around daylight saving", () => {
    expect(easternInstant("2026-11-12", "08:30")).toBe("2026-11-12T13:30:00.000Z"); // EST, UTC-5
    expect(easternInstant("2026-07-15", "08:30")).toBe("2026-07-15T12:30:00.000Z"); // EDT, UTC-4
    expect(easternInstant("2026-12-09", "14:00")).toBe("2026-12-09T19:00:00.000Z");
  });
  it("ignores releases outside the requested window (a provider answering more than asked is not trusted)", async () => {
    const b = await buildEconomicCalendar({ now: () => NOW, fred: createFredClient({ apiKey: KEY, fetcher: fredFetcher({ "releases/dates": { release_dates: [{ release_id: 10, release_name: "Consumer Price Index", date: "2027-03-01" }] } }).fetcher }) });
    expect(b.events).toBe(0);
  });
});

describe("holiday calendar import", () => {
  const o = { market: "NSE", from: "2026-01-01", to: "2026-12-31", source: "owner-supplied", now: NOW };
  it("accepts holidays and early closes, in any order, and the agents' parser accepts the file", () => {
    const b = buildHolidayCalendar("date,kind,name,early_close\n# comment\n2026-03-03,holiday,Holi\n2026-01-26,holiday,Republic Day\n2026-11-08,early_close,Muhurat session,13:30\n", o);
    expect(b.days).toBe(3); expect((b.document["markets"] as { NSE: { days: Array<{ date: string }> } }).NSE.days.map((d) => d.date)).toEqual(["2026-01-26", "2026-03-03", "2026-11-08"]);
    expect(() => parseHolidayCalendar(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
  });
  it("refuses bad dates, unknown kinds, out-of-range days and early closes without a time", () => {
    for (const bad of ["2026-02-30,holiday,x", "2026-03-03,vacation,x", "2025-03-03,holiday,x", "2026-03-03,early_close,x", "2026-03-03,early_close,x,25:00", "hello"]) expect(() => buildHolidayCalendar(bad, o), bad).toThrow(HolidayCsvError);
  });
});

// A synthetic snapshot pair in the shape the Kite exporter writes (twins-ohlc-v1 / twins-last-price-v1).
const ohlc = { format: "twins-ohlc-v1", source: "kite-websocket", as_of: "2026-11-05T06:25:40.110Z", series: {
  "NSE:NIFTY": { interval_seconds: 86400, bars: [{ t: "2026-11-03T00:00:00+05:30", o: 24000, h: 24100, l: 23900, c: 24050 }, { t: "2026-11-04T00:00:00+05:30", o: 24060, h: 24300, l: 24000, c: 24200 }, { t: "2026-11-05T00:00:00+05:30", o: 24250, h: 24500, l: 24200, c: 24400 }] },
  "NSE:BANKNIFTY": { interval_seconds: 86400, bars: [{ t: "2026-11-04T00:00:00+05:30", o: 55000, h: 55500, l: 54900, c: 55200 }] },
} };
const last = { format: "twins-last-price-v1", source: "kite-websocket", as_of: "2026-11-05T08:59:00.000Z", prices: { "NSE:NIFTY": { price: 24450, as_of: "2026-11-05T08:58:00.000Z" }, "NSE:BANKNIFTY": { price: 55400, as_of: "2026-11-05T08:59:00.000Z" }, "BSE:SENSEX": { price: 80000, as_of: "2026-11-05T08:59:00.000Z" } } };

describe("macro context", () => {
  it("derives index level, previous close, today's open and recent closes from the snapshots; an index without bars or a fresh price is left out", () => {
    const idx = indexContexts(ohlc, last, NOW);
    expect(idx.map((i) => `${i.market}:${i.symbol}`).sort()).toEqual(["NSE:BANKNIFTY", "NSE:NIFTY"]);
    expect(idx.find((i) => i.symbol === "NIFTY")).toMatchObject({ level: 24450, previousClose: 24200, open: 24250, recentCloses: [24050, 24200], changePct1d: 1.033 });
    expect(indexContexts(ohlc, last, new Date("2026-11-09T09:00:00Z")).length).toBe(0); // 4 days later every price is stale
  });
  const fred = (obs: Record<string, Array<[string, number]>>) => createFredClient({ apiKey: KEY, fetcher: async (u) => { const id = /series_id=([A-Z0-9_]+)/.exec(u)![1]!; if (!obs[id]) throw new Error("no series"); return JSON.stringify({ observations: [...obs[id]!].reverse().map(([date, v]) => ({ date, value: String(v) })) }); } });
  it("adds global indices and USDINR from FRED, passes releases through, uses the OLDEST index time as as_of, and the agents' parser accepts it", async () => {
    const ev = [{ id: "fred-cpi-2026-11-12", name: "US CPI inflation", at: "2026-11-12T13:30:00.000Z", impact: "HIGH", markets: ["ALL"], category: "inflation" }];
    const b = await buildMacro({ ohlc, last, now: () => NOW, releases: ev, fred: fred({ SP500: [["2026-11-03", 6800], ["2026-11-04", 6868]], NASDAQCOM: [["2026-11-03", 23000], ["2026-11-04", 22770]], DEXINUS: [["2026-11-03", 88], ["2026-11-04", 88.44]] }) });
    expect(b).not.toBeNull(); expect(b!.global).toBe(2);
    const doc = b!.document as { as_of: string; contexts: Record<string, { global: Array<{ name: string; change_pct_1d: number }>; currency: { pair: string; change_pct_1d: number }; releases: unknown[]; index: { symbol: string } }> };
    expect(doc.as_of).toBe("2026-11-05T08:58:00.000Z");
    expect(doc.contexts["NSE:NIFTY"]!.global.find((g) => g.name === "SP500")!.change_pct_1d).toBe(1); expect(doc.contexts["NSE:NIFTY"]!.global.find((g) => g.name === "NASDAQ")!.change_pct_1d).toBe(-1);
    expect(doc.contexts["NSE:NIFTY"]!.currency).toEqual({ pair: "USDINR", change_pct_1d: 0.5 }); expect(doc.contexts["NSE:NIFTY"]!.releases.length).toBe(1); expect(doc.contexts["NSE:*"]!.index.symbol).toBe("NIFTY");
    expect(() => parseMacroContext(JSON.parse(JSON.stringify(b!.document)))).not.toThrow();
  });
  it("works without FRED (index only), and publishes nothing when there is no fresh index", async () => {
    const b = await buildMacro({ ohlc, last, now: () => NOW, releases: [], fred: null });
    expect(b!.global).toBe(0); expect(() => parseMacroContext(JSON.parse(JSON.stringify(b!.document)))).not.toThrow();
    expect(await buildMacro({ ohlc, last, now: () => new Date("2026-11-09T09:00:00Z"), releases: [], fred: null })).toBeNull();
  });
  it("a FRED series that cannot be read is left out, not guessed", async () => {
    const b = await buildMacro({ ohlc, last, now: () => NOW, releases: [], fred: fred({ SP500: [["2026-11-03", 6800], ["2026-11-04", 6868]] }) });
    expect(b!.global).toBe(1);
  });
  it("knows whether a market is open", () => {
    expect(sessionStatus(new Date("2026-11-05T15:00:00Z"), "America/New_York", "09:30", "16:00")).toBe("open"); // 10:00 ET Thursday
    expect(sessionStatus(new Date("2026-11-05T22:00:00Z"), "America/New_York", "09:30", "16:00")).toBe("closed");
    expect(sessionStatus(new Date("2026-11-07T15:00:00Z"), "America/New_York", "09:30", "16:00")).toBe("closed"); // Saturday
    expect(sessionStatus(new Date("2026-11-05T02:00:00Z"), "Asia/Tokyo", "09:00", "15:00")).toBe("open");
  });
});

describe("market data", () => {
  it("quotes: the one-day change of each subscribed index; the agents' parser accepts it", () => {
    const b = buildMarketQuotes(ohlc, last, NOW)!;
    expect(b.quotes).toBe(2); expect((b.document["quotes"] as Record<string, { change_pct_1d: number }>)["NSE:NIFTY"]!.change_pct_1d).toBe(1.033);
    expect(() => parseQuotesFile(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
    expect(buildMarketQuotes(ohlc, last, new Date("2026-11-09T09:00:00Z"))).toBeNull();
  });
  it("constituents: imported from an owner-supplied CSV, validated; weights over 100 in total are refused by the agents' parser", () => {
    const o = { index: "NIFTY", source: "owner-supplied", asOf: NOW };
    const b = buildConstituents("symbol,weight,sector,recent_change_pct\nRELIANCE,9.5,Energy,0.8\nHDFCBANK,13.2,Financials\n", o);
    expect(b.constituents).toBe(2); expect(() => parseConstituentsFile(JSON.parse(JSON.stringify(b.document)))).not.toThrow();
    expect(() => parseConstituentsFile(JSON.parse(JSON.stringify(buildConstituents("symbol,weight,sector\nA,60,X\nB,60,X\n", o).document)))).toThrow();
    for (const bad of ["a,1,X", "A,0,X", "A,101,X", "A,1,", "A,x,X", "A,1,X,zz"]) expect(() => buildConstituents(bad, o), bad).toThrow(ConstituentsCsvError);
  });
});
