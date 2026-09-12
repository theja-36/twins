import type { InstrumentRef, ProviderHealthSnapshot } from "./common";

export type OrderSide = "buy" | "sell";

/**
 * Account-level broker state (spec section 12). Deliberately excludes any
 * credential/secret field - a broker adapter authenticates using
 * environment/secret-managed values it reads itself (spec section 10),
 * never values passed through this contract.
 */
export interface NormalizedAccountSnapshot {
  providerAccountId: string;
  cash: number;
  equity: number;
  currency: string;
  rawPayload?: unknown;
}

/** BrokerProvider - connection/account concerns only (spec section 12). */
export interface BrokerProvider {
  readonly providerName: string;
  connect(): Promise<void>;
  getAccountSnapshot(): Promise<NormalizedAccountSnapshot>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}

/**
 * `idempotencyKey` must be forwarded to the broker (or deduplicated by
 * the adapter) so a retry can never create a second order (spec section
 * 33) - this is the same key stored on `orders.idempotency_key`
 * (Phase 2).
 */
export interface PlaceOrderRequest {
  instrument: InstrumentRef;
  side: OrderSide;
  orderType: string; // market | limit | sl | sl-m
  quantity: number;
  price?: number;
  idempotencyKey: string;
}

export interface NormalizedOrderAck {
  brokerOrderId: string;
  status: "submitted" | "rejected";
  rawPayload?: unknown;
}

export interface NormalizedOrderStatus {
  brokerOrderId: string;
  status:
    | "pending"
    | "submitted"
    | "partially_filled"
    | "filled"
    | "cancelled"
    | "rejected";
  filledQuantity: number;
  averageFillPrice?: number;
  rawPayload?: unknown;
}

export interface NormalizedFillEvent {
  brokerOrderId: string;
  brokerFillId?: string;
  fillPrice: number;
  fillQuantity: number;
  fillTime: Date;
  rawPayload?: unknown;
}

/**
 * ExecutionProvider (spec section 12/32) - order placement only. This is
 * the *sole* path from an authorized decision to a broker order; nothing
 * upstream of the Risk Engine should ever hold a reference to this
 * interface directly (spec section 26/32 - "No shortcut").
 */
export interface ExecutionProvider {
  readonly providerName: string;
  placeOrder(request: PlaceOrderRequest): Promise<NormalizedOrderAck>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  getOrderStatus(brokerOrderId: string): Promise<NormalizedOrderStatus>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
