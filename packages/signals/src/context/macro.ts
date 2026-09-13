import { and, desc, inArray, lte } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";

export interface MacroContextOptions {
  /** Restrict to specific series (e.g. ["REPO_RATE", "CPI"]); omit for a general snapshot. */
  seriesCodes?: string[];
  limit?: number;
  /** No-look-ahead bound: only observations at or before this timestamp. Omit for unbounded (Phase 6 default behavior). */
  asOf?: Date | undefined;
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
  const conditions = [];
  if (options.seriesCodes?.length) conditions.push(inArray(schema.macroObservations.seriesCode, options.seriesCodes));
  if (options.asOf) conditions.push(lte(schema.macroObservations.observedAt, options.asOf));

  return db
    .select()
    .from(schema.macroObservations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.macroObservations.observedAt))
    .limit(limit);
}
