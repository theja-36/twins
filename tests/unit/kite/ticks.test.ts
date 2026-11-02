import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { quoteProblem } from "../../../packages/agents/src/agents/quoteProviders";
import { decodeFrame, type KiteInstrument } from "../../../packages/kite/src/index";
import { catalog } from "./helpers";

// Frames were built with Python struct.pack (big-endian) from the published layout - independent of the TypeScript decoder. Expected values below are written by hand.
const fx = JSON.parse(readFileSync(new URL("../../fixtures/kite/ws-frames.json", import.meta.url), "utf8")) as { now_epoch: number; frames: Record<string, string> };
const NOW_MS = fx.now_epoch * 1000; // 2026-11-02T10:16:00Z
const bytes = (name: string): Uint8Array => Uint8Array.from(Buffer.from(fx.frames[name] as string, "hex"));
const cat = catalog();
const known = new Map<number, KiteInstrument>(cat.instruments.map((i) => [i.token, i]));
const decode = (b: Uint8Array, now = NOW_MS) => decodeFrame(b, (t) => known.get(t), now);
const ET = "2026-11-02T10:15:56.000Z"; // now - 4 s
const LTT = "2026-11-02T10:15:52.000Z"; // now - 8 s

describe("supported layouts", () => {
  it("8-byte LTP (index and derivative): price only, no timestamp -> limited, no quote", () => {
    const a = decode(bytes("ltp_index"));
    expect(a.frameError).toBeUndefined();
    expect(a.ticks).toHaveLength(1);
    expect(a.ticks[0]).toMatchObject({ layout: "ltp", lastPrice: 24350.5, exchangeTimestamp: null, lastTradeTime: null, quote: null, receivedAt: "2026-11-02T10:16:00.000Z" });
    expect(a.ticks[0]?.instrument.tradingSymbol).toBe("NIFTY 50");
    expect(decode(bytes("fut_ltp")).ticks[0]).toMatchObject({ layout: "ltp", lastPrice: 24400, quote: null });
  });
  it("28-byte index quote: last + day OHLC (high@8 low@12 open@16 close@20), no timestamp -> limited", () => {
    expect(decode(bytes("index_quote")).ticks[0]).toMatchObject({ layout: "index_quote", lastPrice: 24350.5, dayOhlc: { open: 24300, high: 24400, low: 24280, close: 24310 }, exchangeTimestamp: null, quote: null, volume: null });
  });
  it("32-byte index full: adds the exchange timestamp, so a validated quote exists - with no volume, OI or depth", () => {
    const t = decode(bytes("index_full")).ticks[0];
    expect(t).toMatchObject({ layout: "index_full", exchangeTimestamp: ET, lastTradeTime: null });
    expect(t?.quote).toEqual({ bid: null, ask: null, last: 24350.5, volume: null, avgVolume: null, openInterest: null, bidDepth: null, askDepth: null, asOf: ET });
  });
  it("44-byte tradable quote: volume and day OHLC but NO timestamp and no depth -> limited", () => {
    expect(decode(bytes("fut_quote")).ticks[0]).toMatchObject({ layout: "quote", lastPrice: 24400, volume: 1234500, dayOhlc: { open: 24350, high: 24450, low: 24300, close: 24330 }, exchangeTimestamp: null, quote: null });
  });
  it("184-byte tradable full: timestamps, OI and 10-level depth (best bid = level 1, best offer = level 6) -> validated quote", () => {
    const t = decode(bytes("fut_full")).ticks[0];
    expect(t).toMatchObject({ layout: "full", exchangeTimestamp: ET, lastTradeTime: LTT, volume: 1234500 });
    expect(t?.quote).toEqual({ bid: 24399.9, ask: 24400.1, last: 24400, volume: 1234500, avgVolume: null, openInterest: 15432000, bidDepth: 150, askDepth: 300, asOf: ET });
    expect(quoteProblem(t?.quote)).toBeNull();
  });
  it("empty depth levels and untraded OHLC are null (not zero); a real 0 volume/OI stays 0", () => {
    const t = decode(bytes("opt_full_empty_bid")).ticks[0];
    expect(t?.quote).toMatchObject({ bid: null, bidDepth: null, ask: 413, askDepth: 75, last: 412.35, volume: 0, openInterest: 0 });
    expect(t?.dayOhlc).toBeNull();
  });
  it("a multi-packet frame yields every packet in order", () => {
    const f = decode(bytes("multi"));
    expect(f.ticks.map((t) => [t.instrument.tradingSymbol, t.layout])).toEqual([["NIFTY 50", "ltp"], ["NIFTY BANK", "index_full"], ["NIFTY26NOVFUT", "full"]]);
    expect(f.ticks[1]?.quote?.last).toBe(52010);
  });
  it("heartbeat (1 byte) is recognised and carries no data", () => {
    expect(decode(bytes("heartbeat"))).toEqual({ heartbeat: true, ticks: [], rejected: [] });
  });
});

