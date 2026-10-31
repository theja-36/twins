import { chainProblem, optionQuoteProblem, quoteProblem, type OptionChain, type OptionChainRow, type OptionQuote, type OptionsChainProvider, type OptionsQuoteProvider, type QuoteProvider } from "@twins/agents/src/agents/quoteProviders";
import type { LastPriceProvider, OhlcProvider, OhlcSeries } from "@twins/agents/src/agents/ohlcProviders";
import { memoryInstrumentReference, type InstrumentRecord, type InstrumentReference } from "@twins/agents/src/agents/instrumentReference";
import type { MappedCandles } from "./historical";
import type { InstrumentCatalog, KiteInstrument, KiteUnderlying } from "./instruments";
import type { QuoteSource, Reading } from "./quoteBook";
import { resolveQuery, spotKey, twinsKey, UNDERLYING_MARKET } from "./twinsMapping";

/** Why an adapter returned null, per contract key (bounded, fixed codes). Nothing is hidden: a null always has an entry here. */
export class Diagnostics {
  private readonly items = new Map<string, string>();
  record(key: string, reason: string): void { if (this.items.size < 500 || this.items.has(key)) this.items.set(key, reason); }
  list(): Array<{ key: string; reason: string }> { return [...this.items].map(([key, reason]) => ({ key, reason })); }
  clear(): void { this.items.clear(); }
}

// ───────────── conversions shared by the providers and the snapshot exporter ─────────────

/** Concurrency window within which an index price may be attached to an option quote as its underlying price. */
export const DEFAULT_UNDERLYING_TOLERANCE_MS = 60_000;

export function toOptionQuote(reading: Extract<Reading, { status: "usable" }>, optionType: "CE" | "PE", spot: Reading | undefined, toleranceMs: number): { quote: OptionQuote; underlying: "attached" | "no_spot" | "not_concurrent" } | { problem: string } {
  const q = reading.quote;
  let underlyingPrice: number | null = null;
  let underlying: "attached" | "no_spot" | "not_concurrent" = "no_spot";
  if (spot && spot.status === "usable" && spot.quote.last !== null) {
    if (Math.abs(Date.parse(spot.upstreamTimestamp) - Date.parse(reading.upstreamTimestamp)) <= toleranceMs) { underlyingPrice = spot.quote.last; underlying = "attached"; } else underlying = "not_concurrent";
  }
  // Kite's quote has no implied volatility or greeks: they are null, never derived here
  const quote: OptionQuote = { premium: q.last, bid: q.bid, ask: q.ask, iv: null, ivPrevious: null, delta: null, gamma: null, theta: null, vega: null, openInterest: q.openInterest, volume: q.volume, underlyingPrice, asOf: q.asOf };
  const problem = optionQuoteProblem(quote, optionType);
  return problem ? { problem } : { quote, underlying };
}

export interface ChainBuild { chain: OptionChain; rows: number }
export function buildChain(catalog: InstrumentCatalog, source: QuoteSource, underlying: KiteUnderlying, expiry: string, strikesEachSide: number): ChainBuild | { problem: string } {
  const spotInstrument = catalog.lookup({ underlying, kind: "index" });
  const spot = spotInstrument ? source.read(spotInstrument) : undefined;
  if (!spot || spot.status !== "usable" || spot.quote.last === null) return { problem: `spot_${spot && spot.status === "unusable" ? spot.reason : "unavailable"}` };
  const options = catalog.instruments.filter((i) => i.underlying === underlying && i.kind === "option" && i.expiry === expiry);
  const strikes = [...new Set(options.map((i) => i.strike as number))].sort((a, b) => a - b);
  if (strikes.length === 0) return { problem: "expiry_not_listed" };
  const atm = strikes.reduce((best, s) => (Math.abs(s - (spot.quote.last as number)) < Math.abs(best - (spot.quote.last as number)) ? s : best), strikes[0] as number);
  const at = strikes.indexOf(atm);
  const window = new Set(strikes.slice(Math.max(0, at - strikesEachSide), at + strikesEachSide + 1));
  const rows: OptionChainRow[] = [];
  let oldest = Date.parse(spot.upstreamTimestamp);
  for (const i of options) {
    if (!window.has(i.strike as number)) continue;
    const r = source.read(i);
    if (r.status !== "usable") return { problem: `row_${r.reason}` }; // all-or-nothing: a chain with silent holes is not a chain
    oldest = Math.min(oldest, Date.parse(r.upstreamTimestamp));
    rows.push({ strike: i.strike as number, optionType: i.optionType as "CE" | "PE", iv: null, openInterest: r.quote.openInterest, volume: r.quote.volume });
  }
  rows.sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType));
  const chain: OptionChain = { underlyingPrice: spot.quote.last, asOf: new Date(oldest).toISOString(), rows };
  const problem = chainProblem(chain);
  return problem ? { problem: `chain_${problem}` } : { chain, rows: rows.length };
}

