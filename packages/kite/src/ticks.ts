import { quoteProblem, type InstrumentQuote } from "@twins/agents/src/agents/quoteProviders";
import type { KiteInstrument } from "./instruments";
import { MAX_FUTURE_SKEW_MS } from "./marketData";

/**
 * Strict decoder for Kite's binary WebSocket frames (big-endian). Layouts follow the public protocol description:
 *   frame  = int16 packetCount, then per packet: int16 length + bytes;   a 1-byte frame is a heartbeat
 *   LTP    8   token, last
 *   index  28  token, last, high, low, open, close, change              32 = the same + exchange timestamp @28
 *   trade  44  token, last, lastQty, avg, volume, buyQty, sellQty, open, high, low, close
 *          184 = the 44 bytes + lastTradeTime @44, oi @48, oiHigh @52, oiLow @56, exchangeTime @60, depth @64 (10 x 12 bytes: qty, price, orders(int16), pad)
 * Prices are paise (/100) for every instrument in this package's scope. Byte order and epoch-second timestamps are taken from the published client
 * libraries, NOT from a live feed (unverified). A packet is accepted only if its token is in the instrument catalog AND its length is a valid layout for that
 * instrument's kind (an index never has a 44/184-byte layout; a derivative never a 28/32-byte one).
 */
export type TickLayout = "ltp" | "index_quote" | "index_full" | "quote" | "full";

export interface TickDayOhlc { open: number; high: number; low: number; close: number }
export interface DecodedTick {
  instrument: KiteInstrument;
  layout: TickLayout;
  /** Local receive time (ISO). Distinct from the two upstream times below. */
  receivedAt: string;
  lastPrice: number | null;
  /** Upstream exchange timestamp; null when the layout carries none (or it is 0). Without it the tick is LIMITED and can never be fresh. */
  exchangeTimestamp: string | null;
  /** Upstream time of the last trade (full layout only); may be far older than the exchange timestamp. */
  lastTradeTime: string | null;
  volume: number | null;
  dayOhlc: TickDayOhlc | null;
  /** Only when an exchange timestamp is present AND the existing `quoteProblem` validator accepts it. */
  quote: InstrumentQuote | null;
}

export interface Rejection { reason: string; token?: number }
export interface DecodedFrame {
  heartbeat: boolean;
  ticks: DecodedTick[];
  /** Packet-level rejections inside a well-formed frame. */
  rejected: Rejection[];
  /** Set when the frame structure itself is broken: NO packet of such a frame is used. */
  frameError?: string;
}

export const MAX_PACKETS_PER_FRAME = 4000;
const MIN_EPOCH_MS = Date.UTC(2020, 0, 1);

const PRICE_DIVISOR = 100;

export function decodeFrame(bytes: Uint8Array, resolve: (token: number) => KiteInstrument | undefined, nowMs: number): DecodedFrame {
  const out: DecodedFrame = { heartbeat: false, ticks: [], rejected: [] };
  if (bytes.length === 1) { out.heartbeat = true; return out; }
  if (bytes.length < 2) return { ...out, frameError: "frame_too_short" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0, false);
  if (count > MAX_PACKETS_PER_FRAME) return { ...out, frameError: "too_many_packets" };
  const packets: Uint8Array[] = [];
  let at = 2;
  for (let n = 0; n < count; n++) {
    if (at + 2 > bytes.length) return { ...out, frameError: "truncated_packet" };
    const len = view.getUint16(at, false);
    at += 2;
    if (at + len > bytes.length) return { ...out, frameError: "truncated_packet" };
    packets.push(bytes.subarray(at, at + len));
    at += len;
  }
  if (at !== bytes.length) return { ...out, frameError: "trailing_bytes" };
  const receivedAt = new Date(nowMs).toISOString();
  for (const p of packets) {
    const r = decodePacket(p, resolve, nowMs, receivedAt);
    if ("reason" in r) out.rejected.push(r); else out.ticks.push(r);
  }
  return out;
}

function ts(view: DataView, offset: number, nowMs: number): { ok: true; iso: string | null } | { ok: false; reason: string } {
  const secs = view.getInt32(offset, false);
  if (secs === 0) return { ok: true, iso: null };
  const ms = secs * 1000;
  if (secs < 0 || ms < MIN_EPOCH_MS) return { ok: false, reason: "bad_timestamp" };
  if (ms > nowMs + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "timestamp_in_future" };
  return { ok: true, iso: new Date(ms).toISOString() };
}

