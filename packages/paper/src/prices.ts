import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PricePoint { price: number; at: string }
/** Where simulated trades get their prices. Read-only; a null answer means "no usable price" and the trade is simply not stepped. */
export interface PriceSource { last(symbol: string): Promise<PricePoint | null> }

/**
 * Reads the `last-price` snapshot written by the Kite feed (twins-last-price-v1, local file, no network). Keys are `EXCHANGE:SYMBOL`; a bare symbol is looked up on NSE, BSE and NFO.
 * Only index / cash-segment last prices exist in this snapshot, so option contracts have no price here (their paper trades stay unmonitored until a price source for them exists).
 */
export function snapshotPriceSource(dir: string): PriceSource {
  return {
    async last(symbol: string): Promise<PricePoint | null> {
      let doc: unknown;
      try { doc = JSON.parse(await readFile(join(dir, "last-price.json"), "utf8")); } catch { return null; }
      const d = doc as { format?: unknown; prices?: unknown };
      if (d.format !== "twins-last-price-v1" || typeof d.prices !== "object" || d.prices === null) return null;
      const prices = d.prices as Record<string, { price?: unknown; as_of?: unknown }>;
      const keys = symbol.includes(":") ? [symbol] : [`NSE:${symbol}`, `BSE:${symbol}`, `NFO:${symbol}`];
      for (const k of keys) {
        const e = Object.hasOwn(prices, k) ? prices[k] : undefined;
        if (e && typeof e.price === "number" && Number.isFinite(e.price) && e.price > 0 && typeof e.as_of === "string" && !Number.isNaN(Date.parse(e.as_of))) return { price: e.price, at: e.as_of };
      }
      return null;
    },
  };
}