// ───────────── provider adapters (TWINS contracts) ─────────────

export function kiteInstrumentReference(catalog: InstrumentCatalog, o: { asOf: string; name?: string }): InstrumentReference & { diagnostics: Diagnostics } {
  const records: InstrumentRecord[] = catalog.instruments.filter((i) => i.kind !== "index").map((i) => ({
    market: UNDERLYING_MARKET[i.underlying], underlying: i.underlying, instrumentType: i.kind as "future" | "option", expiry: i.expiry, strike: i.strike, optionType: i.optionType, lotSize: i.lotSize, multiplier: null, active: true,
  }));
  const ref = memoryInstrumentReference({ name: o.name ?? "kite-instruments", asOf: o.asOf, markets: ["NSE", "BSE"], instruments: records });
  const diagnostics = new Diagnostics();
  // Indices are deliberately NOT emitted as "equity" records (that would mislabel them); the underlying is still known through its listed derivatives.
  diagnostics.record("index_records", "indices_not_exported_as_equity");
  return Object.assign(ref, { diagnostics });
}

export function kiteQuoteProvider(catalog: InstrumentCatalog, source: QuoteSource, o: { name?: string } = {}): QuoteProvider & { diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return {
    name: o.name ?? `kite-${source.kind}`, diagnostics,
    async quote(q) {
      const key = `${q.market}:${q.symbol}${q.expiry ? `:${q.expiry}` : ""}${q.strike !== null && q.optionType ? `:${q.strike}:${q.optionType}` : ""}`.toUpperCase();
      const r = resolveQuery(catalog, q);
      if (!r.ok) { diagnostics.record(key, r.reason); return null; }
      const reading = source.read(r.instrument);
      if (reading.status !== "usable") { diagnostics.record(key, reading.reason); return null; }
      if (quoteProblem(reading.quote) !== null) { diagnostics.record(key, "quote_invalid"); return null; }
      return reading.quote;
    },
  };
}

export function kiteLastPriceProvider(catalog: InstrumentCatalog, source: QuoteSource, o: { name?: string } = {}): LastPriceProvider & { diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return {
    name: o.name ?? `kite-last-${source.kind}`, diagnostics,
    async price(q) {
      const key = `${q.market}:${q.symbol}`.toUpperCase();
      const r = resolveQuery(catalog, { market: q.market, symbol: q.symbol, instrumentType: "equity", expiry: null, strike: null, optionType: null });
      if (!r.ok) { diagnostics.record(key, r.reason); return null; }
      const reading = source.read(r.instrument);
      if (reading.status !== "usable") { diagnostics.record(key, reading.reason); return null; }
      if (reading.quote.last === null) { diagnostics.record(key, "no_last_price"); return null; }
      return { price: reading.quote.last, asOf: reading.upstreamTimestamp }; // the upstream time, not the read time
    },
  };
}