function decodePacket(p: Uint8Array, resolve: (token: number) => KiteInstrument | undefined, nowMs: number, receivedAt: string): DecodedTick | Rejection {
  if (p.length < 8) return { reason: "packet_too_short" };
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const token = view.getUint32(0, false);
  const instrument = resolve(token);
  if (!instrument) return { reason: "unsupported_token", token };
  const index = instrument.kind === "index";
  const layout: TickLayout | null = p.length === 8 ? "ltp" : index ? (p.length === 28 ? "index_quote" : p.length === 32 ? "index_full" : null) : p.length === 44 ? "quote" : p.length === 184 ? "full" : null;
  if (!layout) return { reason: "bad_length", token };

  const price = (offset: number): number | null | "bad" => {
    const v = view.getInt32(offset, false);
    return v < 0 ? "bad" : v === 0 ? null : v / PRICE_DIVISOR;
  };
  const last = price(4);
  if (last === "bad") return { reason: "bad_price", token };

  let exchangeTimestamp: string | null = null;
  let lastTradeTime: string | null = null;
  let volume: number | null = null;
  let dayOhlc: TickDayOhlc | null = null;
  let bid: number | null = null, ask: number | null = null, bidDepth: number | null = null, askDepth: number | null = null, openInterest: number | null = null;

  const ohlc = (o: number, h: number, l: number, c: number): TickDayOhlc | null | "bad" => {
    const [op, hi, lo, cl] = [price(o), price(h), price(l), price(c)];
    if (op === "bad" || hi === "bad" || lo === "bad" || cl === "bad") return "bad";
    if (op === null || hi === null || lo === null || cl === null) return null; // not yet traded today: absent, not a price of zero
    return hi < lo || hi < op || hi < cl || lo > op || lo > cl ? "bad" : { open: op, high: hi, low: lo, close: cl };
  };

  if (layout === "index_quote" || layout === "index_full") {
    const d = ohlc(16, 8, 12, 20); // open@16 high@8 low@12 close@20
    if (d === "bad") return { reason: "bad_price", token };
    dayOhlc = d;
    if (layout === "index_full") { const t = ts(view, 28, nowMs); if (!t.ok) return { reason: t.reason, token }; exchangeTimestamp = t.iso; }
  } else if (layout === "quote" || layout === "full") {
    for (const off of [8, 16, 20, 24]) if (view.getInt32(off, false) < 0) return { reason: "bad_quantity", token };
    volume = view.getInt32(16, false);
    const d = ohlc(28, 32, 36, 40);
    if (d === "bad") return { reason: "bad_price", token };
    dayOhlc = d;
    if (layout === "full") {
      const lt = ts(view, 44, nowMs); if (!lt.ok) return { reason: lt.reason, token }; lastTradeTime = lt.iso;
      const et = ts(view, 60, nowMs); if (!et.ok) return { reason: et.reason, token }; exchangeTimestamp = et.iso;
      for (const off of [48, 52, 56]) if (view.getInt32(off, false) < 0) return { reason: "bad_quantity", token };
      if (instrument.kind === "future" || instrument.kind === "option") openInterest = view.getInt32(48, false);
      const level = (n: number): { price: number | null; qty: number | null } | "bad" => {
        const base = 64 + n * 12;
        const qty = view.getInt32(base, false);
        const pr = price(base + 4);
        if (pr === "bad" || qty < 0) return "bad";
        return pr === null ? { price: null, qty: null } : { price: pr, qty }; // an empty level (price 0) is no bid/ask, not a price of zero
      };
      const b = level(0); const a = level(5);
      if (b === "bad" || a === "bad") return { reason: "bad_depth", token };
      bid = b.price; bidDepth = b.qty; ask = a.price; askDepth = a.qty;
    }
  }

  let quote: InstrumentQuote | null = null;
  if (exchangeTimestamp !== null) {
    const full = layout === "full";
    quote = { bid, ask, last, volume: full ? volume : null, avgVolume: null, openInterest, bidDepth, askDepth, asOf: exchangeTimestamp };
    const problem = quoteProblem(quote); // the existing validator, unchanged
    if (problem) return { reason: `quote_${problem}`, token };
  }
  return { instrument, layout, receivedAt, lastPrice: last, exchangeTimestamp, lastTradeTime, volume, dayOhlc, quote };
}
