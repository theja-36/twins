import { SNAPSHOT_SPECS, type SnapshotKind } from "@twins/agents/src/snapshots";
import type { MappedCandles } from "./historical";
import type { InstrumentCatalog, KiteInstrument, KiteUnderlying } from "./instruments";
import type { QuoteSource } from "./quoteBook";
import { buildChain, kiteOhlcProvider, toOptionQuote } from "./twinsProviders";
import { spotKey, twinsKey, UNDERLYING_MARKET } from "./twinsMapping";
import { requireWiring } from "./wiringConfig";

export type KiteSnapshotKind = Extract<SnapshotKind, "instrument-reference" | "quotes" | "option-quotes" | "option-chain" | "last-price" | "ohlc">;

export interface ExportRequest {
  catalog: InstrumentCatalog;
  /** EXACTLY one quote source (REST or WebSocket). There is no fallback to the other. */
  source: QuoteSource;
  generationId: string;
  now: Date;
  /** When the instruments dump was retrieved: the dump carries no upstream timestamp, so this fetch time is the reference's as_of (and is reported as such). */
  referenceAsOf: string;
  /** Indices, futures and options to include in `quotes` (options are additionally exported as option-quotes). */
  quoteInstruments: readonly KiteInstrument[];
  chains: ReadonlyArray<{ underlying: KiteUnderlying; expiry: string }>;
  strikesEachSide: number;
  /** Spot keys ("NSE:NIFTY") expected in the OHLC snapshot, and the candles that were fetched for them. */
  candleKeys: readonly string[];
  candles: ReadonlyMap<string, MappedCandles>;
  underlyingToleranceMs: number;
}

export interface KindReport {
  kind: KiteSnapshotKind;
  status: "included" | "omitted" | "not_requested";
  requested: number;
  included: number;
  /** The file-level as_of = the OLDEST upstream timestamp among the entries (never the export time). */
  asOf: string | null;
  missing: Array<{ key: string; reason: string }>;
}
export interface ExportReport {
  generationId: string;
  sourceKind: QuoteSource["kind"];
  exportedAt: string;
  kinds: KindReport[];
  /** True only if every requested entry of every requested kind was included. Incompleteness is never implied away. */
  complete: boolean;
}
export interface ExportResult { documents: Partial<Record<KiteSnapshotKind, Record<string, unknown>>>; report: ExportReport }

const iso = (ms: number): string => new Date(ms).toISOString();

