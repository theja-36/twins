import { describe, expect, it, vi } from "vitest";
import { YahooFinanceAdapter } from "../../../adapters/market/src/yahoo";
import { barsKnownAsOf, HistoryRequestError, providerFromHistoryResult, retrieveHistory, validateHistoryRequest, type HistoryRequest } from "../../../packages/ingestion/src/history";
import { ProviderRateLimitError, ProviderUnavailableError, type MarketDataProvider, type NormalizedMarketBar } from "../../../packages/types/src";

const inst = { symbol: "^NSEI", exchange: "INDEX" };
const T = (iso: string) => new Date(iso);
const req = (o: Partial<HistoryRequest> = {}): HistoryRequest => ({ instrument: inst, seriesKind: "index_level", timeframe: "1d", from: T("2026-10-01T00:00:00Z"), to: T("2026-10-10T00:00:00Z"), ...o });
const bar = (iso: string, o: Partial<NormalizedMarketBar> = {}): NormalizedMarketBar => ({ instrument: inst, source: "stub", timeframe: "1d", observedAt: T(iso), open: 1, high: 2, low: 0.5, close: 1.5, ...o });
const stub = (bars: NormalizedMarketBar[] | Error): MarketDataProvider => ({
  providerName: "stub",
  getHistoricalBars: vi.fn(async () => { if (bars instanceof Error) throw bars; return bars; }),
  getLatestQuote: async () => null,
  getHealth: async () => ({ providerName: "stub", providerType: "market", status: "healthy", checkedAt: new Date() }),
});
const clock = (iso: string) => () => T(iso);

describe("history request validation", () => {
  it("requires explicit, valid instrument, kind, interval and ordered bounds", () => {
    expect(() => validateHistoryRequest(req())).not.toThrow();
    expect(() => validateHistoryRequest(req({ from: T("2026-10-10T00:00:00Z"), to: T("2026-10-01T00:00:00Z") }))).toThrow(HistoryRequestError);
    expect(() => validateHistoryRequest(req({ from: new Date("nope") }))).toThrow(HistoryRequestError);
    expect(() => validateHistoryRequest(req({ timeframe: "2d" as never }))).toThrow(/unsupported timeframe/);
    expect(() => validateHistoryRequest(req({ seriesKind: "option_premium" as never }))).toThrow(/option-premium/);
    expect(() => validateHistoryRequest(req({ instrument: { symbol: "", exchange: "NSE" } }))).toThrow(HistoryRequestError);
  });
  it("refuses option-shaped symbols instead of substituting the index", () => {
    for (const symbol of ["NIFTY24500CE", "NIFTY-Nov2026-24500-CE", "NIFTY 09 NOV 24500 CALL", "BANKNIFTY 52000 PE"]) {
      expect(() => validateHistoryRequest(req({ instrument: { symbol, exchange: "NSE" } })), symbol).toThrow(/option contract/);
    }
    expect(() => validateHistoryRequest(req({ instrument: { symbol: "RELIANCE", exchange: "NSE" }, seriesKind: "equity" }))).not.toThrow();
  });
  it("does not call the provider for an invalid request", async () => {
    const p = stub([]);
    await expect(retrieveHistory(p, req({ seriesKind: "x" as never }))).rejects.toThrow(HistoryRequestError);
    expect(p.getHistoricalBars).not.toHaveBeenCalled();
  });
});