describe("timestamps", () => {
  it("missing (0) exchange timestamp: the packet is accepted only as a LIMITED reading (no quote, no lastTradeTime)", () => {
    const t = decode(bytes("full_no_ts")).ticks[0];
    expect(t).toMatchObject({ layout: "full", exchangeTimestamp: null, lastTradeTime: null, quote: null, lastPrice: 24400 });
  });
  it("an old timestamp is decoded faithfully (it is NOT hidden or refreshed by receipt)", () => {
    const t = decode(bytes("full_old_ts")).ticks[0];
    expect(t?.quote?.asOf).toBe("2026-10-30T10:16:00.000Z");
    expect(t?.receivedAt).toBe("2026-11-02T10:16:00.000Z");
  });
  it("a timestamp from the future is rejected: no usable quote", () => {
    const f = decode(bytes("full_future_ts"));
    expect(f.ticks).toEqual([]);
    expect(f.rejected).toEqual([{ reason: "timestamp_in_future", token: 9000001 }]);
  });
  it("a small clock skew (< 2 min ahead) is tolerated", () => {
    expect(decode(bytes("full_future_ts"), NOW_MS + 3600_000 - 60_000).ticks).toHaveLength(1);
  });
});

describe("rejections never produce a usable quote", () => {
  it("unsupported (not subscribed / out of scope) tokens", () => {
    expect(decode(bytes("unsupported_currency"))).toMatchObject({ ticks: [], rejected: [{ reason: "unsupported_token", token: 8963075 }] });
  });
  it("validator failure: a crossed market", () => {
    expect(decode(bytes("full_crossed"))).toMatchObject({ ticks: [], rejected: [{ reason: "quote_crossed" }] });
  });
  it("kind/length mismatch: an index never has 44/184 layouts, a derivative never 28/32", () => {
    const asIndex = bytes("fut_quote").slice(); // 44-byte packet with the NIFTY 50 token (256265 = 0x0003E909)
    asIndex.set([0x00, 0x03, 0xe9, 0x09], 4);
    expect(decode(asIndex).rejected).toEqual([{ reason: "bad_length", token: 256265 }]);
    const asFut = bytes("index_quote").slice(); // 28-byte packet with the NIFTY future token (9000001 = 0x0089_5441)
    asFut.set([0x00, 0x89, 0x54, 0x41], 4);
    expect(decode(asFut).rejected).toEqual([{ reason: "bad_length", token: 9000001 }]);
  });
  it("odd packet lengths and a too-short packet", () => {
    const odd = bytes("fut_ltp").slice(); // make the declared length 9 and append a byte
    const grown = new Uint8Array(odd.length + 1); grown.set(odd); grown[3] = 9;
    expect(decode(grown).rejected).toEqual([{ reason: "bad_length", token: 9000001 }]);
    const tiny = Uint8Array.from([0, 1, 0, 4, 0, 0, 0, 1]);
    expect(decode(tiny).rejected).toEqual([{ reason: "packet_too_short" }]);
  });
  it("negative or absurd fields: price, quantity, timestamp", () => {
    const neg = bytes("fut_ltp").slice(); neg.set([0xff, 0xff, 0xff, 0xff], 8); // last price = -1
    expect(decode(neg).rejected).toEqual([{ reason: "bad_price", token: 9000001 }]);
    const qty = bytes("fut_full").slice(); qty.set([0xff, 0xff, 0xff, 0xff], 4 + 16); // volume = -1
    expect(decode(qty).rejected).toEqual([{ reason: "bad_quantity", token: 9000001 }]);
    const ancient = bytes("fut_full").slice(); ancient.set([0x00, 0x00, 0x00, 0x05], 4 + 60); // exchange ts = 5 s after 1970
    expect(decode(ancient).rejected).toEqual([{ reason: "bad_timestamp", token: 9000001 }]);
  });
  it("incoherent day OHLC", () => {
    const b = bytes("index_quote").slice(); b.set([0x00, 0x00, 0x00, 0x01], 4 + 8); // high = 0.01 < low
    expect(decode(b).rejected).toEqual([{ reason: "bad_price", token: 256265 }]);
  });
});

describe("broken frames: nothing from them is used", () => {
  const cases: Array<[string, (b: Uint8Array) => Uint8Array, string]> = [
    ["empty", () => new Uint8Array(0), "frame_too_short"],
    ["truncated in a packet", (b) => b.slice(0, b.length - 1), "truncated_packet"],
    ["truncated in a length field", (b) => b.slice(0, 3), "truncated_packet"],
    ["count larger than the packets present", (b) => { const c = b.slice(); c[1] = 4; return c; }, "truncated_packet"],
    ["count smaller than the packets present", (b) => { const c = b.slice(); c[1] = 1; return c; }, "trailing_bytes"],
    ["trailing garbage", (b) => Uint8Array.from([...b, 0]), "trailing_bytes"],
    ["absurd packet count", (b) => { const c = b.slice(); c[0] = 0xff; c[1] = 0xff; return c; }, "too_many_packets"],
  ];
  for (const [name, mutate, expected] of cases) {
    it(name, () => {
      const f = decode(mutate(bytes("multi")));
      expect(f.frameError).toBe(expected);
      expect(f.ticks).toEqual([]);
    });
  }
  it("a declared packet count of 0 is an empty (valid) frame", () => {
    expect(decode(Uint8Array.from([0, 0]))).toEqual({ heartbeat: false, ticks: [], rejected: [] });
  });
  it("one bad packet in a well-formed frame rejects only that packet", () => {
    const f = decode(bytes("multi"), NOW_MS);
    const broken = bytes("multi").slice();
    broken.set([0xff, 0xff, 0xff, 0xff], 4 + 4); // first packet's price
    const g = decode(broken);
    expect(f.ticks).toHaveLength(3);
    expect(g.ticks.map((t) => t.instrument.tradingSymbol)).toEqual(["NIFTY BANK", "NIFTY26NOVFUT"]);
    expect(g.rejected).toEqual([{ reason: "bad_price", token: 256265 }]);
  });
});
