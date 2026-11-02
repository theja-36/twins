import type { InstrumentQuote } from "@twins/agents/src/agents/quoteProviders";
import { quoteProblem } from "@twins/agents/src/agents/quoteProviders";
import type { LastPrice } from "@twins/agents/src/agents/ohlcProviders";
import type { KiteClient } from "./client";
import { KiteError } from "./errors";
import type { KiteInstrument } from "./instruments";
import { parseQuoteTimestamp } from "./timestamps";

/** Failure reasons are fixed codes (never response content). */
export type Mapped<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export const instrumentKey = (i: Pick<KiteInstrument, "exchange" | "tradingSymbol">): string => `${i.exchange}:${i.tradingSymbol}`;

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Per-instrument outcome of a batch request. `missing` = requested, absent from the response (Kite omits unknown/unsubscribed instruments silently). */
export type BatchEntry<T> = { instrument: KiteInstrument; status: "ok"; raw: T } | { instrument: KiteInstrument; status: "missing" } | { instrument: KiteInstrument; status: "invalid"; reason: string };
export interface Batch<T> {
  /** The LOCAL clock when the response was received. This is NOT an upstream timestamp and says nothing about how old the data is. */
  fetchedAt: string;
  entries: Array<BatchEntry<T>>;
  /** Keys that came back without being requested; ignored, but reported. */
  unexpectedKeys: string[];
}

export const MAX_FULL_QUOTES = 500; // documented per-request limits
export const MAX_LIGHT_QUOTES = 1000;

async function batch<T>(client: KiteClient, path: string, limit: number, instruments: readonly KiteInstrument[], now: () => Date, check: (i: KiteInstrument, v: Record<string, unknown>) => Mapped<T>): Promise<Batch<T>> {
  const seen = new Set<string>();
  for (const i of instruments) { const k = instrumentKey(i); if (seen.has(k)) throw new KiteError("INVALID_REQUEST"); seen.add(k); }
  const entries: Array<BatchEntry<T>> = [];
  const unexpected = new Set<string>();
  let fetchedAt = now().toISOString();
  for (let at = 0; at < instruments.length; at += limit) {
    const chunk = instruments.slice(at, at + limit);
    const data = rec(await client.getJson(path, { i: chunk.map(instrumentKey) }));
    fetchedAt = now().toISOString();
    if (!data) throw new KiteError("MALFORMED_RESPONSE");
    const wanted = new Set(chunk.map(instrumentKey));
    for (const key of Object.keys(data)) if (!wanted.has(key)) unexpected.add(key);
    for (const instrument of chunk) {
      const value = data[instrumentKey(instrument)];
      if (value === undefined || value === null) { entries.push({ instrument, status: "missing" }); continue; }
      const r = rec(value);
      if (!r) { entries.push({ instrument, status: "invalid", reason: "not_an_object" }); continue; }
      if (r["instrument_token"] !== undefined && r["instrument_token"] !== instrument.token) { entries.push({ instrument, status: "invalid", reason: "token_mismatch" }); continue; }
      const checked = check(instrument, r);
      entries.push(checked.ok ? { instrument, status: "ok", raw: checked.value } : { instrument, status: "invalid", reason: checked.reason });
    }
  }
  return { fetchedAt, entries, unexpectedKeys: [...unexpected].sort() };
}

// ───────────────────────────── full quote ─────────────────────────────

export interface RawFullQuote { raw: Record<string, unknown> }
export const getFullQuotes = (client: KiteClient, instruments: readonly KiteInstrument[], now: () => Date = () => new Date()): Promise<Batch<RawFullQuote>> =>
  batch(client, "/quote", MAX_FULL_QUOTES, instruments, now, (_i, v) => ({ ok: true, value: { raw: v } }));

export interface MappedQuote {
  quote: InstrumentQuote;
  /** Upstream quote time (== quote.asOf). */
  upstreamTimestamp: string;
  /** Upstream time of the last trade, when reported; may be much older than the quote time. */
  lastTradeTime: string | null;
  fetchedAt: string;
  /** fetchedAt - upstreamTimestamp in ms. Large = stale data, however recently it was fetched. Negative = upstream clock ahead of ours. */
  ageMs: number;
}

/** Skew tolerated before an upstream timestamp ahead of the local clock is treated as invalid. */
export const MAX_FUTURE_SKEW_MS = 120_000;

/**
 * Pure. `asOf` is the UPSTREAM `timestamp` only: a quote without one cannot be mapped (the fetch time is never substituted). Nothing is invented:
 * empty depth levels (price 0) and an absent `oi` become null, `avgVolume` is always null (Kite's quote has no average volume; `average_price` is a price),
 * and an INDEX never carries volume, open interest or depth (those only apply to traded instruments).
 */
