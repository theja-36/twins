import { and, count, eq, ne } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";

export interface PriorSignalStats {
  totalPriorSignalsForInstrument: number;
}

/**
 * Purely a count of prior signals already on record for this instrument -
 * NOT a performance/win-rate statistic. That requires independently
 * verified outcomes (spec section 19), which is Phase 9's job. Reporting
 * a raw count here is honest about what's actually available right now;
 * it does not imply anything about the source's track record.
 */
export async function gatherPriorSignalStats(
  db: Db,
  instrumentId: string,
  excludeSignalId?: string,
): Promise<PriorSignalStats> {
  const conditions = [eq(schema.signals.instrumentId, instrumentId)];
  if (excludeSignalId) conditions.push(ne(schema.signals.id, excludeSignalId));

  const [row] = await db
    .select({ value: count() })
    .from(schema.signals)
    .where(and(...conditions));

  return { totalPriorSignalsForInstrument: row?.value ?? 0 };
}
