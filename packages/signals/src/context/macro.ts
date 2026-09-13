import { desc, inArray } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";

export interface MacroContextOptions {
  /** Restrict to specific series (e.g. ["REPO_RATE", "CPI"]); omit for a general snapshot. */
  seriesCodes?: string[];
  limit?: number;
}

/**
 * A general macro snapshot - not instrument-specific (macro data has no
 * FK to instruments), just "what does TWINS currently know about
 * macro conditions" (spec: macro context is part of signal intelligence,
 * independent of any single instrument).
 */
export async function gatherMacroContext(
  db: Db,
  options: MacroContextOptions = {},
): Promise<Array<typeof schema.macroObservations.$inferSelect>> {
  const limit = options.limit ?? 10;
  const query = db.select().from(schema.macroObservations);

  const rows = options.seriesCodes?.length
    ? await query
        .where(inArray(schema.macroObservations.seriesCode, options.seriesCodes))
        .orderBy(desc(schema.macroObservations.observedAt))
        .limit(limit)
    : await query.orderBy(desc(schema.macroObservations.observedAt)).limit(limit);

  return rows;
}
