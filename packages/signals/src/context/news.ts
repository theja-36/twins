import { desc, ilike } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";

export interface NewsContextOptions {
  limit?: number | undefined;
}

/**
 * Naive, deterministic instrument-mention matching against news
 * headlines (a plain SQL ILIKE - no NLP, no AI). This is intentionally
 * lightweight: proper entity extraction and event clustering belong to
 * Phase 7 (News + event intelligence), which hasn't run yet. Absence of
 * a match here means "no textual mention found", not "no news exists".
 */
export async function gatherNewsContext(
  db: Db,
  instrumentSymbol: string,
  options: NewsContextOptions = {},
): Promise<Array<typeof schema.newsEvidence.$inferSelect>> {
  const limit = options.limit ?? 5;
  return db
    .select()
    .from(schema.newsEvidence)
    .where(ilike(schema.newsEvidence.headline, `%${instrumentSymbol}%`))
    .orderBy(desc(schema.newsEvidence.sourceTimestamp))
    .limit(limit);
}
