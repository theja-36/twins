import { describe, expect, it } from "vitest";
import { quoteProblem } from "../../../packages/agents/src/agents/quoteProviders";
import {
  getDayOhlc, getFullQuotes, getLtp, instrumentKey, KiteError, lastPriceFromLtp, mapFullQuote, mapLastPriceFromFullQuote, parseQuoteTimestamp, toLimitedLastPrice,
  type KiteInstrument, type RawFullQuote,
} from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, catalog, clientWith, fixture, json, ok } from "./helpers";

const cat = catalog();
const NOW = "2026-11-02T10:16:00.000Z"; // 15:46:00 IST
const now = (): Date => new Date(NOW);
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const fut = cat.require({ underlying: "NIFTY", kind: "future", expiry: "2026-11-26" });
const callOpt = cat.require({ underlying: "NIFTY", kind: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" });
const bnFut = cat.require({ underlying: "BANKNIFTY", kind: "future", expiry: "2026-11-26" });
const sensexOpt = cat.require({ underlying: "SENSEX", kind: "option", expiry: "2026-11-26", strike: 80000, optionType: "CE" });
const full = (fixture("quote.full.json") as { data: Record<string, Record<string, unknown>> }).data;
const raw = (key: string, over: Record<string, unknown> = {}): RawFullQuote => ({ raw: { ...(full[key] as Record<string, unknown>), ...over } });
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => (e instanceof KiteError ? e.code : "other"));

describe("timestamps", () => {
  it("reads IST quote times as UTC instants and rejects placeholders, impossible dates and other formats", () => {
    expect(parseQuoteTimestamp("2026-11-02 15:45:56")).toBe("2026-11-02T10:15:56.000Z");
    for (const bad of ["0000-00-00 00:00:00", "2026-02-31 10:00:00", "2026-11-02 25:00:00", "2026-11-02T15:45:56", "2026-11-02T15:45:56+0530", "", null, undefined, 1730000000]) expect(parseQuoteTimestamp(bad)).toBeNull();
  });
});

describe("full quote batch", () => {
  it("requests instrument keys from the catalog, reports MISSING instruments and unexpected keys, and records the local fetch time separately", async () => {
    const { client, session, calls } = clientWith([ok(full)]);
    session.setToken(ACCESS_TOKEN);
    const b = await getFullQuotes(client, [nifty, fut, callOpt, bnFut, sensexOpt], now);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.kite.trade/quote?i=NSE%3ANIFTY+50&i=NFO%3ANIFTY26NOVFUT&i=NFO%3ANIFTY26NOV24000CE&i=NFO%3ABANKNIFTY26NOVFUT&i=BFO%3ASENSEX26NOV80000CE");
    expect(b.entries.map((e) => [instrumentKey(e.instrument), e.status])).toEqual([
      ["NSE:NIFTY 50", "ok"], ["NFO:NIFTY26NOVFUT", "ok"], ["NFO:NIFTY26NOV24000CE", "ok"], ["NFO:BANKNIFTY26NOVFUT", "ok"], ["BFO:SENSEX26NOV80000CE", "missing"],
    ]);
    expect(b.unexpectedKeys).toEqual(["NSE:NOT-REQUESTED"]);
    expect(b.fetchedAt).toBe(NOW);
  });
  it("flags a token mismatch and a non-object entry per instrument instead of trusting them", async () => {
    const data = { ...full, "NFO:NIFTY26NOVFUT": { ...(full["NFO:NIFTY26NOVFUT"] as object), instrument_token: 42 }, "NSE:NIFTY 50": "oops" };
    const { client, session } = clientWith([ok(data)]);
    session.setToken(ACCESS_TOKEN);
    const b = await getFullQuotes(client, [nifty, fut], now);
    expect(b.entries.map((e) => (e.status === "invalid" ? e.reason : e.status))).toEqual(["not_an_object", "token_mismatch"]);
  });
  it("rejects duplicate requests, non-object data, and chunks at the documented 500", async () => {
    const { client, session, calls } = clientWith([ok([]), ok({}), ok({})]);
    session.setToken(ACCESS_TOKEN);
    expect(await code(getFullQuotes(client, [nifty, nifty], now))).toBe("INVALID_REQUEST");
    expect(await code(getFullQuotes(client, [nifty], now))).toBe("MALFORMED_RESPONSE");
    const many: KiteInstrument[] = Array.from({ length: 501 }, (_, n) => ({ ...fut, tradingSymbol: `X${n}`, token: 1000 + n }));
    const b = await getFullQuotes(client, many, now);
    expect(calls.length).toBe(1 + 2); // the duplicate check sends nothing; the malformed response is 1; the 501 instruments are two chunks
    expect(b.entries).toHaveLength(501);
    expect(b.entries.every((e) => e.status === "missing")).toBe(true);
  });
  it("a server-side token rejection mid-request invalidates the session and surfaces SESSION_INVALID", async () => {
    const { client, session } = clientWith([json({ status: "error", error_type: "TokenException", message: "x" }, 403)]);
    session.setToken(ACCESS_TOKEN);
    expect(await code(getFullQuotes(client, [nifty], now))).toBe("SESSION_INVALID");
    expect(session.state().status).toBe("invalid");
  });
});

describe("mapFullQuote (pure)", () => {
  it("maps a future: best bid/ask and their sizes, volume, open interest; asOf is the UPSTREAM time; avgVolume is not invented", () => {
    const r = mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT"), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quote).toEqual({ bid: 24399.9, ask: 24400.1, last: 24400, volume: 1234500, avgVolume: null, openInterest: 15432000, bidDepth: 150, askDepth: 300, asOf: "2026-11-02T10:15:56.000Z" });
    expect(r.value.upstreamTimestamp).toBe(r.value.quote.asOf);
    expect(r.value.lastTradeTime).toBe("2026-11-02T10:15:52.000Z");
    expect(r.value.fetchedAt).toBe(NOW);
    expect(r.value.ageMs).toBe(4000);
    expect(quoteProblem(r.value.quote)).toBeNull();
  });
  it("empty depth levels (price 0) are null, not zero; a real traded volume/OI of 0 stays 0", () => {
    const r = mapFullQuote(callOpt, raw("NFO:NIFTY26NOV24000CE"), NOW);
    expect(r.ok && r.value.quote).toMatchObject({ bid: null, bidDepth: null, ask: 413, askDepth: 75, volume: 0, openInterest: 0, last: 412.35 });
  });
  it("an absent oi is null (never 0); an absent depth is null on both sides", () => {
    const { oi: _oi, depth: _depth, ...rest } = full["NFO:NIFTY26NOVFUT"] as Record<string, unknown>;
    const r = mapFullQuote(fut, { raw: rest }, NOW);
    expect(r.ok && r.value.quote).toMatchObject({ openInterest: null, bid: null, ask: null, bidDepth: null, askDepth: null });
  });
  it("an INDEX needs nothing derivative-specific and never reports volume, OI or depth, even when the API sends zeros", () => {
    const r = mapFullQuote(nifty, raw("NSE:NIFTY 50"), NOW);
    expect(r.ok && r.value.quote).toEqual({ bid: null, ask: null, last: 24350.5, volume: null, avgVolume: null, openInterest: null, bidDepth: null, askDepth: null, asOf: "2026-11-02T10:15:56.000Z" });
    const noExtras = mapFullQuote(nifty, { raw: { timestamp: "2026-11-02 15:45:56", last_price: 24350.5 } }, NOW);
    expect(noExtras.ok).toBe(true);
  });
  it("without a valid UPSTREAM timestamp it is NOT mapped; the fetch time and last_trade_time are never substituted", () => {
    for (const ts of [undefined, null, "0000-00-00 00:00:00", "garbage", "2026-02-30 10:00:00"]) {
      const r = mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT", { timestamp: ts }), NOW);
      expect(r).toEqual({ ok: false, reason: "no_upstream_timestamp" });
    }
  });
  it("a stale quote still maps but carries its true age (fetching now does not make it fresh); a timestamp from the future is refused", () => {
    const stale = mapFullQuote(bnFut, raw("NFO:BANKNIFTY26NOVFUT"), NOW);
    expect(stale.ok && stale.value.ageMs).toBeGreaterThan(2 * 86_400_000);
    expect(stale.ok && stale.value.quote.asOf).toBe("2026-10-30T09:59:59.000Z");
    expect(mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT", { timestamp: "2026-11-02 16:30:00" }), NOW)).toEqual({ ok: false, reason: "timestamp_in_future" });
    const small = mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT", { timestamp: "2026-11-02 15:46:30" }), NOW);
    expect(small.ok && small.value.ageMs).toBe(-30_000); // small skew tolerated and visible
  });
  it("applies the existing validator: a crossed market is refused; bad numbers are refused, not coerced", () => {
    const crossed = raw("NFO:NIFTY26NOVFUT", { depth: { buy: [{ price: 24401, quantity: 1, orders: 1 }], sell: [{ price: 24400, quantity: 1, orders: 1 }] } });
    expect(mapFullQuote(fut, crossed, NOW)).toEqual({ ok: false, reason: "quote_crossed" });
    for (const [over, reason] of [
      [{ last_price: -1 }, "bad_last_price"], [{ last_price: "24400" }, "bad_last_price"], [{ volume: -5 }, "bad_volume"], [{ volume: "9" }, "bad_volume"], [{ oi: -1 }, "bad_oi"],
      [{ depth: "x" }, "bad_depth"], [{ depth: { buy: [{ price: 1, quantity: -1, orders: 1 }], sell: [] } }, "bad_depth"], [{ depth: { buy: "x", sell: [] } }, "bad_depth"],
    ] as const) expect(mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT", over), NOW)).toEqual({ ok: false, reason });
  });
  it("last_price 0 means no price (null), which the validator allows", () => {
    const r = mapFullQuote(fut, raw("NFO:NIFTY26NOVFUT", { last_price: 0 }), NOW);
    expect(r.ok && r.value.quote.last).toBeNull();
    expect(mapLastPriceFromFullQuote(fut, raw("NFO:NIFTY26NOVFUT", { last_price: 0 }), NOW)).toEqual({ ok: false, reason: "no_last_price" });
  });
});

describe("LastPrice and the lightweight endpoints", () => {
  it("a LastPrice comes only from a full quote and is as of the upstream time", () => {
    const r = mapLastPriceFromFullQuote(nifty, raw("NSE:NIFTY 50"), NOW);
    expect(r).toEqual({ ok: true, value: { price: 24350.5, asOf: "2026-11-02T10:15:56.000Z", fetchedAt: NOW, ageMs: 4000 } });
  });
  it("LTP is a typed LIMITED result with no upstream timestamp; it cannot be turned into a LastPrice; zero price is invalid", async () => {
    const { client, session, calls } = clientWith([ok((fixture("quote.ltp.json") as { data: unknown }).data)]);
    session.setToken(ACCESS_TOKEN);
    const b = await getLtp(client, [nifty, fut, callOpt], now);
    expect(calls[0]?.url).toContain("/quote/ltp?");
    expect(b.entries.map((e) => (e.status === "ok" ? e.raw.price : e.status === "invalid" ? e.reason : e.status))).toEqual([24350.5, 24400, "bad_last_price"]);
    const first = b.entries[0];
    expect(first?.status === "ok" && toLimitedLastPrice(first.raw, b.fetchedAt)).toEqual({ price: 24350.5, upstreamTimestamp: null, fetchedAt: NOW });
    expect(lastPriceFromLtp()).toEqual({ ok: false, reason: "no_upstream_timestamp" });
  });
  it("day OHLC is a limited result (not a candle series); zero or incoherent values are invalid, missing instruments are reported", async () => {
    const data = { ...(fixture("quote.ohlc.json") as { data: Record<string, unknown> }).data };
    delete data["NFO:NIFTY26NOV24000CE"];
    const { client, session, calls } = clientWith([ok(data)]);
    session.setToken(ACCESS_TOKEN);
    const b = await getDayOhlc(client, [nifty, fut, callOpt], now);
    expect(calls[0]?.url).toContain("/quote/ohlc?");
    expect(b.entries.map((e) => e.status)).toEqual(["ok", "ok", "missing"]);
    expect(b.entries[0]).toMatchObject({ raw: { open: 24300, high: 24400, low: 24280, close: 24310, last: 24350.5 } });
    const bad = clientWith([ok({ "NSE:NIFTY 50": { instrument_token: 256265, ohlc: { open: 0, high: 0, low: 0, close: 24310 } }, "NFO:NIFTY26NOVFUT": { instrument_token: 9000001, ohlc: { open: 1, high: 1, low: 2, close: 1 } }, "NFO:NIFTY26NOV24000CE": { instrument_token: 9000002 } })]);
    bad.session.setToken(ACCESS_TOKEN);
    expect((await getDayOhlc(bad.client, [nifty, fut, callOpt], now)).entries.map((e) => (e.status === "invalid" ? e.reason : e.status))).toEqual(["bad_ohlc", "bad_ohlc", "no_ohlc"]);
  });
});
