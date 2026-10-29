import { assertLiveTradingDisabled } from "@twins/config";
import { assertTradingEnabled } from "./singleton";

/**
 * The single boundary every future order-intent / broker-call code path must pass BEFORE it creates an order intent or contacts a
 * broker. It requires, in this order: (1) the shared live-trading guard (no override exists before the LIVE Gate), then (2) the
 * database-backed state: kill switch inactive AND TRADING_ENABLED true. Any failure (including an unreadable state) refuses.
 * No broker or execution code exists yet; adapters/broker wraps registered ExecutionProviders with this check.
 */
export async function assertOrderIntentAllowed(operationName: string): Promise<void> {
  assertLiveTradingDisabled(operationName);
  await assertTradingEnabled(operationName);
}
