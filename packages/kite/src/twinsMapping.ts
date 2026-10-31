import type { InstrumentCatalog, KiteInstrument, KiteUnderlying } from "./instruments";

/** TWINS keys an underlying by the market of its SPOT: NIFTY and BANKNIFTY trade on NSE, SENSEX on BSE (their derivatives are NFO / BFO at Kite, but TWINS addresses them by underlying). */
export const UNDERLYING_MARKET: Record<KiteUnderlying, string> = { NIFTY: "NSE", BANKNIFTY: "NSE", SENSEX: "BSE" };

export interface TwinsQuery { market: string; symbol: string; instrumentType: "equity" | "future" | "option"; expiry: string | null; strike: number | null; optionType: "CE" | "PE" | null }

/** `MARKET:UNDERLYING[:EXPIRY[:STRIKE:CE|PE]]` - the same key the agents' `contractKey` builds. An index is the underlying's spot ("NSE:NIFTY"). */
export function twinsKey(i: KiteInstrument): string {
  const base = `${UNDERLYING_MARKET[i.underlying]}:${i.underlying}`;
  if (i.kind === "index") return base;
  if (i.kind === "future") return `${base}:${i.expiry}`;
  return `${base}:${i.expiry}:${i.strike}:${i.optionType}`;
}
export const spotKey = (u: KiteUnderlying): string => `${UNDERLYING_MARKET[u]}:${u}`;

export type ResolveResult = { ok: true; instrument: KiteInstrument } | { ok: false; reason: "unsupported_underlying" | "market_mismatch" | "not_listed" | "bad_query" };

/** Maps a TWINS query onto a catalog-listed instrument. Out-of-scope underlyings, a wrong market and unlisted contracts are explicit non-matches (never guessed). */
export function resolveQuery(catalog: InstrumentCatalog, q: Pick<TwinsQuery, "market" | "symbol" | "instrumentType" | "expiry" | "strike" | "optionType">): ResolveResult {
  const symbol = q.symbol.trim().toUpperCase();
  if (!catalog.underlyingKnown(symbol)) return { ok: false, reason: "unsupported_underlying" };
  const u = symbol as KiteUnderlying;
  if (q.market.trim().toUpperCase() !== UNDERLYING_MARKET[u]) return { ok: false, reason: "market_mismatch" };
  const hit = q.instrumentType === "equity"
    ? catalog.lookup({ underlying: u, kind: "index" })
    : q.instrumentType === "future"
      ? catalog.lookup({ underlying: u, kind: "future", expiry: q.expiry })
      : q.instrumentType === "option"
        ? catalog.lookup({ underlying: u, kind: "option", expiry: q.expiry, strike: q.strike, optionType: q.optionType })
        : undefined;
  if (hit === undefined) return { ok: false, reason: "bad_query" };
  return hit ? { ok: true, instrument: hit } : { ok: false, reason: "not_listed" };
}
