/**
 * The explicit price-provider interface for everything price-dependent (fills, stop / target / trailing / time monitoring). Nothing here assumes a fixture is a live price: every observation carries the provider's declared data source,
 * and a missing, malformed, future-dated or stale observation is returned as a FAILURE with a reason, never as a price. No live provider exists yet (G-20).
 */
export interface PriceObservation { price: number; asOf: string }
export interface PriceProvider { readonly name: string; readonly dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; price(q: { exchange: string; symbol: string }): Promise<PriceObservation | null> }
export type FreshPrice = { ok: true; price: number; asOf: Date; source: PriceProvider["dataSource"]; provider: string; ageSeconds: number } | { ok: false; reason: "NO_PROVIDER" | "NO_PRICE" | "PROVIDER_ERROR" | "MALFORMED" | "FUTURE" | "STALE"; provider: string | null; ageSeconds: number | null };
export async function freshPrice(p: PriceProvider | null, q: { exchange: string; symbol: string }, now: Date, maxAgeSeconds: number): Promise<FreshPrice> {
  if (!p) return { ok: false, reason: "NO_PROVIDER", provider: null, ageSeconds: null };
  let o: PriceObservation | null;
  try { o = await p.price(q); } catch { return { ok: false, reason: "PROVIDER_ERROR", provider: p.name, ageSeconds: null }; } // the provider's message is never kept
  if (!o) return { ok: false, reason: "NO_PRICE", provider: p.name, ageSeconds: null };
  const at = Date.parse(o.asOf);
  if (typeof o.price !== "number" || !Number.isFinite(o.price) || o.price <= 0 || Number.isNaN(at)) return { ok: false, reason: "MALFORMED", provider: p.name, ageSeconds: null };
  const age = (now.getTime() - at) / 1000;
  if (age < -5) return { ok: false, reason: "FUTURE", provider: p.name, ageSeconds: age };
  if (age > maxAgeSeconds) return { ok: false, reason: "STALE", provider: p.name, ageSeconds: age };
  return { ok: true, price: o.price, asOf: new Date(at), source: p.dataSource, provider: p.name, ageSeconds: Math.max(0, age) };
}
/** Adapts any `{ price({market, symbol}) }` last-price provider (for example the file snapshot the agents already read) and declares what it is. */
export function priceProviderFrom(lp: { readonly name: string; price(q: { market: string; symbol: string }): Promise<PriceObservation | null> }, dataSource: PriceProvider["dataSource"]): PriceProvider {
  return { name: lp.name, dataSource, price: (q) => lp.price({ market: q.exchange, symbol: q.symbol }) };
}
