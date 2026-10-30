import { AgentContractError } from "../contract";
import type { HistoricalDataProvider } from "@twins/historical";
import { isoInstant, readJsonFile } from "./newsProviders";

/**
 * OHLC and last-price providers (Stage 5 / Task 5): INJECTABLE interfaces for the Technical Structure and Price-Action agents. No external API is integrated; the shipped implementations are
 * in-memory (tests), file-based over a pre-exported snapshot, and a read-only adapter over the historical datasets (equity price series). A provider returns `null` for what it does not
 * cover, throws on failure, and the agents re-validate whatever it returns. Nothing is interpolated or repaired.
 */
export interface Candle {
  /** Start of the bar (ISO with offset). */
  t: string;
  open: number; high: number; low: number; close: number;
  volume: number | null;
}
export interface OhlcSeries { symbol: string; intervalSeconds: number; /** Oldest first. */ bars: Candle[] }
export interface OhlcProvider {
  readonly name: string;
  /** When the snapshot was taken (ISO), or null. */
  readonly asOf: string | null;
  /** The most recent `limit` bars at or before `to`, or null when the provider has nothing for the symbol. */
  candles(q: { market: string; symbol: string; limit: number; to: string }): Promise<OhlcSeries | null>;
}
export interface LastPrice { price: number; asOf: string }
export interface LastPriceProvider {
  readonly name: string;
  price(q: { market: string; symbol: string }): Promise<LastPrice | null>;
}

const up = (s: string): string => s.trim().toUpperCase();
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_OHLC_DATA", `${kind}: ${what}`); };

