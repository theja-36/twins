import { KiteError } from "./errors";

/**
 * Kite Connect plans and what each includes, from the vendor's published plan page (zerodha.com/products/api, read 2026-10-31):
 *   Personal (Free)   "Full fledged order, GTT, alerts management", "Margin computation, portfolio management etc."  -  market data is NOT listed
 *   Connect (INR 500 / month)   "Full suite of APIs", "realtime WebSocket streaming", "historical candle data"
 * The page lists no separate Historical add-on. The vendor page does not enumerate every endpoint per plan, so this table is deliberately CONSERVATIVE: a capability that is not
 * listed for a plan is treated as unavailable on it and refused locally, before any request. Which plan the owner's app has is configuration (`TWINS_KITE_PLAN`), never inferred.
 */
export type KitePlan = "personal" | "connect";
export interface PlanCapabilities { account: boolean; marketData: boolean; websocket: boolean; historical: boolean; basis: string }
export const PLAN_CAPABILITIES: Readonly<Record<KitePlan, PlanCapabilities>> = {
  personal: { account: true, marketData: false, websocket: false, historical: false, basis: "Personal (Free): order / GTT / alerts management, margin computation, portfolio management; market data not listed" },
  connect: { account: true, marketData: true, websocket: true, historical: true, basis: "Connect (INR 500 per month): full suite of APIs incl. realtime WebSocket streaming and historical candle data" },
};
export const isPlan = (v: unknown): v is KitePlan => v === "personal" || v === "connect";
export function requireCapability(plan: KitePlan, cap: "marketData" | "websocket" | "historical"): void {
  if (!PLAN_CAPABILITIES[plan][cap]) throw new KiteError("PLAN_RESTRICTED");
}
