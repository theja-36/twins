/**
 * Pre-trade order validation (P1 #9). PURE and deterministic: checks one proposed order against instrument rules, market state and limits and returns the violations. It is a checklist for the
 * gates that exist, never an approval (`grantsApproval: false`), places nothing and contacts nothing. Unknown market facts are reported, and where a check cannot be made safely without them
 * (reference price for a limit or notional check) the order is blocked: nothing is assumed good.
 */
export const PRE_TRADE_VERSION = "pre-trade-validation-v1";

export interface OrderIntent { symbol: string; side: "BUY" | "SELL"; quantity: number; /** null = market order. */ limitPrice: number | null; /** Protective stop level, or null. */ stopPrice: number | null }
export interface InstrumentRules { lotSize: number; tickSize: number; /** Exchange freeze quantity (a single order above it is rejected), or null if none. */ freezeQuantity: number | null; tradable: boolean }
export interface MarketState { referencePrice: number | null; /** Exchange price band as a percent around the reference, or null if none. */ priceBandPct: number | null; sessionOpen: boolean | null; quoteAgeSeconds: number | null }
export interface PreTradeLimits { maxQuantity: number; maxOrderNotional: number; maxPriceDeviationPct: number; maxQuoteAgeSeconds: number; allowMarketOrders: boolean; requireStop: boolean; availableCapital: number | null }
export const DEFAULT_PRE_TRADE_LIMITS: PreTradeLimits = { maxQuantity: 100_000, maxOrderNotional: 1_000_000, maxPriceDeviationPct: 3, maxQuoteAgeSeconds: 60, allowMarketOrders: false, requireStop: true, availableCapital: null };

export type ViolationCode =
  | "QTY_NOT_POSITIVE_INTEGER" | "QTY_NOT_LOT_MULTIPLE" | "QTY_EXCEEDS_MAX" | "QTY_ABOVE_FREEZE" | "INSTRUMENT_NOT_TRADABLE" | "SESSION_CLOSED" | "PRICE_NOT_POSITIVE" | "PRICE_OFF_TICK"
  | "MARKET_ORDER_NOT_ALLOWED" | "NO_REFERENCE_PRICE" | "PRICE_DEVIATION" | "PRICE_OUTSIDE_BAND" | "STOP_MISSING" | "STOP_WRONG_SIDE" | "STOP_OFF_TICK" | "NOTIONAL_EXCEEDS_MAX" | "NOTIONAL_EXCEEDS_CAPITAL"
  | "STALE_QUOTE" | "SESSION_UNKNOWN" | "QUOTE_AGE_UNKNOWN" | "RULES_INVALID" | "LIMITS_INVALID";
export interface Violation { code: ViolationCode; severity: "BLOCK" | "WARN"; detail: string }
export interface PreTradeResult { version: typeof PRE_TRADE_VERSION; ok: boolean; violations: Violation[]; blockCount: number; warnCount: number; notional: number | null; grantsApproval: false }

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** True when `price` is a whole number of ticks (tolerant to float error). */
export function onTick(price: number, tick: number): boolean { const q = price / tick; return Math.abs(q - Math.round(q)) < 1e-6; }

