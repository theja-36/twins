import { schema } from "@twins/database";
import { findEntityForInstrument, findNewsEvidenceMentioningEntity } from "@twins/entities";
import type { Db } from "../db";

export interface NewsContextOptions {
  limit?: number | undefined;
}

/**
 * Phase 7 replaced the original naive `ILIKE "%symbol%"` substring match
 * here with structured entity resolution (@twins/entities) - the same
 * exported name/shape is kept so packages/signals/src/intelligence.ts
 * (Phase 6) and its callers needed no changes beyond passing an
 * instrument id instead of a raw symbol string. There is now exactly one
 * news-relevance mechanism in the codebase, not two competing ones: if no
 * ISSUED_BY mapping has been configured for the instrument, this
 * honestly returns an empty array rather than falling back to substring
 * matching.
 */
export async function gatherNewsContext(
  db: Db,
  instrumentId: string,
  options: NewsContextOptions = {},
): Promise<Array<typeof schema.newsEvidence.$inferSelect>> {
  const entityId = await findEntityForInstrument(db, instrumentId);
  if (!entityId) return [];
  return findNewsEvidenceMentioningEntity(db, entityId, { limit: options.limit });
}
