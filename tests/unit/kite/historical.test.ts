import { describe, expect, it } from "vitest";
import { ohlcProblem } from "../../../packages/agents/src/agents/ohlcProviders";
import { getCandles, INTERVAL_SECONDS, KiteError, mapCandles, parseCandleTimestamp, toKiteParam, type RawCandles } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, catalog, clientWith, fixture, ok } from "./helpers";

const cat = catalog();
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const fut = cat.require({ underlying: "NIFTY", kind: "future", expiry: "2026-11-26" });
const NOW = "2026-11-02T04:00:00.000Z"; // 09:30 IST
const now = (): Date => new Date(NOW);
const futCandles = (fixture("historical.future.minute.json") as { data: { candles: unknown[] } }).data.candles;
const idxCandles = (fixture("historical.index.day.json") as { data: { candles: unknown[] } }).data.candles;
const rawOf = (candles: unknown[], over: Partial<RawCandles> = {}): RawCandles => ({ instrument: fut, interval: "minute", candles, fetchedAt: "2026-11-02T04:30:00.000Z", withOi: true, ...over });
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => (e instanceof KiteError ? e.code : "other"));
const reason = (r: { ok: boolean; reason?: string }): string | undefined => (r.ok ? undefined : r.reason);

describe("timestamps", () => {
  it("parses candle times with +0530 or +05:30 and keeps the exchange offset", () => {
    expect(parseCandleTimestamp("2026-11-02T09:15:00+0530")).toEqual({ instant: Date.parse("2026-11-02T03:45:00Z"), iso: "2026-11-02T09:15:00+05:30" });
    expect(parseCandleTimestamp("2026-11-02T09:15:00+05:30")?.iso).toBe("2026-11-02T09:15:00+05:30");
    for (const bad of ["2026-11-02 09:15:00", "2026-11-02T09:15:00", "2026-11-02T09:15:00Z", "2026-13-02T09:15:00+0530", "2026-11-02T09:15:00+9999", 5, null]) expect(parseCandleTimestamp(bad)).toBeNull();
  });
  it("formats from/to in IST", () => {
    expect(toKiteParam(new Date("2026-11-02T03:45:00Z"))).toBe("2026-11-02 09:15:00");
    expect(toKiteParam(new Date("2026-11-01T20:00:00Z"))).toBe("2026-11-02 01:30:00");
  });
});