export function validatePreTrade(o: OrderIntent, r: InstrumentRules, m: MarketState, l: PreTradeLimits = DEFAULT_PRE_TRADE_LIMITS): PreTradeResult {
  const v: Violation[] = [];
  const block = (code: ViolationCode, detail: string): void => { v.push({ code, severity: "BLOCK", detail }); };
  const warn = (code: ViolationCode, detail: string): void => { v.push({ code, severity: "WARN", detail }); };
  const done = (notional: number | null): PreTradeResult => ({ version: PRE_TRADE_VERSION, ok: !v.some((x) => x.severity === "BLOCK"), violations: v, blockCount: v.filter((x) => x.severity === "BLOCK").length, warnCount: v.filter((x) => x.severity === "WARN").length, notional, grantsApproval: false });

  if (!(fin(r.lotSize) && r.lotSize >= 1 && Number.isInteger(r.lotSize) && fin(r.tickSize) && r.tickSize > 0)) { block("RULES_INVALID", "lot size must be a positive whole number and tick size positive"); return done(null); }
  if (!(fin(l.maxQuantity) && l.maxQuantity > 0 && fin(l.maxOrderNotional) && l.maxOrderNotional > 0 && fin(l.maxPriceDeviationPct) && l.maxPriceDeviationPct > 0 && fin(l.maxQuoteAgeSeconds) && l.maxQuoteAgeSeconds > 0)) { block("LIMITS_INVALID", "limits must be positive numbers"); return done(null); }

  if (!r.tradable) block("INSTRUMENT_NOT_TRADABLE", "instrument is not tradable");
  if (m.sessionOpen === false) block("SESSION_CLOSED", "market session is closed");
  else if (m.sessionOpen === null) warn("SESSION_UNKNOWN", "session state is unknown");

  if (!(Number.isInteger(o.quantity) && o.quantity > 0)) block("QTY_NOT_POSITIVE_INTEGER", "quantity must be a positive whole number");
  else {
    if (o.quantity % r.lotSize !== 0) block("QTY_NOT_LOT_MULTIPLE", `quantity must be a multiple of lot size ${r.lotSize}`);
    if (o.quantity > l.maxQuantity) block("QTY_EXCEEDS_MAX", `quantity above the limit ${l.maxQuantity}`);
    if (r.freezeQuantity !== null && o.quantity > r.freezeQuantity) block("QTY_ABOVE_FREEZE", `quantity above the freeze quantity ${r.freezeQuantity}`);
  }

  if (m.quoteAgeSeconds === null) warn("QUOTE_AGE_UNKNOWN", "quote age is unknown");
  else if (m.quoteAgeSeconds > l.maxQuoteAgeSeconds || m.quoteAgeSeconds < 0) block("STALE_QUOTE", "reference quote is stale or from the future");

  if (o.limitPrice === null && !l.allowMarketOrders) block("MARKET_ORDER_NOT_ALLOWED", "market orders are not allowed");
  if (o.limitPrice !== null) {
    if (!(fin(o.limitPrice) && o.limitPrice > 0)) block("PRICE_NOT_POSITIVE", "limit price must be positive");
    else if (!onTick(o.limitPrice, r.tickSize)) block("PRICE_OFF_TICK", `limit price is not a multiple of tick ${r.tickSize}`);
  }
  const ref = m.referencePrice !== null && fin(m.referencePrice) && m.referencePrice > 0 ? m.referencePrice : null;
  if (ref === null) block("NO_REFERENCE_PRICE", "no usable reference price, so price checks cannot be made");
  if (ref !== null && o.limitPrice !== null && fin(o.limitPrice) && o.limitPrice > 0) {
    const dev = (Math.abs(o.limitPrice - ref) / ref) * 100;
    if (dev > l.maxPriceDeviationPct) block("PRICE_DEVIATION", `limit price deviates ${dev.toFixed(2)}% from the reference (limit ${l.maxPriceDeviationPct}%)`);
    if (m.priceBandPct !== null && dev > m.priceBandPct) block("PRICE_OUTSIDE_BAND", `limit price is outside the exchange band of ${m.priceBandPct}%`);
  }

  const px = o.limitPrice !== null && fin(o.limitPrice) && o.limitPrice > 0 ? o.limitPrice : ref;
  if (o.stopPrice === null) { if (l.requireStop) block("STOP_MISSING", "a protective stop is required"); }
  else if (!(fin(o.stopPrice) && o.stopPrice > 0)) block("STOP_WRONG_SIDE", "stop must be a positive price");
  else {
    if (!onTick(o.stopPrice, r.tickSize)) block("STOP_OFF_TICK", `stop is not a multiple of tick ${r.tickSize}`);
    if (px !== null && (o.side === "BUY" ? o.stopPrice >= px : o.stopPrice <= px)) block("STOP_WRONG_SIDE", o.side === "BUY" ? "a BUY stop must be below the entry price" : "a SELL stop must be above the entry price");
  }

  const notional = px !== null && Number.isInteger(o.quantity) && o.quantity > 0 ? px * o.quantity : null;
  if (notional !== null) {
    if (notional > l.maxOrderNotional) block("NOTIONAL_EXCEEDS_MAX", `order value above the limit ${l.maxOrderNotional}`);
    if (l.availableCapital !== null && notional > l.availableCapital) block("NOTIONAL_EXCEEDS_CAPITAL", "order value exceeds available capital");
  }
  return done(notional);
}
