import { and, desc, eq, lte } from "drizzle-orm";
import { schema } from "@twins/database";
import { assessMarketObservation, type QualityAssessmentResult } from "@twins/dataquality";
import type { Db } from "../db";

export interface MarketContext {
  observation: typeof schema.marketObservations.$inferSelect;
  quality: QualityAssessmentResult;
}

export interface MarketContextOptions {
  /** No-look-ahead bound: only observations at or before this timestamp. Omit for unbounded (Phase 6 default behavior - "latest known"). */
  asOf?: Date | undefined;
}

/**
 * Latest known market observation for an instrument, plus its Phase 5
 * quality assessment - deterministic lookups only, no interpretation of
 * whether the price move is "good" or "bad" for the signal's direction
 * (that belongs to a later analysis/decision phase).
 */
export async function gatherMarketContext(
  db: Db,
  instrumentId: string,
  options: MarketContextOptions = {},
): Promise<MarketContext | null> {
  const conditions = [eq(schema.marketObservations.instrumentId, instrumentId)];
  if (options.asOf) conditions.push(lte(schema.marketObservations.observedAt, options.asOf));

  const [latest] = await db
    .select()
    .from(schema.marketObservations)
    .where(and(...conditions))
    .orderBy(desc(schema.marketObservations.observedAt))
    .limit(1);

  if (!latest) return null;

  const quality = await assessMarketObservation(db, latest.id);
  return { observation: latest, quality };
}
