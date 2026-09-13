import { desc, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { assessMarketObservation, type QualityAssessmentResult } from "@twins/dataquality";
import type { Db } from "../db";

export interface MarketContext {
  observation: typeof schema.marketObservations.$inferSelect;
  quality: QualityAssessmentResult;
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
): Promise<MarketContext | null> {
  const [latest] = await db
    .select()
    .from(schema.marketObservations)
    .where(eq(schema.marketObservations.instrumentId, instrumentId))
    .orderBy(desc(schema.marketObservations.observedAt))
    .limit(1);

  if (!latest) return null;

  const quality = await assessMarketObservation(db, latest.id);
  return { observation: latest, quality };
}
