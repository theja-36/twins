import { createAdapterRegistry, type AdapterRegistry } from "@twins/shared";
import { assertOrderIntentAllowed } from "@twins/runtime-state";
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

/**
 * Wraps an ExecutionProvider so that creating an order (the order-intent / broker-call boundary) first passes
 * assertOrderIntentAllowed: the shared live-trading guard, then the database-backed state (TRADING_ENABLED true AND kill switch inactive).
 * An unreadable state refuses. cancelOrder, getOrderStatus and getHealth are deliberately NOT gated: cancelling is risk-reducing and
 * must keep working while the kill switch is active; the rest are read-only.
 */
export function guardExecutionProvider(provider: ExecutionProvider): ExecutionProvider {
  return {
    get providerName() {
      return provider.providerName;
    },
    placeOrder: async (request) => {
      await assertOrderIntentAllowed(`broker.${provider.providerName}.placeOrder`);
      return provider.placeOrder(request);
    },
    cancelOrder: (brokerOrderId) => provider.cancelOrder(brokerOrderId),
    getOrderStatus: (brokerOrderId) => provider.getOrderStatus(brokerOrderId),
    getHealth: () => provider.getHealth(),
  };
}

const baseExecutionProviders = createAdapterRegistry<ExecutionProvider>("execution");

/**
 * The execution registry. Every provider registered here is wrapped by guardExecutionProvider automatically, so there is no way to
 * obtain an un-gated placeOrder through the registry. (No concrete broker adapter exists yet.)
 */
export const executionProviders: AdapterRegistry<ExecutionProvider> = {
  ...baseExecutionProviders,
  register(providerName, adapter) {
    baseExecutionProviders.register(providerName, guardExecutionProvider(adapter));
  },
};

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

export * from "./ports";
