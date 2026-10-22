import { and, desc, inArray, lte } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";

export interface MacroContextOptions {
  /** The relevance rule: only these series are used. Without it NO macro observation is used (the newest rows are not evidence). */
  seriesCodes?: string[];
  /** Optional additional relevance restriction by region (e.g. ["IN"]). */
  regions?: string[];
  limit?: number;
  /** No-look-ahead bound: only observations at or before this timestamp. Omit for unbounded. */
  asOf?: Date | undefined;
  /** Information cutoff: only rows RECEIVED at or before this instant. */
  receivedBy?: Date | undefined;
}

/**
 * Macro observations that an EXPLICIT relevance rule selects (series codes, optionally regions). Macro data has no
 * instrument link, so "the newest rows" say nothing about a given signal; without a relevance rule this returns an
 * empty list rather than arbitrary rows that would count as corroboration.
 */
export async function gatherMacroContext(
  db: Db,
  options: MacroContextOptions = {},
): Promise<Array<typeof schema.macroObservations.$inferSelect>> {
  if (!options.seriesCodes?.length) return [];
  const limit = options.limit ?? 10;
  const conditions = [inArray(schema.macroObservations.seriesCode, options.seriesCodes)];
  if (options.regions?.length) conditions.push(inArray(schema.macroObservations.region, options.regions));
  if (options.asOf) conditions.push(lte(schema.macroObservations.observedAt, options.asOf));
  if (options.receivedBy) conditions.push(lte(schema.macroObservations.receivedAt, options.receivedBy));

  return db
    .select()
    .from(schema.macroObservations)
    .where(and(...conditions))
    .orderBy(desc(schema.macroObservations.observedAt))
    .limit(limit);
}
