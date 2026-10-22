import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createEntityWithCanonicalAlias } from "../../../packages/entities/src/entities";
import { resolveNewsEntityMentions } from "../../../packages/entities/src/newsMentions";
import { clusterNewsIntoEvent, getEventAffectedEntities, getEventEvidence, reviseEvent } from "../../../packages/entities/src/events";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  await db.execute("select 1");
});
afterAll(async () => {
  const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
  await pool.end();
});

async function makeArticle(headline: string, sourceTimestamp: Date, sourceName?: string): Promise<string> {
  const [source] = await db
    .insert(schema.newsSources)
    .values({ name: sourceName ?? `source-${randomUUID()}`, tier: "B" })
    .returning();
  if (!source) throw new Error("failed to create news source");
  const [article] = await db
    .insert(schema.newsEvidence)
    .values({
      newsSourceId: source.id,
      sourceUrl: `https://example.invalid/${randomUUID()}`,
      headline,
      sourceTimestamp,
      dedupeHash: randomUUID(),
    })
    .returning();
  if (!article) throw new Error("failed to create article");
  return article.id;
}

describe("event clustering (integration)", () => {
  it("creates a new event for the first article and classifies its type", async () => {
    const name = `EventCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} announces quarterly earnings beat`, new Date());
    await resolveNewsEntityMentions(db, articleId);

    const outcome = await clusterNewsIntoEvent(db, articleId);
    expect(outcome.created).toBe(true);
    expect(outcome.ambiguous).toBe(false);

    const [event] = await db.select().from(schema.newsEvents).where(eq(schema.newsEvents.id, outcome.eventId));
    expect(event?.eventType).toBe("earnings");
  });

  it("clusters a second, independent article about the same entity within the time window into the SAME event", async () => {
    const name = `SharedEventCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const t0 = new Date("2026-03-01T09:00:00Z");

    const reutersId = await makeArticle(`${name} reports strong earnings`, t0, `Reuters-${randomUUID()}`);
    await resolveNewsEntityMentions(db, reutersId);
    const first = await clusterNewsIntoEvent(db, reutersId);

    const bloombergId = await makeArticle(
      `${name} beats expectations in latest quarter`,
      new Date(t0.getTime() + 1000 * 60 * 60 * 4), // 4 hours later, different source
      `Bloomberg-${randomUUID()}`,
    );
    await resolveNewsEntityMentions(db, bloombergId);
    const second = await clusterNewsIntoEvent(db, bloombergId);

    expect(second.eventId).toBe(first.eventId);
    expect(second.created).toBe(false);

    const evidence = await getEventEvidence(db, first.eventId);
    expect(evidence.map((e) => e.id).sort()).toEqual([reutersId, bloombergId].sort());
  });

  it("does NOT cluster two articles about the same entity that fall outside the time window", async () => {
    const name = `FarApartCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const t0 = new Date("2026-01-01T00:00:00Z");

    const articleA = await makeArticle(`${name} posts results`, t0);
    await resolveNewsEntityMentions(db, articleA);
    const first = await clusterNewsIntoEvent(db, articleA, { timeWindowMs: 1000 * 60 * 60 * 24 });

    const articleB = await makeArticle(
      `${name} posts results again`,
      new Date(t0.getTime() + 1000 * 60 * 60 * 24 * 30), // 30 days later
    );
    await resolveNewsEntityMentions(db, articleB);
    const second = await clusterNewsIntoEvent(db, articleB, { timeWindowMs: 1000 * 60 * 60 * 24 });

    expect(second.eventId).not.toBe(first.eventId);
    expect(second.created).toBe(true);
  });

  it("distinguishes duplicate articles (deduped at ingestion) from independent same-event evidence", async () => {
    // Two DIFFERENT sources reporting the same event become two evidence
    // rows on one event - this is the "5 independent reports" case, not
    // duplication (Phase 4's unique constraint already prevents true
    // duplicates - identical URL/source re-ingestion never reaches here).
    const name = `DistinctEvidenceCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const t0 = new Date();

    const a = await makeArticle(`${name} announces dividend`, t0, `Source A-${randomUUID()}`);
    await resolveNewsEntityMentions(db, a);
    const outcomeA = await clusterNewsIntoEvent(db, a);

    const b = await makeArticle(`${name} declares dividend payout`, t0, `Source B-${randomUUID()}`);
    await resolveNewsEntityMentions(db, b);
    const outcomeB = await clusterNewsIntoEvent(db, b);

    expect(outcomeA.eventId).toBe(outcomeB.eventId);
    const evidence = await getEventEvidence(db, outcomeA.eventId);
    expect(evidence).toHaveLength(2);
  });

  it("links AFFECTS relationships from the founding article's resolved entities", async () => {
    const name = `AffectsCo ${randomUUID().slice(0, 8)}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} completes acquisition of rival`, new Date());
    await resolveNewsEntityMentions(db, articleId);
    const outcome = await clusterNewsIntoEvent(db, articleId);

    const affected = await getEventAffectedEntities(db, outcome.eventId);
    expect(affected.map((e) => e.entityId)).toContain(entityId);
  });

  it("preserves event and article timestamps distinctly (event_time/first_seen_at vs source_timestamp/received_at)", async () => {
    const name = `TimestampCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const sourceTimestamp = new Date("2026-05-01T10:00:00Z");
    const articleId = await makeArticle(`${name} reports earnings`, sourceTimestamp);
    await resolveNewsEntityMentions(db, articleId);
    const outcome = await clusterNewsIntoEvent(db, articleId);

    const [event] = await db.select().from(schema.newsEvents).where(eq(schema.newsEvents.id, outcome.eventId));
    const [article] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.id, articleId));

    expect(event?.firstSeenAt.getTime()).toBe(sourceTimestamp.getTime());
    expect(article?.receivedAt.getTime()).not.toBe(sourceTimestamp.getTime());
  });

  it("preserves earlier evidence and logs revisions via audit_events rather than erasing history", async () => {
    const name = `RevisionCo ${randomUUID().slice(0, 8)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} under regulatory review`, new Date());
    await resolveNewsEntityMentions(db, articleId);
    const outcome = await clusterNewsIntoEvent(db, articleId);

    const [before] = await db.select().from(schema.newsEvents).where(eq(schema.newsEvents.id, outcome.eventId));
    await reviseEvent(db, outcome.eventId, { status: "confirmed", summary: "Regulator confirmed formal inquiry" });

    const [after] = await db.select().from(schema.newsEvents).where(eq(schema.newsEvents.id, outcome.eventId));
    expect(after?.status).toBe("confirmed");
    expect(after?.title).toBe(before?.title); // untouched field preserved

    const [audit] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, outcome.eventId));
    expect(audit?.eventType).toBe("news_event_revision");
    expect((audit?.beforeState as { status: string }).status).toBe("reported");

    // original evidence article is untouched
    const evidence = await getEventEvidence(db, outcome.eventId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.id).toBe(articleId);
  });
});
