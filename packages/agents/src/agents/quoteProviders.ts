import { AgentContractError } from "../contract";
import { isoInstant, readJsonFile } from "./newsProviders";

/**
 * InstrumentQuote providers (Stage 5 / Task 6): the INJECTABLE interfaces the Liquidity and Options Risk agents use. No external API or broker is integrated; the shipped implementations are
 * in-memory (tests) and file-based over a pre-exported snapshot. A provider never invents data: a contract it does not cover is `null`, a failure throws, and a field it does not know is `null`.
 */
export type QuoteInstrumentType = "equity" | "future" | "option";
export interface QuoteQuery { market: string; symbol: string; instrumentType: QuoteInstrumentType; expiry: string | null; strike: number | null; optionType: "CE" | "PE" | null }
export interface InstrumentQuote {
  bid: number | null; ask: number | null; last: number | null; volume: number | null; avgVolume: number | null; openInterest: number | null;
  /** Quantity displayed at the best bid / ask (depth where the feed provides it). */
  bidDepth: number | null; askDepth: number | null;
  /** When the quote was captured (ISO). */
  asOf: string;
}
export interface QuoteProvider {
  readonly name: string;
  quote(q: QuoteQuery): Promise<InstrumentQuote | null>;
}
export interface OptionQuote {
  /** Last traded premium. */
  premium: number | null; bid: number | null; ask: number | null;
  /** Implied volatility in percent (annualised) and the previous session's value, for the change. */
  iv: number | null; ivPrevious: number | null;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null;
  openInterest: number | null; volume: number | null; underlyingPrice: number | null; asOf: string;
}
export interface OptionsQuoteProvider {
  readonly name: string;
  quote(q: QuoteQuery): Promise<OptionQuote | null>;
}
export interface OptionChainRow { strike: number; optionType: "CE" | "PE"; iv: number | null; openInterest: number | null; volume: number | null }
export interface OptionChain { underlyingPrice: number | null; asOf: string; rows: OptionChainRow[] }
export interface OptionsChainProvider {
  readonly name: string;
  chain(q: { market: string; underlying: string; expiry: string }): Promise<OptionChain | null>;
}

const up = (s: string): string => s.trim().toUpperCase();
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nn = (v: unknown): boolean => v === null || (fin(v) && v >= 0);
const pos = (v: unknown): boolean => v === null || (fin(v) && v > 0);
const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_QUOTE_DATA", `${kind}: ${what}`); };

/** The contract key a provider is looked up by: `MARKET:SYMBOL[:EXPIRY[:STRIKE:CE|PE]]`. */
export function contractKey(q: Pick<QuoteQuery, "market" | "symbol" | "expiry" | "strike" | "optionType">): string {
  return [up(q.market), up(q.symbol), ...(q.expiry ? [q.expiry] : []), ...(q.strike !== null && q.optionType ? [String(q.strike), q.optionType] : [])].join(":");
}
/** Returns the first structural problem of a quote (also used by the agents on whatever a provider returns), or null. Crossed markets are malformed. */
export function quoteProblem(q: unknown): string | null {
  if (typeof q !== "object" || q === null || Array.isArray(q)) return "not an object";
  const o = q as Record<string, unknown>;
  if (!pos(o["bid"]) || !pos(o["ask"]) || !pos(o["last"])) return "price";
  if (!nn(o["volume"]) || !nn(o["avgVolume"]) || !nn(o["openInterest"]) || !nn(o["bidDepth"]) || !nn(o["askDepth"])) return "size";
  if (fin(o["bid"]) && fin(o["ask"]) && o["ask"] < o["bid"]) return "crossed";
  if (typeof o["asOf"] !== "string" || Number.isNaN(Date.parse(o["asOf"]))) return "as_of";
  return null;
}
export function optionQuoteProblem(q: unknown, optionType: "CE" | "PE"): string | null {
  if (typeof q !== "object" || q === null || Array.isArray(q)) return "not an object";
  const o = q as Record<string, unknown>;
  if (!pos(o["premium"]) || !pos(o["bid"]) || !pos(o["ask"]) || !pos(o["iv"]) || !pos(o["ivPrevious"]) || !pos(o["underlyingPrice"])) return "price / volatility";
  if (fin(o["bid"]) && fin(o["ask"]) && o["ask"] < o["bid"]) return "crossed";
  if (!nn(o["openInterest"]) || !nn(o["volume"]) || !nn(o["gamma"]) || !nn(o["vega"])) return "size / greek";
  if (!(o["delta"] === null || (fin(o["delta"]) && Math.abs(o["delta"]) <= 1 && (optionType === "CE" ? o["delta"] >= 0 : o["delta"] <= 0)))) return "delta";
  if (!(o["theta"] === null || fin(o["theta"]))) return "theta";
  if (typeof o["asOf"] !== "string" || Number.isNaN(Date.parse(o["asOf"]))) return "as_of";
  return null;
}
export function chainProblem(c: unknown): string | null {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return "not an object";
  const o = c as Record<string, unknown>;
  if (!pos(o["underlyingPrice"]) || typeof o["asOf"] !== "string" || Number.isNaN(Date.parse(o["asOf"])) || !Array.isArray(o["rows"]) || o["rows"].length > 5000) return "shape";
  for (const r of o["rows"] as unknown[]) {
    const x = r as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || !fin(x["strike"]) || x["strike"] <= 0 || (x["optionType"] !== "CE" && x["optionType"] !== "PE") || !pos(x["iv"]) || !nn(x["openInterest"]) || !nn(x["volume"])) return "row";
  }
  return null;
}

