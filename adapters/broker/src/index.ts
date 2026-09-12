import { createAdapterRegistry } from "@twins/shared";
import type { BrokerProvider, ExecutionProvider } from "@twins/types";

/**
 * Spec section 12 names MarketDataProvider, BrokerProvider, and
 * ExecutionProvider as three distinct interfaces, not one combined
 * "broker adapter" - a broker account can be connected (BrokerProvider)
 * independently of whether it is authorized to place orders
 * (ExecutionProvider), and order placement is deliberately not reachable
 * through the same object a market-data consumer holds (spec section
 * 26/32 - "No shortcut" from anything but an authorized risk decision).
 *
 * No concrete vendor (Zerodha/Upstox/etc.) is implemented yet - Phase 3
 * only establishes the contracts and registries (spec section 55: never
 * invent provider capabilities or assume an API is free).
 */
export const brokerConnections = createAdapterRegistry<BrokerProvider>(
  "broker connection",
);

export const executionProviders = createAdapterRegistry<ExecutionProvider>(
  "execution",
);

export type {
  BrokerProvider,
  ExecutionProvider,
  NormalizedAccountSnapshot,
  NormalizedFillEvent,
  NormalizedOrderAck,
  NormalizedOrderStatus,
  OrderSide,
  PlaceOrderRequest,
  ProviderHealthSnapshot,
} from "@twins/types";
