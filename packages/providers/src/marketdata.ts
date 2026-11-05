import { CONSTITUENTS_FORMAT, QUOTES_FORMAT } from "@twins/agents";
import { indexContexts } from "./macro";

/**
 * MARKET DATA. Quotes: the one-day change of each INDEX the Kite feed already subscribes to (from the OHLC + last-price snapshots), written as twins-market-quotes-v1. The feed does NOT
 * subscribe to individual stocks, so there are no constituent quotes yet (extending the feed is a separate, owner-approved change). Constituents: no free machine-readable source publishes index
 * WEIGHTS, so they are imported from a CSV the owner supplies (symbol,weight,sector[,recent_change_pct]) and validated strictly; equal weights are never invented.
 */
export function buildMarketQuotes(ohlc: unknown, last: unknown, now: Date): { document: Record<string, unknown>; quotes: number } | null {
  const idx = indexContexts(ohlc, last, now).filter((i) => i.changePct1d !== null);
  if (idx.length === 0) return null;
  const quotes: Record<string, unknown> = {};
  for (const i of idx) quotes[`${i.market}:${i.symbol}`] = { change_pct_1d: i.changePct1d, as_of: i.asOf };
  return { document: { format: QUOTES_FORMAT, source: "kite-snapshot", as_of: idx.map((i) => i.asOf).sort()[0], quotes }, quotes: idx.length };
}

export class ConstituentsCsvError extends Error { constructor(readonly line: number, readonly why: string) { super(`line ${line}: ${why}`); this.name = "ConstituentsCsvError"; } }
export function buildConstituents(csv: string, o: { index: string; source: string; asOf: Date }): { document: Record<string, unknown>; constituents: number } {
  if (!/^[A-Z0-9&._-]{1,30}$/.test(o.index)) throw new ConstituentsCsvError(0, "index name");
  const rows: Array<Record<string, unknown>> = [];
  csv.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || (i === 0 && /^symbol\s*,/i.test(line))) return;
    const [symbol = "", weight = "", sector = "", change = ""] = line.split(",").map((x) => x.trim());
    const w = Number(weight);
    if (!/^[A-Z0-9&._-]{1,30}$/.test(symbol) || !Number.isFinite(w) || w <= 0 || w > 100 || !/^[A-Za-z0-9 &._-]{1,40}$/.test(sector)) throw new ConstituentsCsvError(i + 1, "symbol, weight or sector");
    const c = change === "" ? null : Number(change);
    if (c !== null && !Number.isFinite(c)) throw new ConstituentsCsvError(i + 1, "recent_change_pct");
    rows.push({ symbol, weight: w, sector, ...(c === null ? {} : { recent_change_pct: c }), data_as_of: o.asOf.toISOString() });
  });
  return { document: { format: CONSTITUENTS_FORMAT, source: o.source, as_of: o.asOf.toISOString(), indices: { [o.index]: { as_of: o.asOf.toISOString(), constituents: rows } } }, constituents: rows.length };
}
