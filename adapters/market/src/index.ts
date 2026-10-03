import { createAdapterRegistry } from "@twins/shared";
import type { MarketDataProvider } from "@twins/types";

/**
 * Registry of MarketDataProvider adapters, keyed by provider name (e.g.
 * "yahoo-finance", "zerodha", "upstox"). Core code depends only on this
 * registry + the MarketDataProvider interface, never on a specific vendor's
 * client/SDK (spec section 43).
 */
export const marketDataProviders = createAdapterRegistry<MarketDataProvider>(
  "market data",
);

// Concrete adapters — imported and exported here so callers can register
// them by name without importing from the adapter sub-module directly.
export { YahooFinanceAdapter, YAHOO_PROVIDER_NAME } from "./yahoo.js";

export type {
  InstrumentRef,
  MarketBarRequest,
  MarketDataProvider,
  NormalizedMarketBar,
  ProviderHealthSnapshot,
} from "@twins/types";
