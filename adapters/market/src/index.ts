import { createAdapterRegistry } from "@twins/shared";
import type { MarketDataProvider } from "@twins/types";

/**
 * Registry of MarketDataProvider adapters, keyed by provider name (e.g.
 * "zerodha", "upstox"). No concrete vendor adapter is implemented here
 * yet - Phase 3 only establishes the contract and wiring point. A real
 * vendor adapter is added in the phase that has an actual provider
 * chosen and credentials configured (spec section 55: never invent
 * provider capabilities).
 */
export const marketDataProviders = createAdapterRegistry<MarketDataProvider>(
  "market data",
);

export type {
  InstrumentRef,
  MarketBarRequest,
  MarketDataProvider,
  NormalizedMarketBar,
  ProviderHealthSnapshot,
} from "@twins/types";
