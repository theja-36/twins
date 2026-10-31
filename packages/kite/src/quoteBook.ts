import type { InstrumentQuote } from "@twins/agents/src/agents/quoteProviders";
import { KiteError } from "./errors";
import { mapFullQuote, type Batch, type RawFullQuote } from "./marketData";
import type { KiteInstrument } from "./instruments";
import type { KiteTicker } from "./ticker";
import { requireWiring } from "./wiringConfig";

export type SourceKind = "rest" | "websocket";
export type Reading =
  | { status: "usable"; source: SourceKind; quote: InstrumentQuote; upstreamTimestamp: string; lastTradeTime: string | null; ageMs: number }
  | { status: "unusable"; source: SourceKind; reason: string };

/**
 * One origin of validated quotes. A reading is "usable" only when it carries an UPSTREAM exchange timestamp, passed the existing quote validator, and is no older than
 * `maxAgeMs` NOW (age is measured against the clock at read time, never against when the data was fetched).
 */
export interface QuoteSource { readonly kind: SourceKind; readonly name: string; read(instrument: KiteInstrument): Reading }

export interface RestSourceOptions { now: () => number; maxAgeMs: number; futureToleranceMs: number }

/** REST: a batch from `getFullQuotes`. Missing, invalid, limited (no timestamp) and stale entries are each reported with their own reason. */
export function restSource(batch: Batch<RawFullQuote>, o: RestSourceOptions): QuoteSource {
  requireWiring({ maxAgeMs: o.maxAgeMs, futureToleranceMs: o.futureToleranceMs });
  const byToken = new Map(batch.entries.map((e) => [e.instrument.token, e]));
  return {
    kind: "rest", name: "kite-rest",
    read(instrument) {
      const e = byToken.get(instrument.token);
      if (!e) return { status: "unusable", source: "rest", reason: "not_requested" };
      if (e.status === "missing") return { status: "unusable", source: "rest", reason: "missing_in_response" };
      if (e.status === "invalid") return { status: "unusable", source: "rest", reason: e.reason };
      const m = mapFullQuote(instrument, e.raw, batch.fetchedAt);
      if (!m.ok) return { status: "unusable", source: "rest", reason: m.reason };
      const ageMs = o.now() - Date.parse(m.value.upstreamTimestamp);
      if (ageMs < -o.futureToleranceMs) return { status: "unusable", source: "rest", reason: "timestamp_in_future" };
      if (ageMs > o.maxAgeMs) return { status: "unusable", source: "rest", reason: "stale" };
      return { status: "usable", source: "rest", quote: m.value.quote, upstreamTimestamp: m.value.upstreamTimestamp, lastTradeTime: m.value.lastTradeTime, ageMs };
    },
  };
}

/** WebSocket: the ticker's own freshness verdict decides (connected + young exchange timestamp). Limited, disconnected, stale and unknown states are unusable. */
export function websocketSource(ticker: KiteTicker, o: { maxAgeMs: number }): QuoteSource {
  requireWiring({ maxAgeMs: o.maxAgeMs });
  return {
    kind: "websocket", name: "kite-websocket",
    read(instrument) {
      const f = ticker.freshness(instrument.token, o.maxAgeMs);
      if (f.state !== "fresh") return { status: "unusable", source: "websocket", reason: f.state };
      const v = ticker.get(instrument.token)?.validated;
      if (!v) return { status: "unusable", source: "websocket", reason: "no_data" };
      return { status: "usable", source: "websocket", quote: v.quote, upstreamTimestamp: v.exchangeTimestamp, lastTradeTime: v.lastTradeTime, ageMs: f.ageMs };
    },
  };
}

/** Explicit source selection: exactly the requested source, or an error. There is NO fallback from one source to the other. */
export function chooseSource(kind: SourceKind, sources: { rest?: QuoteSource; websocket?: QuoteSource }): QuoteSource {
  const s = sources[kind];
  if (!s) throw new KiteError("INVALID_REQUEST");
  return s;
}
