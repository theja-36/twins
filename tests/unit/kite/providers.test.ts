import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainProblem, optionQuoteProblem, quoteProblem } from "../../../packages/agents/src/agents/quoteProviders";
import {
  chooseSource, kiteInstrumentReference, kiteLastPriceProvider, kiteOhlcProvider, kiteOptionsChainProvider, kiteOptionsQuoteProvider, kiteQuoteProvider, KiteTicker,
  mapCandles, resolveQuery, Session, twinsKey, websocketSource, type KiteInstrument, type QuoteSource, type RawCandles, type TickerTimers, type WsConnection,
} from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, catalog, NOW_MS, rest, WIRING } from "./helpers";

const cat = catalog();
const get = (u: string, k: "index" | "future" | "option", extra: { expiry?: string; strike?: number; optionType?: string } = {}): KiteInstrument => cat.require({ underlying: u, kind: k, ...extra });
const nifty = get("NIFTY", "index"), niftyFut = get("NIFTY", "future", { expiry: "2026-11-26" });
const ce = get("NIFTY", "option", { expiry: "2026-11-26", strike: 24000, optionType: "CE" });

describe("instrument reference", () => {
  const ref = kiteInstrumentReference(cat, { asOf: "2026-11-02T10:00:00.000Z" });
  it("exposes catalog-listed futures and options with lot sizes, and nothing else", async () => {
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" })).toMatchObject({ lotSize: 75, active: true, strike: 24000, optionType: "CE" });
    expect(await ref.lookup({ market: "BSE", underlying: "SENSEX", instrumentType: "future", expiry: "2026-11-26" })).toMatchObject({ lotSize: 20 });
    expect(await ref.listedExpiries("NSE", "NIFTY", "option")).toEqual(["2026-11-26"]);
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24050, optionType: "CE" })).toBeNull();
    expect(ref.asOf).toBe("2026-11-02T10:00:00.000Z");
  });
  it("scope: three underlyings on NSE/BSE only; an index is not mislabelled as an equity", async () => {
    expect(await ref.supportsMarket("NSE")).toBe(true);
    expect(await ref.supportsMarket("BSE")).toBe(true);
    expect(await ref.supportsMarket("MCX")).toBe(false);
    expect(await ref.underlyingKnown("NSE", "BANKNIFTY")).toBe(true);
    expect(await ref.underlyingKnown("NSE", "FINNIFTY")).toBe(false);
    expect(await ref.underlyingKnown("BSE", "NIFTY")).toBe(false);
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "equity" })).toBeNull();
    expect(ref.diagnostics.list()).toEqual([{ key: "index_records", reason: "indices_not_exported_as_equity" }]);
  });
});