export function kiteOptionsQuoteProvider(catalog: InstrumentCatalog, source: QuoteSource, o: { name?: string; underlyingToleranceMs?: number } = {}): OptionsQuoteProvider & { diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return {
    name: o.name ?? `kite-options-${source.kind}`, diagnostics,
    async quote(q) {
      const key = `${q.market}:${q.symbol}:${q.expiry}:${q.strike}:${q.optionType}`.toUpperCase();
      if (q.instrumentType !== "option") { diagnostics.record(key, "not_an_option"); return null; }
      const r = resolveQuery(catalog, q);
      if (!r.ok) { diagnostics.record(key, r.reason); return null; }
      const reading = source.read(r.instrument);
      if (reading.status !== "usable") { diagnostics.record(key, reading.reason); return null; }
      const spotInstrument = catalog.lookup({ underlying: r.instrument.underlying, kind: "index" });
      const built = toOptionQuote(reading, r.instrument.optionType as "CE" | "PE", spotInstrument ? source.read(spotInstrument) : undefined, o.underlyingToleranceMs ?? DEFAULT_UNDERLYING_TOLERANCE_MS);
      if ("problem" in built) { diagnostics.record(key, `option_quote_${built.problem}`); return null; }
      return built.quote;
    },
  };
}

export function kiteOptionsChainProvider(catalog: InstrumentCatalog, source: QuoteSource, o: { name?: string; strikesEachSide?: number } = {}): OptionsChainProvider & { diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return {
    name: o.name ?? `kite-chain-${source.kind}`, diagnostics,
    async chain(q) {
      const key = `${q.market}:${q.underlying}:${q.expiry}`.toUpperCase();
      const r = resolveQuery(catalog, { market: q.market, symbol: q.underlying, instrumentType: "equity", expiry: null, strike: null, optionType: null });
      if (!r.ok) { diagnostics.record(key, r.reason); return null; }
      const built = buildChain(catalog, source, r.instrument.underlying, q.expiry, o.strikesEachSide ?? 5);
      if ("problem" in built) { diagnostics.record(key, built.problem); return null; }
      return built.chain;
    },
  };
}

/**
 * Historical / as-of candles. Old bars are NOT rejected for being old; the series was already validated (`ohlcProblem`) when it was mapped. `asOf` is when the
 * candles were fetched (snapshot time), not a claim about the bars. A possibly still-forming last bar is withheld unless `includeOpenBar` is set.
 */
export function kiteOhlcProvider(series: ReadonlyMap<string, MappedCandles>, o: { name?: string; includeOpenBar?: boolean } = {}): OhlcProvider & { diagnostics: Diagnostics; candlesSync(key: string, to: string): OhlcSeries["bars"] } {
  const diagnostics = new Diagnostics();
  const fetched = [...series.values()].map((s) => Date.parse(s.fetchedAt));
  const asOf = fetched.length ? new Date(Math.min(...fetched)).toISOString() : null;
  const barsFor = (key: string, to: string): OhlcSeries["bars"] => {
    const mapped = series.get(key);
    if (!mapped) return [];
    let bars = mapped.series.bars.filter((b) => Date.parse(b.t) <= Date.parse(to));
    if (!o.includeOpenBar && mapped.lastBarMayBeOpen && bars.length > 0 && bars[bars.length - 1] === mapped.series.bars[mapped.series.bars.length - 1]) { bars = bars.slice(0, -1); diagnostics.record(key, "open_bar_withheld"); }
    return bars;
  };
  return {
    name: o.name ?? "kite-historical", asOf, diagnostics, candlesSync: barsFor,
    async candles(q) {
      const key = `${q.market}:${q.symbol}`.toUpperCase();
      const mapped = series.get(key);
      if (!mapped) { diagnostics.record(key, "no_series"); return null; }
      return { symbol: mapped.series.symbol, intervalSeconds: mapped.series.intervalSeconds, bars: barsFor(key, q.to).slice(-q.limit) };
    },
  };
}

export { twinsKey, spotKey };
export type { KiteInstrument };