/** Structural validation of a candle series (used at file load and again by the agents on whatever a provider returns). Returns an error code or null. */
export function ohlcProblem(s: OhlcSeries | null): string | null {
  if (!s || typeof s !== "object" || !Array.isArray(s.bars) || !Number.isInteger(s.intervalSeconds) || s.intervalSeconds < 1 || s.intervalSeconds > 7 * 86_400) return "series";
  let prev = -Infinity;
  for (const b of s.bars) {
    if (!b || typeof b.t !== "string" || isoInstant(b.t) === null) return "time";
    const ms = Date.parse(b.t);
    if (ms <= prev) return "order";
    prev = ms;
    if (![b.open, b.high, b.low, b.close].every((x) => fin(x) && x > 0) || b.high < b.low || b.high < b.open || b.high < b.close || b.low > b.open || b.low > b.close) return "ohlc";
    if (b.volume !== null && (!fin(b.volume) || b.volume < 0)) return "volume";
  }
  return null;
}
export function memoryOhlcProvider(o: { name?: string; asOf?: string | null; series: Record<string, OhlcSeries> }): OhlcProvider {
  const m = new Map(Object.entries(o.series).map(([k, v]) => [k.toUpperCase(), v]));
  return {
    name: o.name ?? "memory-ohlc", asOf: o.asOf === undefined ? null : o.asOf,
    async candles(q) {
      const s = m.get(`${up(q.market)}:${up(q.symbol)}`);
      if (!s) return null;
      if (ohlcProblem(s) !== null) return s; // malformed series are passed through so the agent can see (and reject) them
      return { ...s, bars: s.bars.filter((b) => Date.parse(b.t) <= Date.parse(q.to)).slice(-q.limit) };
    },
  };
}
export function memoryLastPrice(o: { name?: string; prices: Record<string, LastPrice> }): LastPriceProvider {
  const m = new Map(Object.entries(o.prices).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-prices", price: async (q) => m.get(`${up(q.market)}:${up(q.symbol)}`) ?? null };
}

export const OHLC_FORMAT = "twins-ohlc-v1";
export const LAST_PRICE_FORMAT = "twins-last-price-v1";
const srcName = (r: Record<string, unknown>): string => (typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file");
/**
 * `twins-ohlc-v1` (JSON): { "format", "source", "as_of": "<ISO>", "series": { "NSE:NIFTY": { "interval_seconds": 86400, "bars": [ { "t": "<ISO with offset>", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100 (optional) } ] } } }
 * Strict (like the historical bar datasets): non-finite or non-positive prices, high < low, open / close outside the range, unsorted or duplicate times and times without an offset are rejected at load.
 */
export function parseOhlcFile(raw: unknown): OhlcProvider {
  const k = "ohlc file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== OHLC_FORMAT) bad(k, "unsupported format");
  const asOf = isoInstant(r["as_of"]) ?? bad(k, "as_of must be an ISO instant with an offset");
  const src = r["series"];
  if (typeof src !== "object" || src === null || Array.isArray(src) || Object.keys(src).length === 0) return bad(k, "series must be an object");
  const series: Record<string, OhlcSeries> = {};
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    const o = v as Record<string, unknown> | null;
    if (!/^[A-Z0-9]{2,20}:[A-Z0-9&._-]{1,30}$/.test(key) || !o || !Array.isArray(o["bars"]) || o["bars"].length > 200_000) return bad(k, `series key ${key.slice(0, 40)}`);
    const s: OhlcSeries = { symbol: key.split(":")[1] as string, intervalSeconds: o["interval_seconds"] as number, bars: (o["bars"] as Array<Record<string, unknown>>).map((b) => ({ t: b?.["t"] as string, open: b?.["o"] as number, high: b?.["h"] as number, low: b?.["l"] as number, close: b?.["c"] as number, volume: (b?.["v"] ?? null) as number | null })) };
    const p = ohlcProblem(s);
    if (p !== null) bad(k, `${key}: invalid ${p}`);
    s.bars = s.bars.map((b) => ({ ...b, t: new Date(b.t.replace(" ", "T")).toISOString() }));
    series[key] = s;
  }
  return memoryOhlcProvider({ name: srcName(r), asOf, series });
}
/** `twins-last-price-v1` (JSON): { "format", "source", "as_of", "prices": { "NSE:NIFTY": { "price": 24500, "as_of": "<ISO>" } } } */
export function parseLastPriceFile(raw: unknown): LastPriceProvider {
  const k = "last price file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== LAST_PRICE_FORMAT) bad(k, "unsupported format");
  if (isoInstant(r["as_of"]) === null) bad(k, "as_of must be an ISO instant with an offset");
  const src = r["prices"];
  if (typeof src !== "object" || src === null || Array.isArray(src)) return bad(k, "prices must be an object");
  const prices: Record<string, LastPrice> = {};
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    const o = v as Record<string, unknown> | null;
    const asOf = o ? isoInstant(o["as_of"]) : null;
    if (!/^[A-Z0-9]{2,20}:[A-Z0-9&._-]{1,30}$/.test(key) || !o || !fin(o["price"]) || o["price"] <= 0 || asOf === null) bad(k, `price ${key.slice(0, 40)}`);
    prices[key] = { price: (o as Record<string, unknown>)["price"] as number, asOf: asOf as string };
  }
  return memoryLastPrice({ name: srcName(r), prices });
}
export const fileOhlcProvider = (path: string): OhlcProvider => parseOhlcFile(readJsonFile(path, "the OHLC file"));
export const fileLastPriceProvider = (path: string): LastPriceProvider => parseLastPriceFile(readJsonFile(path, "the last price file"));

/** Read-only adapter over the imported historical datasets (equity price series only; its snapshot time is the end of the last bar). */
export function historicalOhlcProvider(hp: HistoricalDataProvider): OhlcProvider {
  return {
    name: `historical:${hp.id}`.slice(0, 60), asOf: null,
    async candles(q) {
      const m = hp.findSeries({ kind: "equity_price", symbol: q.symbol, market: q.market });
      if (!m.found) return null;
      const s = m.found.series;
      const bars = s.bars.filter((b) => b.ts.getTime() <= Date.parse(q.to)).slice(-q.limit).map((b) => ({ t: b.ts.toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      return { symbol: up(q.symbol), intervalSeconds: s.intervalSeconds, bars };
    },
  };
}