/** Builds the six Kite-fed snapshot documents in the existing versioned schemas and validates each with the consumer's own strict parser. Pure: nothing is written. */
export function buildSnapshotDocuments(req: ExportRequest): ExportResult {
  requireWiring({ strikesEachSide: req.strikesEachSide, underlyingWindowMs: req.underlyingToleranceMs });
  const source = `kite-${req.source.kind}`;
  const documents: ExportResult["documents"] = {};
  const kinds: KindReport[] = [];
  const done = (r: KindReport, doc?: Record<string, unknown>): void => {
    const spec = SNAPSHOT_SPECS.find((s) => s.kind === r.kind);
    if (doc && r.included > 0 && spec) {
      try { spec.parse(doc); documents[r.kind] = doc; kinds.push({ ...r, status: "included" }); return; } catch (e) {
        kinds.push({ ...r, status: "omitted", included: 0, asOf: null, missing: [...r.missing, { key: "*", reason: `INVALID_DOCUMENT:${(e as { code?: string }).code ?? "strict_parse_failed"}` }] });
        return;
      }
    }
    kinds.push({ ...r, status: r.requested === 0 ? "not_requested" : "omitted", included: 0, asOf: null });
  };

  // instrument-reference (fetch time of the dump as as_of; reported)
  const refRecords = req.catalog.instruments.filter((i) => i.kind !== "index").map((i) => ({
    market: UNDERLYING_MARKET[i.underlying], underlying: i.underlying, instrument_type: i.kind, expiry: i.expiry, ...(i.kind === "option" ? { strike: i.strike, option_type: i.optionType } : {}), lot_size: i.lotSize, active: true,
  }));
  done({ kind: "instrument-reference", status: "included", requested: refRecords.length, included: refRecords.length, asOf: iso(Date.parse(req.referenceAsOf)), missing: [] },
    { format: "twins-instrument-reference-v1", source: "kite-instruments-dump", as_of: iso(Date.parse(req.referenceAsOf)), markets: ["NSE", "BSE"], instruments: refRecords });

  // quotes + option-quotes + last-price
  const quotes: Record<string, unknown> = {};
  const optionQuotes: Record<string, unknown> = {};
  const prices: Record<string, unknown> = {};
  const missingQ: KindReport["missing"] = [], missingO: KindReport["missing"] = [], missingP: KindReport["missing"] = [];
  const tsQ: number[] = [], tsO: number[] = [], tsP: number[] = [];
  const spotReads = new Map<KiteUnderlying, ReturnType<QuoteSource["read"]>>();
  const spotOf = (u: KiteUnderlying): ReturnType<QuoteSource["read"]> | undefined => {
    if (!spotReads.has(u)) { const i = req.catalog.lookup({ underlying: u, kind: "index" }); if (i) spotReads.set(u, req.source.read(i)); }
    return spotReads.get(u);
  };
  let optionCount = 0, spotCount = 0;
  for (const i of req.quoteInstruments) {
    const key = twinsKey(i);
    const r = req.source.read(i);
    if (i.kind === "option") optionCount += 1;
    if (i.kind === "index") spotCount += 1;
    if (r.status !== "usable") {
      missingQ.push({ key, reason: r.reason });
      if (i.kind === "option") missingO.push({ key, reason: r.reason });
      if (i.kind === "index") missingP.push({ key, reason: r.reason });
      continue;
    }
    const q = r.quote;
    quotes[key] = { bid: q.bid, ask: q.ask, last: q.last, volume: q.volume, avg_volume: q.avgVolume, open_interest: q.openInterest, bid_depth: q.bidDepth, ask_depth: q.askDepth, as_of: q.asOf };
    tsQ.push(Date.parse(q.asOf));
    if (i.kind === "option") {
      const built = toOptionQuote(r, i.optionType as "CE" | "PE", spotOf(i.underlying), req.underlyingToleranceMs);
      if ("problem" in built) missingO.push({ key, reason: `option_quote_${built.problem}` });
      else {
        const o = built.quote;
        optionQuotes[key] = { premium: o.premium, bid: o.bid, ask: o.ask, iv: o.iv, iv_previous: o.ivPrevious, delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega, open_interest: o.openInterest, volume: o.volume, underlying_price: o.underlyingPrice, as_of: o.asOf };
        tsO.push(Date.parse(o.asOf));
      }
    }
    if (i.kind === "index") {
      if (q.last === null) missingP.push({ key: spotKey(i.underlying), reason: "no_last_price" });
      else { prices[spotKey(i.underlying)] = { price: q.last, as_of: r.upstreamTimestamp }; tsP.push(Date.parse(r.upstreamTimestamp)); }
    }
  }
  const stamp = (ts: number[]): string | null => (ts.length ? iso(Math.min(...ts)) : null);
  done({ kind: "quotes", status: "included", requested: req.quoteInstruments.length, included: Object.keys(quotes).length, asOf: stamp(tsQ), missing: missingQ },
    { format: "twins-quotes-v1", source, as_of: stamp(tsQ), quotes });
  done({ kind: "option-quotes", status: "included", requested: optionCount, included: Object.keys(optionQuotes).length, asOf: stamp(tsO), missing: missingO },
    { format: "twins-option-quotes-v1", source, as_of: stamp(tsO), quotes: optionQuotes });
  done({ kind: "last-price", status: "included", requested: spotCount, included: Object.keys(prices).length, asOf: stamp(tsP), missing: missingP },
    { format: "twins-last-price-v1", source, as_of: stamp(tsP), prices });

  // option-chain (all-or-nothing per chain)
  const chains: Record<string, unknown> = {};
  const missingC: KindReport["missing"] = [], tsC: number[] = [];
  for (const c of req.chains) {
    const key = `${UNDERLYING_MARKET[c.underlying]}:${c.underlying}:${c.expiry}`;
    const built = buildChain(req.catalog, req.source, c.underlying, c.expiry, req.strikesEachSide);
    if ("problem" in built) { missingC.push({ key, reason: built.problem }); continue; }
    chains[key] = { underlying_price: built.chain.underlyingPrice, as_of: built.chain.asOf, rows: built.chain.rows.map((r) => ({ strike: r.strike, option_type: r.optionType, iv: r.iv, open_interest: r.openInterest, volume: r.volume })) };
    tsC.push(Date.parse(built.chain.asOf));
  }
  done({ kind: "option-chain", status: "included", requested: req.chains.length, included: Object.keys(chains).length, asOf: stamp(tsC), missing: missingC },
    { format: "twins-option-chain-v1", source, as_of: stamp(tsC), chains });

  // ohlc (historical / as-of: bars keep their own times; file as_of = when the candles were fetched)
  const provider = kiteOhlcProvider(req.candles);
  const series: Record<string, unknown> = {};
  const missingH: KindReport["missing"] = [];
  const fetched: number[] = [];
  for (const key of req.candleKeys) {
    const m = req.candles.get(key);
    if (!m) { missingH.push({ key, reason: "no_series" }); continue; }
    const kept = provider.candlesSync(key, req.now.toISOString());
    if (kept.length === 0) { missingH.push({ key, reason: "no_closed_bars" }); continue; }
    series[key] = { interval_seconds: m.series.intervalSeconds, bars: kept.map((b) => ({ t: b.t, o: b.open, h: b.high, l: b.low, c: b.close, ...(b.volume !== null ? { v: b.volume } : {}) })) };
    fetched.push(Date.parse(m.fetchedAt));
  }
  done({ kind: "ohlc", status: "included", requested: req.candleKeys.length, included: Object.keys(series).length, asOf: stamp(fetched), missing: missingH },
    { format: "twins-ohlc-v1", source, as_of: stamp(fetched), series });

  const complete = kinds.every((k) => k.status === "not_requested" || (k.status === "included" && k.missing.length === 0));
  return { documents, report: { generationId: req.generationId, sourceKind: req.source.kind, exportedAt: req.now.toISOString(), kinds, complete } };
}