describe("getCandles", () => {
  it("requests one listed instrument: IST range, continuous=0, oi=1 for derivatives and oi=0 for an index", async () => {
    const a = clientWith([ok({ candles: futCandles }), ok({ candles: idxCandles })]);
    a.session.setToken(ACCESS_TOKEN);
    const range = { from: new Date("2026-11-02T03:45:00Z"), to: new Date("2026-11-02T04:00:00Z") };
    const r = await getCandles(a.client, fut, { interval: "minute", ...range }, now);
    expect(a.calls[0]?.url).toBe("https://api.kite.trade/instruments/historical/9000001/minute?from=2026-11-02+09%3A15%3A00&to=2026-11-02+09%3A30%3A00&continuous=0&oi=1");
    expect(r).toMatchObject({ interval: "minute", withOi: true, fetchedAt: NOW });
    await getCandles(a.client, nifty, { interval: "day", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") }, now);
    expect(a.calls[1]?.url).toContain("/instruments/historical/256265/day?");
    expect(a.calls[1]?.url).toContain("continuous=0&oi=0");
  });
  it("refuses, before any request, bad ranges, unknown intervals, over-long spans and EXPIRED contracts (no expired-option history, no continuous)", async () => {
    const { client, session, calls } = clientWith([]);
    session.setToken(ACCESS_TOKEN);
    const from = new Date("2026-11-02T03:45:00Z");
    const to = new Date("2026-11-02T04:00:00Z");
    expect(await code(getCandles(client, fut, { interval: "minute", from: to, to: from }, now))).toBe("INVALID_REQUEST");
    expect(await code(getCandles(client, fut, { interval: "minute", from, to: from }, now))).toBe("INVALID_REQUEST");
    expect(await code(getCandles(client, fut, { interval: "week" as never, from, to }, now))).toBe("INVALID_REQUEST");
    expect(await code(getCandles(client, fut, { interval: "minute", from: new Date("2026-08-01T00:00:00Z"), to }, now))).toBe("INVALID_REQUEST"); // > 60 days
    expect(await code(getCandles(client, fut, { interval: "minute", from, to: new Date("invalid") }, now))).toBe("INVALID_REQUEST");
    expect(await code(getCandles(client, fut, { interval: "minute", from, to }, () => new Date("2026-12-01T00:00:00Z")))).toBe("INVALID_REQUEST"); // contract expired on 2026-11-26
    expect(calls).toHaveLength(0);
  });
  it("malformed envelopes and session invalidation surface as typed errors", async () => {
    const a = clientWith([ok({ nope: 1 }), ok(null)]);
    a.session.setToken(ACCESS_TOKEN);
    const req = { interval: "minute" as const, from: new Date("2026-11-02T03:45:00Z"), to: new Date("2026-11-02T04:00:00Z") };
    expect(await code(getCandles(a.client, fut, req, now))).toBe("MALFORMED_RESPONSE");
    expect(await code(getCandles(a.client, fut, req, now))).toBe("MALFORMED_RESPONSE");
    const b = clientWith([]);
    expect(await code(getCandles(b.client, fut, req, now))).toBe("NO_SESSION");
  });
});

describe("mapCandles (pure)", () => {
  it("maps a derivative series into the OhlcSeries contract (oldest first, exchange offset kept), with OI kept apart and absent OI as null", () => {
    const r = mapCandles(rawOf(futCandles));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.series).toEqual({
      symbol: "NIFTY26NOVFUT", intervalSeconds: 60,
      bars: [
        { t: "2026-11-02T09:15:00+05:30", open: 24350, high: 24380, low: 24340, close: 24370, volume: 15000 },
        { t: "2026-11-02T09:16:00+05:30", open: 24370, high: 24390, low: 24360, close: 24385, volume: 12000 },
        { t: "2026-11-02T09:17:00+05:30", open: 24385, high: 24400, low: 24375, close: 24395, volume: 9000 },
      ],
    });
    expect(r.value.openInterest).toEqual([15400000, 15410000, null]);
    expect(ohlcProblem(r.value.series)).toBeNull();
    expect(r.value.duplicatesRemoved).toBe(0);
  });
  it("an index series has no volume or OI (the API's zeros are not traded volume) and needs no derivative fields", () => {
    const r = mapCandles(rawOf(idxCandles, { instrument: nifty, interval: "day", withOi: false }));
    expect(r.ok && r.value.series.bars.map((b) => b.volume)).toEqual([null, null]);
    expect(r.ok && r.value.openInterest).toBeNull();
    expect(r.ok && r.value.series.intervalSeconds).toBe(INTERVAL_SECONDS.day);
  });
  it("reports whether the last bar may still be open; it never drops it and says nothing about upstream freshness", () => {
    const open = mapCandles(rawOf(futCandles, { fetchedAt: "2026-11-02T03:47:30.000Z" })); // 09:17:30 IST, inside the 09:17 bar
    const closed = mapCandles(rawOf(futCandles, { fetchedAt: "2026-11-02T04:30:00.000Z" }));
    expect(open.ok && open.value.lastBarMayBeOpen).toBe(true);
    expect(open.ok && open.value.series.bars).toHaveLength(3);
    expect(closed.ok && closed.value.lastBarMayBeOpen).toBe(false);
  });
  it("removes byte-identical duplicate bars (counted) and fails on conflicting duplicates", () => {
    const dup = mapCandles(rawOf([futCandles[0], futCandles[0], futCandles[1]]));
    expect(dup.ok && [dup.value.series.bars.length, dup.value.duplicatesRemoved]).toEqual([2, 1]);
    const conflict = [futCandles[0], ["2026-11-02T09:15:00+0530", 24350, 24381, 24340, 24370, 15000, 15400000]];
    expect(reason(mapCandles(rawOf(conflict)))).toBe("conflicting_duplicate");
  });
  it("fails closed, never sorts or repairs: order, shape, time, price, volume, OI and OHLC coherence", () => {
    const c = futCandles as unknown[][];
    const cases: Array<[unknown[], string]> = [
      [[c[1], c[0]], "candles_out_of_order"],
      [[["2026-11-02T09:15:00+0530", 1, 2, 3]], "bad_candle_shape"],
      [[[...c[0]!, 1, 2]], "bad_candle_shape"],
      ["not-an-array" as never, "bad_candle_shape"],
      [[{ t: 1 }], "bad_candle_shape"],
      [[["09:15", 1, 2, 1, 1, 1]], "bad_candle_time"],
      [[["2026-11-02T09:15:00+0530", "1", 2, 1, 1, 1]], "bad_candle_price"],
      [[["2026-11-02T09:15:00+0530", 1, NaN, 1, 1, 1]], "bad_candle_price"],
      [[["2026-11-02T09:15:00+0530", 1, 2, 1, 1, -1]], "bad_candle_volume"],
      [[["2026-11-02T09:15:00+0530", 1, 2, 1, 1, "9"]], "bad_candle_volume"],
      [[["2026-11-02T09:15:00+0530", 1, 2, 1, 1, 1, -4]], "bad_candle_oi"],
      [[["2026-11-02T09:15:00+0530", 10, 5, 4, 8, 1, 1]], "series_ohlc"], // high < open
      [[["2026-11-02T09:15:00+0530", 10, 12, 13, 11, 1, 1]], "series_ohlc"], // low > high
      [[["2026-11-02T09:15:00+0530", 0, 0, 0, 0, 1, 1]], "series_ohlc"], // zero prices
    ];
    for (const [rows, why] of cases) expect(reason(mapCandles(rawOf(rows))), why).toBe(why);
  });
  it("one bad bar anywhere fails the whole series (no silent gaps)", () => {
    const rows = [futCandles[0], ["2026-11-02T09:16:00+0530", 5, 4, 6, 5, 1, 1], futCandles[2]];
    expect(reason(mapCandles(rawOf(rows)))).toBe("series_ohlc");
  });
  it("null volume and an empty series are explicit, valid results", () => {
    const nullVol = mapCandles(rawOf([["2026-11-02T09:15:00+0530", 10, 12, 9, 11, null, null]]));
    expect(nullVol.ok && nullVol.value.series.bars[0]?.volume).toBeNull();
    const empty = mapCandles(rawOf([]));
    expect(empty.ok && empty.value.series.bars).toEqual([]);
  });
  it("zero volume on a derivative is a real zero, not null", () => {
    const r = mapCandles(rawOf([["2026-11-02T09:15:00+0530", 10, 12, 9, 11, 0, 0]]));
    expect(r.ok && [r.value.series.bars[0]?.volume, r.value.openInterest]).toEqual([0, [0]]);
  });
});