export function memoryQuoteProvider(o: { name?: string; quotes: Record<string, InstrumentQuote> }): QuoteProvider {
  const m = new Map(Object.entries(o.quotes).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-quotes", quote: async (q) => m.get(contractKey(q)) ?? null };
}
export function memoryOptionsQuoteProvider(o: { name?: string; quotes: Record<string, OptionQuote> }): OptionsQuoteProvider {
  const m = new Map(Object.entries(o.quotes).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-option-quotes", quote: async (q) => m.get(contractKey(q)) ?? null };
}
export function memoryOptionsChainProvider(o: { name?: string; chains: Record<string, OptionChain> }): OptionsChainProvider {
  const m = new Map(Object.entries(o.chains).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-option-chains", chain: async (q) => m.get(`${up(q.market)}:${up(q.underlying)}:${q.expiry}`) ?? null };
}

export const INSTRUMENT_QUOTES_FORMAT = "twins-quotes-v1";
export const OPTION_QUOTES_FORMAT = "twins-option-quotes-v1";
export const OPTION_CHAIN_FORMAT = "twins-option-chain-v1";
const KEY = /^[A-Z0-9]{2,20}:[A-Z0-9&._-]{1,30}(?::\d{4}-\d{2}-\d{2}(?::\d{1,7}(?:\.\d{1,4})?:(?:CE|PE))?)?$/;
const srcName = (r: Record<string, unknown>): string => (typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file");
const num = (v: unknown): number | null => (v === undefined || v === null ? null : (v as number));
const head = (raw: unknown, kind: string, format: string): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(kind, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== format) bad(kind, "unsupported format");
  if (isoInstant(r["as_of"]) === null) bad(kind, "as_of must be an ISO instant with an offset");
  return r;
};
const entries = (r: Record<string, unknown>, field: string, kind: string): Array<[string, Record<string, unknown>]> => {
  const src = r[field];
  if (typeof src !== "object" || src === null || Array.isArray(src) || Object.keys(src).length === 0 || Object.keys(src).length > 50_000) return bad(kind, `${field} must be an object`);
  return Object.entries(src as Record<string, Record<string, unknown>>).map(([k, v]) => {
    if (!KEY.test(k) || !v || typeof v !== "object" || Array.isArray(v)) bad(kind, `key ${k.slice(0, 50)}`);
    return [k, v];
  });
};
/**
 * `twins-quotes-v1` (JSON): { "format", "source", "as_of", "quotes": { "NSE:RELIANCE": { "bid": 2500, "ask": 2500.5, "last": 2500.25, "volume": 120000, "avg_volume": 900000, "open_interest": null,
 *   "bid_depth": 4000, "ask_depth": 3500, "as_of": "<ISO with offset>" }, "NSE:NIFTY:2031-10-29": { ... } } }
 * Strict: negative or non-finite numbers, a crossed market and a missing / malformed `as_of` are rejected at load; nothing is repaired.
 */
export function parseInstrumentQuotesFile(raw: unknown): QuoteProvider {
  const k = "quotes file";
  const r = head(raw, k, INSTRUMENT_QUOTES_FORMAT);
  const quotes: Record<string, InstrumentQuote> = {};
  for (const [key, o] of entries(r, "quotes", k)) {
    const asOf = isoInstant(o["as_of"]);
    const q = { bid: num(o["bid"]), ask: num(o["ask"]), last: num(o["last"]), volume: num(o["volume"]), avgVolume: num(o["avg_volume"]), openInterest: num(o["open_interest"]), bidDepth: num(o["bid_depth"]), askDepth: num(o["ask_depth"]), asOf: asOf ?? "" };
    if (asOf === null || quoteProblem(q) !== null) bad(k, `quote ${key}`);
    quotes[key] = q;
  }
  return memoryQuoteProvider({ name: srcName(r), quotes });
}
/** `twins-option-quotes-v1` (JSON): { "format", "source", "as_of", "quotes": { "NSE:NIFTY:2031-10-29:24500:CE": { "premium", "bid", "ask", "iv", "iv_previous", "delta", "gamma", "theta", "vega", "open_interest", "volume", "underlying_price", "as_of" } } } */
export function parseOptionQuotesFile(raw: unknown): OptionsQuoteProvider {
  const k = "option quotes file";
  const r = head(raw, k, OPTION_QUOTES_FORMAT);
  const quotes: Record<string, OptionQuote> = {};
  for (const [key, o] of entries(r, "quotes", k)) {
    const asOf = isoInstant(o["as_of"]);
    const type = key.endsWith(":PE") ? "PE" : key.endsWith(":CE") ? "CE" : null;
    const q: OptionQuote = {
      premium: num(o["premium"]), bid: num(o["bid"]), ask: num(o["ask"]), iv: num(o["iv"]), ivPrevious: num(o["iv_previous"]), delta: num(o["delta"]), gamma: num(o["gamma"]), theta: num(o["theta"]), vega: num(o["vega"]),
      openInterest: num(o["open_interest"]), volume: num(o["volume"]), underlyingPrice: num(o["underlying_price"]), asOf: asOf ?? "",
    };
    if (type === null || asOf === null || optionQuoteProblem(q, type) !== null) bad(k, `quote ${key}`);
    quotes[key] = q;
  }
  return memoryOptionsQuoteProvider({ name: srcName(r), quotes });
}
/** `twins-option-chain-v1` (JSON): { "format", "source", "as_of", "chains": { "NSE:NIFTY:2031-10-29": { "underlying_price": 24500, "as_of", "rows": [ { "strike": 24500, "option_type": "CE", "iv": 14.2, "open_interest": 90000, "volume": 12000 } ] } } } */
export function parseOptionChainFile(raw: unknown): OptionsChainProvider {
  const k = "option chain file";
  const r = head(raw, k, OPTION_CHAIN_FORMAT);
  const chains: Record<string, OptionChain> = {};
  for (const [key, o] of entries(r, "chains", k)) {
    const asOf = isoInstant(o["as_of"]);
    if (!Array.isArray(o["rows"])) bad(k, `chain ${key}`);
    const rows = Array.isArray(o["rows"]) ? (o["rows"] as Array<Record<string, unknown>>).map((x) => ({ strike: x?.["strike"] as number, optionType: x?.["option_type"] as "CE" | "PE", iv: num(x?.["iv"]), openInterest: num(x?.["open_interest"]), volume: num(x?.["volume"]) })) : [];
    const c: OptionChain = { underlyingPrice: num(o["underlying_price"]), asOf: asOf ?? "", rows };
    if (asOf === null || key.split(":").length !== 3 || chainProblem(c) !== null) bad(k, `chain ${key}`);
    chains[key] = c;
  }
  return memoryOptionsChainProvider({ name: srcName(r), chains });
}
export const fileQuoteProvider = (path: string): QuoteProvider => parseInstrumentQuotesFile(readJsonFile(path, "the quotes file"));
export const fileOptionsQuoteProvider = (path: string): OptionsQuoteProvider => parseOptionQuotesFile(readJsonFile(path, "the option quotes file"));
export const fileOptionsChainProvider = (path: string): OptionsChainProvider => parseOptionChainFile(readJsonFile(path, "the option chain file"));
