import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { classifyEventType } from "./eventClassification";
import { getRelatedEntities, linkEntities } from "./relationships";

export interface ClusterOptions {
  /** How close in time two articles must be to be considered the same event. Default 72h. */
  timeWindowMs?: number;
}

export interface ClusterOutcome {
  eventId: string;
  created: boolean;
  ambiguous: boolean;
}

const DEFAULT_TIME_WINDOW_MS = 1000 * 60 * 60 * 72;

/**
 * Clusters a news_evidence row into a news_events row (spec: "Multiple
 * articles can describe the same underlying event ... group related news
 * into a canonical event where justified"). Distinct from Phase 4's
 * dedupe (identical/reposted URLs collapse at ingestion time via the
 * news_evidence unique constraint) - this groups already-distinct
 * articles.
 *
 * Candidate matching is deliberately narrow: only a shared COMPANY or
 * MACRO entity mention within the time window counts (spec: "Do NOT
 * merge articles merely because they mention the same company" - a
 * shared company mention alone is necessary but not sufficient; the time
 * window is the second, independent signal). Broad entities (sector,
 * country, market) are excluded from triggering a match - two unrelated
 * articles both mentioning "India" within 72h are not the same event.
 *
 * If more than one existing event is a candidate, clustering is
 * ambiguous and the article is left unclustered rather than guessed into
 * either one.
 */
export async function clusterNewsIntoEvent(
  db: Db,
  newsEvidenceId: string,
  options: ClusterOptions = {},
): Promise<ClusterOutcome> {
  const timeWindowMs = options.timeWindowMs ?? DEFAULT_TIME_WINDOW_MS;

  const [article] = await db
    .select()
    .from(schema.newsEvidence)
    .where(eq(schema.newsEvidence.id, newsEvidenceId));
  if (!article) throw new Error(`news_evidence row not found: ${newsEvidenceId}`);

  if (article.newsEventId) return { eventId: article.newsEventId, created: false, ambiguous: false };

  const mentionedEntities = await db
    .select({
      entityId: schema.entities.id,
      entityType: schema.entities.entityType,
    })
    .from(schema.entityRelationships)
    .innerJoin(schema.entities, eq(schema.entityRelationships.objectId, schema.entities.id))
    .where(
      and(
        eq(schema.entityRelationships.subjectType, "news_evidence"),
        eq(schema.entityRelationships.subjectId, newsEvidenceId),
        eq(schema.entityRelationships.relationshipType, "MENTIONS"),
        inArray(schema.entities.entityType, ["company", "macro"]),
      ),
    );

  const windowStart = new Date(article.sourceTimestamp.getTime() - timeWindowMs);
  const windowEnd = new Date(article.sourceTimestamp.getTime() + timeWindowMs);

  const candidateEventIds = new Set<string>();
  if (mentionedEntities.length > 0) {
    const otherArticlesWithSharedEntity = await db
      .select({ newsEventId: schema.newsEvidence.newsEventId })
      .from(schema.newsEvidence)
      .innerJoin(
        schema.entityRelationships,
        and(
          eq(schema.entityRelationships.subjectType, "news_evidence"),
          eq(schema.entityRelationships.subjectId, schema.newsEvidence.id),
          eq(schema.entityRelationships.relationshipType, "MENTIONS"),
          inArray(
            schema.entityRelationships.objectId,
            mentionedEntities.map((e) => e.entityId),
          ),
        ),
      )
      .where(
        and(
          ne(schema.newsEvidence.id, newsEvidenceId),
          gte(schema.newsEvidence.sourceTimestamp, windowStart),
          lte(schema.newsEvidence.sourceTimestamp, windowEnd),
        ),
      );

    for (const row of otherArticlesWithSharedEntity) {
      if (row.newsEventId) candidateEventIds.add(row.newsEventId);
    }
  }

  if (candidateEventIds.size > 1) {
    return { eventId: "", created: false, ambiguous: true };
  }

  let eventId: string;
  let created = false;

  if (candidateEventIds.size === 1) {
    eventId = Array.from(candidateEventIds)[0]!;
  } else {
    const eventType = classifyEventType(`${article.headline} ${article.bodyExcerpt ?? ""}`);
    const [inserted] = await db
      .insert(schema.newsEvents)
      .values({
        title: article.headline,
        eventType,
        firstSeenAt: article.sourceTimestamp,
        eventTime: article.sourceTimestamp,
      })
      .returning({ id: schema.newsEvents.id });
    if (!inserted) throw new Error("failed to create news_events row");
    eventId = inserted.id;
    created = true;

    for (const entity of mentionedEntities) {
      await linkEntities(db, {
        subjectType: "news_events",
        subjectId: eventId,
        relationshipType: "AFFECTS",
        objectId: entity.entityId,
        strength: "direct",
        matchMethod: "deterministic_rule",
        matchedText: article.headline,
      });
    }
  }

  await db
    .update(schema.newsEvidence)
    .set({ newsEventId: eventId })
    .where(eq(schema.newsEvidence.id, newsEvidenceId));

  return { eventId, created, ambiguous: false };
}

/**
 * Updates a news_events row's mutable fields, logging the prior state to
 * audit_events first (spec: "Preserve event history/versioning ...
 * Do not erase earlier evidence"). The linked news_evidence rows
 * themselves are never touched - only this row's own summary fields.
 */
export async function reviseEvent(
  db: Db,
  eventId: string,
  changes: Partial<{ title: string; summary: string; eventType: (typeof schema.newsEventTypeEnum.enumValues)[number]; status: (typeof schema.newsEventStatusEnum.enumValues)[number] }>,
): Promise<void> {
  const [before] = await db.select().from(schema.newsEvents).where(eq(schema.newsEvents.id, eventId));
  if (!before) throw new Error(`news_events row not found: ${eventId}`);

  await db.insert(schema.auditEvents).values({
    eventType: "news_event_revision",
    entityType: "news_events",
    entityId: eventId,
    actorType: "system",
    beforeState: before,
    afterState: { ...before, ...changes },
  });

  await db
    .update(schema.newsEvents)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(schema.newsEvents.id, eventId));
}

/** All evidence articles linked to an event, oldest first - never filtered/hidden, only ordered. */
export async function getEventEvidence(db: Db, eventId: string) {
  return db
    .select()
    .from(schema.newsEvidence)
    .where(eq(schema.newsEvidence.newsEventId, eventId))
    .orderBy(schema.newsEvidence.sourceTimestamp);
}

/** Entities an event AFFECTS, as configured/derived so far - never a speculative causal chain. */
export async function getEventAffectedEntities(db: Db, eventId: string) {
  return getRelatedEntities(db, "news_events", eventId, "AFFECTS");
}