export function mapFullQuote(instrument: KiteInstrument, entry: RawFullQuote, fetchedAt: string): Mapped<MappedQuote> {
  const r = entry.raw;
  const asOf = parseQuoteTimestamp(r["timestamp"]);
  if (asOf === null) return fail("no_upstream_timestamp");
  const ageMs = Date.parse(fetchedAt) - Date.parse(asOf);
  if (ageMs < -MAX_FUTURE_SKEW_MS) return fail("timestamp_in_future");
  const last = price(r["last_price"]);
  if (last === "bad") return fail("bad_last_price");
  const index = instrument.kind === "index";
  let bid: number | null = null, ask: number | null = null, bidDepth: number | null = null, askDepth: number | null = null;
  if (!index && r["depth"] !== undefined) {
    const depth = rec(r["depth"]);
    if (!depth) return fail("bad_depth");
    const top = (side: unknown): Mapped<{ price: number | null; qty: number | null }> => {
      if (side === undefined || side === null) return { ok: true, value: { price: null, qty: null } };
      if (!Array.isArray(side)) return fail("bad_depth");
      const first = rec(side[0]);
      if (!first) return { ok: true, value: { price: null, qty: null } };
      const p = price(first["price"]);
      if (p === "bad") return fail("bad_depth");
      if (p === null) return { ok: true, value: { price: null, qty: null } }; // price 0 = no resting order at this level, not a price of zero
      if (!isNum(first["quantity"]) || first["quantity"] < 0) return fail("bad_depth");
      return { ok: true, value: { price: p, qty: first["quantity"] } };
    };
    const b = top(depth["buy"]); const a = top(depth["sell"]);
    if (!b.ok || !a.ok) return fail("bad_depth");
    bid = b.value.price; bidDepth = b.value.qty; ask = a.value.price; askDepth = a.value.qty;
  }
  let volume: number | null = null;
  let openInterest: number | null = null;
  if (!index) {
    const v = r["volume"] ?? r["volume_traded"];
    if (v !== undefined && v !== null) { if (!isNum(v) || v < 0) return fail("bad_volume"); volume = v; }
    if ((instrument.kind === "future" || instrument.kind === "option") && r["oi"] !== undefined && r["oi"] !== null) { if (!isNum(r["oi"]) || r["oi"] < 0) return fail("bad_oi"); openInterest = r["oi"]; }
  }
  let lastTradeTime: string | null = null;
  if (r["last_trade_time"] !== undefined && r["last_trade_time"] !== null) lastTradeTime = parseQuoteTimestamp(r["last_trade_time"]); // unparsable -> null, never guessed
  const quote: InstrumentQuote = { bid, ask, last, volume, avgVolume: null, openInterest, bidDepth, askDepth, asOf };
  const problem = quoteProblem(quote); // the existing validator, unchanged
  if (problem) return fail(`quote_${problem}`);
  return { ok: true, value: { quote, upstreamTimestamp: asOf, lastTradeTime, fetchedAt, ageMs } };
}

/** A price field: >0 -> number, 0/null/absent -> null ("no price"), anything else -> "bad". */
function price(v: unknown): number | null | "bad" {
  if (v === undefined || v === null) return null;
  if (!isNum(v) || v < 0) return "bad";
  return v === 0 ? null : v;
}

/** LastPrice from a FULL quote only: the price is as of the upstream quote time. (The LTP endpoint has no timestamp; see getLtp.) */
export function mapLastPriceFromFullQuote(instrument: KiteInstrument, entry: RawFullQuote, fetchedAt: string): Mapped<LastPrice & { fetchedAt: string; ageMs: number }> {
  const q = mapFullQuote(instrument, entry, fetchedAt);
  if (!q.ok) return q;
  if (q.value.quote.last === null) return fail("no_last_price");
  return { ok: true, value: { price: q.value.quote.last, asOf: q.value.quote.asOf, fetchedAt, ageMs: q.value.ageMs } };
}

// ───────────────────────────── LTP and day OHLC (limited: no upstream timestamp) ─────────────────────────────

/** `asOf` is deliberately absent: /quote/ltp carries no upstream timestamp, so this CANNOT satisfy the LastPrice contract. */
export interface LimitedLastPrice { price: number; upstreamTimestamp: null; fetchedAt: string }
export async function getLtp(client: KiteClient, instruments: readonly KiteInstrument[], now: () => Date = () => new Date()): Promise<Batch<{ price: number }>> {
  return batch(client, "/quote/ltp", MAX_LIGHT_QUOTES, instruments, now, (_i, v) => {
    const p = price(v["last_price"]);
    return p === null || p === "bad" ? fail("bad_last_price") : { ok: true, value: { price: p } };
  });
}
export const toLimitedLastPrice = (raw: { price: number }, fetchedAt: string): LimitedLastPrice => ({ price: raw.price, upstreamTimestamp: null, fetchedAt });
/** Explicit refusal to pretend an LTP reading is a LastPrice. */
export const lastPriceFromLtp = (): Mapped<LastPrice> => fail("no_upstream_timestamp");

/** The SESSION's OHLC for today (not a candle series): no timestamp, so it cannot become an OhlcSeries. */
export interface DayOhlc { open: number; high: number; low: number; close: number; last: number | null }
export async function getDayOhlc(client: KiteClient, instruments: readonly KiteInstrument[], now: () => Date = () => new Date()): Promise<Batch<DayOhlc>> {
  return batch(client, "/quote/ohlc", MAX_LIGHT_QUOTES, instruments, now, (_i, v) => {
    const o = rec(v["ohlc"]);
    if (!o) return fail("no_ohlc");
    const nums = [o["open"], o["high"], o["low"], o["close"]];
    if (!nums.every((x): x is number => isNum(x) && x > 0)) return fail("bad_ohlc"); // 0 = not yet traded today / not applicable: not a price
    const [op = 0, hi = 0, lo = 0, cl = 0] = nums as number[];
    if (hi < lo || hi < op || hi < cl || lo > op || lo > cl) return fail("bad_ohlc");
    const last = price(v["last_price"]);
    return { ok: true, value: { open: op, high: hi, low: lo, close: cl, last: last === "bad" ? null : last } };
  });
}