describe("query mapping", () => {
  it("maps TWINS queries onto catalog instruments and keys, and refuses everything else explicitly", () => {
    expect(twinsKey(ce)).toBe("NSE:NIFTY:2026-11-26:24000:CE");
    expect(twinsKey(niftyFut)).toBe("NSE:NIFTY:2026-11-26");
    expect(twinsKey(nifty)).toBe("NSE:NIFTY");
    expect(resolveQuery(cat, { market: "BSE", symbol: "sensex", instrumentType: "equity", expiry: null, strike: null, optionType: null })).toMatchObject({ ok: true });
    for (const [q, why] of [
      [{ market: "NSE", symbol: "RELIANCE", instrumentType: "equity", expiry: null, strike: null, optionType: null }, "unsupported_underlying"],
      [{ market: "BSE", symbol: "NIFTY", instrumentType: "future", expiry: "2026-11-26", strike: null, optionType: null }, "market_mismatch"],
      [{ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2027-06-24", strike: null, optionType: null }, "not_listed"],
    ] as const) expect(resolveQuery(cat, q)).toEqual({ ok: false, reason: why });
  });
});

describe("quote, last-price and option adapters over REST", () => {
  it("serve validated quotes whose asOf is the UPSTREAM time", async () => {
    const src = await rest();
    const qp = kiteQuoteProvider(cat, src);
    const f = await qp.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2026-11-26", strike: null, optionType: null });
    expect(f).toEqual({ bid: 24399.9, ask: 24400.1, last: 24400, volume: 1234500, avgVolume: null, openInterest: 15432000, bidDepth: 150, askDepth: 300, asOf: "2026-11-02T10:15:56.000Z" });
    expect(quoteProblem(f)).toBeNull();
    const idx = await qp.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "equity", expiry: null, strike: null, optionType: null });
    expect(idx).toMatchObject({ bid: null, ask: null, volume: null, openInterest: null, last: 24350.5 });
    expect(qp.name).toBe("kite-rest");
  });
  it("return null WITH a recorded reason: missing, limited (no upstream timestamp), invalid, out of scope, unlisted, wrong market", async () => {
    const src = await rest({
      drop: ["NFO:BANKNIFTY26NOVFUT"],
      edit: (d) => { delete d["NFO:NIFTY26NOVFUT"].timestamp; d["BFO:SENSEX26NOVFUT"].last_price = -5; d["NFO:NIFTY26NOV24000CE"].depth = { buy: [{ price: 413.5, quantity: 1, orders: 1 }], sell: [{ price: 413, quantity: 1, orders: 1 }] }; },
    });
    const qp = kiteQuoteProvider(cat, src);
    const q = (market: string, symbol: string, type: "future" | "option" | "equity", expiry: string | null = "2026-11-26", strike: number | null = null, optionType: "CE" | "PE" | null = null) => qp.quote({ market, symbol, instrumentType: type, expiry, strike, optionType });
    expect(await q("NSE", "BANKNIFTY", "future")).toBeNull();
    expect(await q("NSE", "NIFTY", "future")).toBeNull();
    expect(await q("BSE", "SENSEX", "future")).toBeNull();
    expect(await q("NSE", "NIFTY", "option", "2026-11-26", 24000, "CE")).toBeNull();
    expect(await q("NSE", "RELIANCE", "equity", null)).toBeNull();
    expect(await q("NSE", "NIFTY", "future", "2027-06-24")).toBeNull();
    expect(await q("BSE", "NIFTY", "future")).toBeNull();
    expect(Object.fromEntries(qp.diagnostics.list().map((d) => [d.key, d.reason]))).toEqual({
      "NSE:BANKNIFTY:2026-11-26": "missing_in_response", "NSE:NIFTY:2026-11-26": "no_upstream_timestamp", "BSE:SENSEX:2026-11-26": "bad_last_price",
      "NSE:NIFTY:2026-11-26:24000:CE": "quote_crossed", "NSE:RELIANCE": "unsupported_underlying", "NSE:NIFTY:2027-06-24": "not_listed", "BSE:NIFTY:2026-11-26": "market_mismatch",
    });
  });
  it("fetch time never refreshes data: the same batch becomes unusable as the clock moves, and a stale quote is refused", async () => {
    const young = await rest({ now: NOW_MS });
    const old = await rest({ now: NOW_MS + 5 * 60_000 }); // same response, read 5 minutes later
    const q = { market: "NSE", symbol: "NIFTY", instrumentType: "future" as const, expiry: "2026-11-26", strike: null, optionType: null };
    expect(await kiteQuoteProvider(cat, young).quote(q)).not.toBeNull();
    const p = kiteQuoteProvider(cat, old);
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("stale");
    const ancient = await rest({ edit: (d) => { d["NFO:NIFTY26NOVFUT"].timestamp = "2026-10-30 15:29:59"; } });
    expect(await kiteQuoteProvider(cat, ancient).quote(q)).toBeNull();
  });
  it("last price: the index price as of the upstream time; unavailable or non-index inputs are null", async () => {
    const p = kiteLastPriceProvider(cat, await rest());
    expect(await p.price({ market: "NSE", symbol: "NIFTY" })).toEqual({ price: 24350.5, asOf: "2026-11-02T10:15:56.000Z" });
    expect(await p.price({ market: "BSE", symbol: "SENSEX" })).toEqual({ price: 79120.5, asOf: "2026-11-02T10:15:58.000Z" });
    expect(await p.price({ market: "NSE", symbol: "RELIANCE" })).toBeNull();
    const stale = kiteLastPriceProvider(cat, await rest({ maxAgeMs: 1000 }));
    expect(await stale.price({ market: "NSE", symbol: "NIFTY" })).toBeNull();
  });
  it("option quotes: premium, bid/ask, OI, volume from Kite; IV and greeks are null (never derived); the underlying price is attached only when concurrent", async () => {
    const op = kiteOptionsQuoteProvider(cat, await rest(), { underlyingToleranceMs: WIRING.underlyingWindowMs });
    const q = await op.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" });
    expect(q).toEqual({ premium: 412.35, bid: 412, ask: 413, iv: null, ivPrevious: null, delta: null, gamma: null, theta: null, vega: null, openInterest: 1250000, volume: 52000, underlyingPrice: 24350.5, asOf: "2026-11-02T10:15:56.000Z" });
    expect(optionQuoteProblem(q, "CE")).toBeNull();
    const skewed = kiteOptionsQuoteProvider(cat, await rest({ edit: (d) => { d["NSE:NIFTY 50"].timestamp = "2026-11-02 15:44:00"; } }), { underlyingToleranceMs: WIRING.underlyingWindowMs });
    expect((await skewed.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" }))?.underlyingPrice).toBeNull();
    expect(await op.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2026-11-26", strike: null, optionType: null })).toBeNull();
    expect(op.diagnostics.list()).toEqual([{ key: "NSE:NIFTY:2026-11-26:NULL:NULL", reason: "not_an_option" }]);
  });
  it("option chain: listed contracts only, volume/OI from Kite, IV null, asOf = the OLDEST row; all-or-nothing", async () => {
    const cp = kiteOptionsChainProvider(cat, await rest({ edit: (d) => { d["NFO:NIFTY26NOV24000PE"].timestamp = "2026-11-02 15:45:30"; } }), { strikesEachSide: WIRING.chainStrikesEachSide });
    const c = await cp.chain({ market: "NSE", underlying: "NIFTY", expiry: "2026-11-26" });
    expect(c).toEqual({ underlyingPrice: 24350.5, asOf: "2026-11-02T10:15:30.000Z", rows: [{ strike: 24000, optionType: "CE", iv: null, openInterest: 1250000, volume: 52000 }, { strike: 24000, optionType: "PE", iv: null, openInterest: 1800000, volume: 91000 }] });
    expect(chainProblem(c)).toBeNull();
    const holey = kiteOptionsChainProvider(cat, await rest({ drop: ["NFO:NIFTY26NOV24000PE"] }), { strikesEachSide: WIRING.chainStrikesEachSide });
    expect(await holey.chain({ market: "NSE", underlying: "NIFTY", expiry: "2026-11-26" })).toBeNull();
    expect(holey.diagnostics.list()[0]?.reason).toBe("row_missing_in_response");
    expect(await cp.chain({ market: "NSE", underlying: "NIFTY", expiry: "2027-06-24" })).toBeNull();
    expect(cp.diagnostics.list().some((d) => d.reason === "expiry_not_listed")).toBe(true);
    const noSpot = kiteOptionsChainProvider(cat, await rest({ drop: ["NSE:NIFTY 50"] }), { strikesEachSide: WIRING.chainStrikesEachSide });
    expect(await noSpot.chain({ market: "NSE", underlying: "NIFTY", expiry: "2026-11-26" })).toBeNull();
    expect(await cp.chain({ market: "NSE", underlying: "FINNIFTY", expiry: "2026-11-26" })).toBeNull();
  });
});

describe("historical OHLC adapter (as-of semantics)", () => {
  const raw = (rows: unknown[], over: Partial<RawCandles> = {}): RawCandles => ({ instrument: nifty, interval: "day", candles: rows, fetchedAt: "2026-11-02T10:16:00.000Z", withOi: false, ...over });
  const rows = [["2026-10-28T00:00:00+0530", 24000, 24100, 23900, 24050, 0], ["2026-10-29T00:00:00+0530", 24050, 24200, 24000, 24150, 0], ["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]];
  const series = (over: Partial<RawCandles> = {}) => { const m = mapCandles(raw(rows, over)); if (!m.ok) throw new Error(m.reason); return new Map([["NSE:NIFTY", m.value]]); };
  it("old bars are valid history (no age check); `to` and `limit` apply; asOf is the fetch time, not a claim about the bars", async () => {
    const p = kiteOhlcProvider(series({ fetchedAt: "2026-11-03T04:00:00.000Z" })); // the last bar is closed by then
    const s = await p.candles({ market: "NSE", symbol: "NIFTY", limit: 10, to: "2030-01-01T00:00:00.000Z" });
    expect(s?.bars).toHaveLength(4);
    expect(s?.bars[0]?.t).toBe("2026-10-28T00:00:00+05:30");
    expect((await p.candles({ market: "NSE", symbol: "NIFTY", limit: 2, to: "2026-10-29T12:00:00.000Z" }))?.bars.map((b) => b.t)).toEqual(["2026-10-28T00:00:00+05:30", "2026-10-29T00:00:00+05:30"]);
    expect(p.asOf).toBe("2026-11-03T04:00:00.000Z");
    expect(await p.candles({ market: "NSE", symbol: "BANKNIFTY", limit: 5, to: "2030-01-01T00:00:00.000Z" })).toBeNull();
    expect(p.diagnostics.list()).toEqual([{ key: "NSE:BANKNIFTY", reason: "no_series" }]);
  });
  it("a possibly still-forming last bar is withheld by default (and reported) and can be included explicitly", async () => {
    const withheld = kiteOhlcProvider(series());
    expect((await withheld.candles({ market: "NSE", symbol: "NIFTY", limit: 10, to: "2030-01-01T00:00:00.000Z" }))?.bars.map((b) => b.t.slice(0, 10))).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(withheld.diagnostics.list()).toEqual([{ key: "NSE:NIFTY", reason: "open_bar_withheld" }]);
    const incl = kiteOhlcProvider(series(), { includeOpenBar: true });
    expect((await incl.candles({ market: "NSE", symbol: "NIFTY", limit: 10, to: "2030-01-01T00:00:00.000Z" }))?.bars).toHaveLength(4);
  });
});

describe("explicit source selection (no fallback)", () => {
  it("returns exactly the requested source or throws; a failed/stale REST source is NOT silently replaced by a fresh WebSocket one", async () => {
    const staleRest = await rest({ maxAgeMs: 1000 });
    const ws: QuoteSource = { kind: "websocket", name: "kite-websocket", read: () => ({ status: "usable", source: "websocket", quote: { bid: 1, ask: 2, last: 1.5, volume: 1, avgVolume: null, openInterest: null, bidDepth: 1, askDepth: 1, asOf: "2026-11-02T10:15:59.000Z" }, upstreamTimestamp: "2026-11-02T10:15:59.000Z", lastTradeTime: null, ageMs: 1000 }) };
    expect(chooseSource("rest", { rest: staleRest, websocket: ws })).toBe(staleRest);
    expect(chooseSource("websocket", { rest: staleRest, websocket: ws })).toBe(ws);
    expect(() => chooseSource("websocket", { rest: staleRest })).toThrow();
    const p = kiteQuoteProvider(cat, chooseSource("rest", { rest: staleRest, websocket: ws }));
    expect(await p.quote({ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2026-11-26", strike: null, optionType: null })).toBeNull();
  });
});

// ───────────── WebSocket source ─────────────
const fx = JSON.parse(readFileSync(new URL("../../fixtures/kite/ws-frames.json", import.meta.url), "utf8")) as { now_epoch: number; frames: Record<string, string> };
const frame = (n: string): Uint8Array => Uint8Array.from(Buffer.from(fx.frames[n] as string, "hex"));
class Timers implements TickerTimers {
  t = fx.now_epoch * 1000; private id = 0; private p: Array<{ id: number; at: number; fn: () => void }> = [];
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.id; this.p.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown): void { this.p = this.p.filter((x) => x.id !== h); }
  async advance(ms: number): Promise<void> { const end = this.t + ms; for (;;) { const n = this.p.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!n) break; this.p = this.p.filter((x) => x !== n); this.t = Math.max(this.t, n.at); n.fn(); await Promise.resolve(); } this.t = end; }
}
class Sock implements WsConnection {
  h: { o?: () => void; m?: (d: string | Uint8Array) => void; c?: (n: number) => void } = {};
  onOpen(cb: () => void): void { this.h.o = cb; } onMessage(cb: (d: string | Uint8Array) => void): void { this.h.m = cb; } onClose(cb: (n: number) => void): void { this.h.c = cb; } onError(): void { /* unused */ }
  send(): void { /* unused */ } close(): void { /* unused */ }
}
function wsRig() {
  const timers = new Timers();
  const socks: Sock[] = [];
  const session = new Session(); session.setToken(ACCESS_TOKEN);
  const ticker = new KiteTicker({ plan: "connect", apiKey: API_KEY, session, catalog: cat, timers, factory: () => { const s = new Sock(); socks.push(s); return s; }, inactivityMs: 3_600_000, baseBackoffMs: 1000 });
  ticker.subscribe([niftyFut, nifty], "full");
  ticker.start();
  const sock = (): Sock => socks[socks.length - 1] as Sock;
  sock().h.o?.();
  return { ticker, timers, sock, socks };
}
describe("WebSocket source", () => {
  const q = { market: "NSE", symbol: "NIFTY", instrumentType: "future" as const, expiry: "2026-11-26", strike: null, optionType: null };
  it("serves a fresh validated tick; limited, stale, heartbeat-only, disconnected and reconnected-but-unrefreshed states are all unusable", async () => {
    const r = wsRig();
    const p = kiteQuoteProvider(cat, websocketSource(r.ticker, { maxAgeMs: 30_000 }));
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("no_data");
    r.sock().h.m?.(frame("fut_ltp")); // no exchange timestamp
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("limited");
    r.sock().h.m?.(frame("fut_full"));
    expect(await p.quote(q)).toMatchObject({ last: 24400, bid: 24399.9, openInterest: 15432000, asOf: "2026-11-02T10:15:56.000Z" });
    expect(p.name).toBe("kite-websocket");
    for (let i = 0; i < 4; i++) { await r.timers.advance(10_000); r.sock().h.m?.(frame("heartbeat")); }
    expect(await p.quote(q)).toBeNull(); // 40 s old: heartbeats did not refresh it
    expect(p.diagnostics.list()[0]?.reason).toBe("stale");
    r.sock().h.c?.(1006);
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("disconnected");
    await r.timers.advance(1000);
    r.sock().h.o?.(); // reconnected and resubscribed, but no new upstream tick yet
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("stale");
    r.sock().h.m?.(frame("fut_full_newer")); // a newer tick is stored, but its own upstream time is 43 s old: still not fresh
    expect(r.ticker.get(9000001)?.validated?.quote.last).toBe(24410);
    expect(await p.quote(q)).toBeNull();
    expect(p.diagnostics.list()[0]?.reason).toBe("stale");
  });
  it("the WebSocket source feeds the same last-price and option adapters", async () => {
    const r = wsRig();
    r.sock().h.m?.(frame("index_full"));
    const lp = kiteLastPriceProvider(cat, websocketSource(r.ticker, { maxAgeMs: 30_000 }));
    expect(await lp.price({ market: "NSE", symbol: "NIFTY" })).toEqual({ price: 24350.5, asOf: "2026-11-02T10:15:56.000Z" });
  });
});
