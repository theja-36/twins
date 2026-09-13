import { and, desc, eq, lte } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { findIssuingCompany } from "./instrumentMapping";

/**
 * The company entity an instrument is issued by, if TWINS has been
 * configured with that mapping (spec: "Connect Phase 6 signals to
 * canonical entities/instruments"). Returns null - not a guess - when no
 * mapping has been configured for this instrument.
 */
export async function findEntityForInstrument(db: Db, instrumentId: string): Promise<string | null> {
  const company = await findIssuingCompany(db, instrumentId);
  return company?.entityId ?? null;
}

/**
 * News articles that structurally MENTION a given entity, most recent
 * first - the Phase 7 replacement for Phase 6's naive
 * `ILIKE "%symbol%"` (packages/signals/src/context/news.ts). Returns an
 * empty array, with no error, when nothing has been resolved to this
 * entity yet - an honest "nothing found", identical in shape to what the
 * naive path returned, so callers don't need to change how they handle
 * an empty result.
 *
 * `asOf` is optional and defaults to no bound (unchanged behavior for
 * existing callers). Phase 8 passes the signal's own timestamp here to
 * enforce no-look-ahead: an article first reported after the signal was
 * issued could not have informed it.
 */
export async function findNewsEvidenceMentioningEntity(
  db: Db,
  entityId: string,
  options: { limit?: number | undefined; asOf?: Date | undefined } = {},
) {
  const limit = options.limit ?? 5;
  const conditions = [
    eq(schema.entityRelationships.subjectType, "news_evidence"),
    eq(schema.entityRelationships.subjectId, schema.newsEvidence.id),
    eq(schema.entityRelationships.relationshipType, "MENTIONS"),
    eq(schema.entityRelationships.objectId, entityId),
  ];

  return db
    .select({
      id: schema.newsEvidence.id,
      newsSourceId: schema.newsEvidence.newsSourceId,
      newsEventId: schema.newsEvidence.newsEventId,
      sourceUrl: schema.newsEvidence.sourceUrl,
      headline: schema.newsEvidence.headline,
      bodyExcerpt: schema.newsEvidence.bodyExcerpt,
      sourceTimestamp: schema.newsEvidence.sourceTimestamp,
      receivedAt: schema.newsEvidence.receivedAt,
      dedupeHash: schema.newsEvidence.dedupeHash,
      rawPayload: schema.newsEvidence.rawPayload,
      createdAt: schema.newsEvidence.createdAt,
    })
    .from(schema.newsEvidence)
    .innerJoin(schema.entityRelationships, and(...conditions))
    .where(options.asOf ? lte(schema.newsEvidence.sourceTimestamp, options.asOf) : undefined)
    .orderBy(desc(schema.newsEvidence.sourceTimestamp))
    .limit(limit);
}
