import { and, eq, lte } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { findCountry, findIssuingCompany, findSector, findTradedMarket } from "./instrumentMapping";
import type { RelatedEntity } from "./relationships";

export interface SignalEntityContext {
  company: RelatedEntity | null;
  sector: RelatedEntity | null;
  market: RelatedEntity | null;
  country: RelatedEntity | null;
  /** Events affecting the company, known as of the signal's own timestamp - never later ones (no look-ahead). */
  relevantEvents: Array<{ id: string; title: string; eventType: string | null; firstSeenAt: Date }>;
}

/**
 * Assembles the entity/event context for an already-created Phase 6
 * signal (spec: "Do not use entity/event intelligence to approve the
 * signal. This only creates better context for the later Decision
 * Engine."). This is a standalone function - it does not modify or
 * extend Phase 6's `SignalIntelligence` type or `buildSignalIntelligence`
 * contract; a future Decision Engine phase composes both.
 *
 * Temporal safety: only events whose `firstSeenAt` is at or before the
 * signal's own `signalTimestamp` are included - an event first reported
 * after the signal was issued could not have informed it (spec: "No
 * look-ahead").
 */
export async function gatherSignalEntityContext(db: Db, signalId: string): Promise<SignalEntityContext> {
  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) throw new Error(`signals row not found: ${signalId}`);

  const company = await findIssuingCompany(db, signal.instrumentId);
  const market = await findTradedMarket(db, signal.instrumentId);
  const sector = company ? await findSector(db, company.entityId) : null;
  const country = company ? await findCountry(db, company.entityId) : null;

  let relevantEvents: SignalEntityContext["relevantEvents"] = [];
  if (company) {
    const rows = await db
      .select({
        id: schema.newsEvents.id,
        title: schema.newsEvents.title,
        eventType: schema.newsEvents.eventType,
        firstSeenAt: schema.newsEvents.firstSeenAt,
      })
      .from(schema.entityRelationships)
      .innerJoin(schema.newsEvents, eq(schema.entityRelationships.subjectId, schema.newsEvents.id))
      .where(
        and(
          eq(schema.entityRelationships.subjectType, "news_events"),
          eq(schema.entityRelationships.relationshipType, "AFFECTS"),
          eq(schema.entityRelationships.objectId, company.entityId),
          lte(schema.newsEvents.firstSeenAt, signal.signalTimestamp),
        ),
      );
    relevantEvents = rows;
  }

  return { company, sector, market, country, relevantEvents };
}