describe("retrieveHistory", () => {
  it("returns a complete series with provenance, sorted, with half-open bounds", async () => {
    const r = await retrieveHistory(stub([bar("2026-10-02T00:00:00Z"), bar("2026-10-01T00:00:00Z")]), req(), clock("2026-10-21T00:00:00Z"));
    expect(r.status).toBe("partial"); // out-of-order is reported, not hidden
    expect(r.report.returnedOutOfOrder).toBe(true);
    expect(r.bars.map((b) => b.observedAt.toISOString())).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect(r.retrievedAt.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(r.provider).toBe("stub");
    expect(r.optionPremiumHistory).toBe("not_supported");
    expect(r.report.gapDetection).toBe("not_performed_no_trading_calendar");
    const ordered = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z"), bar("2026-10-02T00:00:00Z")]), req(), clock("2026-10-21T00:00:00Z"));
    expect(ordered.status).toBe("complete");
  });
  it("includes `from`, excludes `to`, and drops out-of-range bars with a count", async () => {
    const r = await retrieveHistory(stub([bar("2026-09-30T23:59:59Z"), bar("2026-10-01T00:00:00Z"), bar("2026-10-10T00:00:00Z")]), req());
    expect(r.bars).toHaveLength(1);
    expect(r.report.droppedOutOfBounds).toBe(2);
    expect(r.status).toBe("partial");
  });
  it("drops duplicate timestamps (first kept) and reports them", async () => {
    const r = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z", { close: 1.1 }), bar("2026-10-01T00:00:00Z", { close: 9 })]), req());
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0]?.close).toBe(1.1);
    expect(r.report.droppedDuplicateTimestamp).toBe(1);
    expect(r.status).toBe("partial");
  });
  it("flags incomplete bars and never fills or forward-fills missing values or missing days", async () => {
    const noClose = bar("2026-10-02T00:00:00Z");
    delete noClose.close;
    const r = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z"), noClose, bar("2026-10-07T00:00:00Z")]), req());
    expect(r.bars).toHaveLength(3); // 3 Oct-6 Oct are simply absent: nothing invented
    expect(r.bars[1]?.close).toBeUndefined();
    expect(r.report.incompleteBars).toBe(1);
    expect(r.report.barsWithoutVolume).toBe(3);
    expect(r.status).toBe("partial");
  });
  it("reports an empty range as no_data, not as an empty success or zero candles", async () => {
    const r = await retrieveHistory(stub([]), req());
    expect(r.status).toBe("no_data");
    expect(r.bars).toEqual([]);
    expect(r.report.notes.join(" ")).toMatch(/not as zero-valued candles/);
  });
  it("turns provider failures into status failed with the typed error and no bars", async () => {
    for (const err of [new ProviderUnavailableError("stub"), new ProviderRateLimitError("stub", 1000), new Error("boom")]) {
      const r = await retrieveHistory(stub(err), req());
      expect(r.status).toBe("failed");
      expect(r.bars).toEqual([]);
      expect(r.failure?.message).toBeTruthy();
    }
    expect((await retrieveHistory(stub(new ProviderRateLimitError("stub")), req())).failure?.name).toBe("ProviderRateLimitError");
  });
  it("keeps the provider's own interval label and notes the difference", async () => {
    const r = await retrieveHistory(stub([bar("2026-10-01T04:00:00Z", { timeframe: "60m" })]), req({ timeframe: "1h" }));
    expect(r.bars[0]?.timeframe).toBe("60m");
    expect(r.report.notes.join(" ")).toMatch(/provider's own interval label \(60m\)/);
  });
});

describe("as-of / replay semantics", () => {
  it("data retrieved later is not known earlier, and bars after as-of are excluded", async () => {
    const r = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z"), bar("2026-10-02T00:00:00Z")]), req(), clock("2026-10-21T00:00:00Z"));
    expect(barsKnownAsOf(r, T("2026-10-05T00:00:00Z"))).toEqual([]); // observed in the past, but not retrieved yet
    expect(barsKnownAsOf(r, T("2026-10-21T00:00:00Z"))).toHaveLength(2);
    expect(barsKnownAsOf(r, T("2026-10-22T00:00:00Z"))).toHaveLength(2);
    const early = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z"), bar("2026-10-02T00:00:00Z")]), req(), clock("2026-10-03T00:00:00Z"));
    expect(barsKnownAsOf(early, T("2026-10-01T12:00:00Z"))).toEqual([]);
    expect(barsKnownAsOf(early, T("2026-10-03T00:00:00Z"))).toHaveLength(2);
  });
  it("the persistence adapter hands the existing ingest path only the checked bars", async () => {
    const r = await retrieveHistory(stub([bar("2026-10-01T00:00:00Z"), bar("2026-11-01T00:00:00Z")]), req());
    const p = providerFromHistoryResult(r);
    expect(await p.getHistoricalBars({ instrument: inst, timeframe: "1d", from: r.request.from, to: r.request.to })).toHaveLength(1);
  });
});

describe("with the real Yahoo adapter and a recorded offline response", () => {
  const body = { chart: { result: [{ meta: {}, timestamp: [1759276800, 1759363200, 1759449600], indicators: { quote: [{ open: [100, null, 102], high: [105, null, 107], low: [99, null, 101], close: [104, null, 106], volume: [10, null, 12] }] } }] } };
  it("maps null candle fields to absent values, which the layer reports as incomplete (nothing coerced to 0)", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const r = await retrieveHistory(new YahooFinanceAdapter({ fetchFn }), req({ from: T("2025-09-30T00:00:00Z"), to: T("2025-10-10T00:00:00Z") }), clock("2026-10-21T00:00:00Z"));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(r.status).toBe("partial");
    expect(r.report.incompleteBars).toBe(1);
    expect(r.bars[1]).not.toHaveProperty("close");
    expect(r.bars.every((b) => b.source === "yahoo-finance")).toBe(true);
  });
  it("an HTTP failure from the adapter is a failed result, not empty data", async () => {
    const fetchFn = vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    const r = await retrieveHistory(new YahooFinanceAdapter({ fetchFn }), req());
    expect(r.status).toBe("failed");
    expect(r.failure?.name).toBe("ProviderUnavailableError");
  }, 30_000);
});
