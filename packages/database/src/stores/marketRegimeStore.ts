import type { Db } from "../client";
import { marketRegimes } from "../schema/intelligence";

/** One row of `market_regimes` (shared platform data, append-only). Mirrors the regime detector's output so this package needs no dependency on it. */
export interface MarketRegimeRowInput {
  underlying: string; timeframe: "5m" | "15m" | "1h" | "1d"; direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN"; regime: string; volatilityRegime: string;
  impliedVolatility: string | null; eventRisk: string; evidence: unknown[]; detectorVersion: string; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; asOf: Date;
}
/** Inserts regime observations. A repeat of the same (underlying, timeframe, as-of, detector version, data source) is ignored, so re-running a detector is idempotent. Returns how many rows were new. */
export async function storeMarketRegimeRows(db: Pick<Db, "insert">, rows: readonly MarketRegimeRowInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db.insert(marketRegimes).values(rows.map((r) => ({ ...r, underlying: r.underlying.toUpperCase(), evidence: r.evidence }))).onConflictDoNothing().returning({ id: marketRegimes.id });
  return inserted.length;
}
