import type { InstrumentRef, ProviderHealthSnapshot } from "./common";

export interface MarketBarRequest {
  instrument: InstrumentRef;
  timeframe: string; // tick | 1m | 5m | 1d | ...
  from: Date;
  to: Date;
}

/**
 * OBSERVED market data as returned by an adapter, already translated out
 * of the vendor's response shape (spec section 22/43). `source` records
 * which provider produced it - never assumed, never defaulted.
 */
export interface NormalizedMarketBar {
  instrument: InstrumentRef;
  source: string;
  timeframe: string;
  observedAt: Date;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  openInterest?: number;
  rawPayload?: unknown;
}

/**
 * MarketDataProvider (spec section 12/43). Core code depends only on this
 * interface, never on a specific vendor's client/SDK.
 */
export interface MarketDataProvider {
  readonly providerName: string;
  getHistoricalBars(request: MarketBarRequest): Promise<NormalizedMarketBar[]>;
  getLatestQuote(instrument: InstrumentRef): Promise<NormalizedMarketBar | null>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
