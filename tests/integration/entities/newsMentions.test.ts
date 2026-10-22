import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createEntityWithCanonicalAlias, addAlias } from "../../../packages/entities/src/entities";
import { resolveNewsEntityMentions } from "../../../packages/entities/src/newsMentions";

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

async function makeArticle(headline: string, bodyExcerpt?: string): Promise<string> {
  const [source] = await db
    .insert(schema.newsSources)
    .values({ name: `source-${randomUUID()}`, tier: "B" })
    .returning();
  if (!source) throw new Error("failed to create news source");
  const [article] = await db
    .insert(schema.newsEvidence)
    .values({
      newsSourceId: source.id,
      sourceUrl: `https://example.invalid/${randomUUID()}`,
      headline,
      bodyExcerpt,
      sourceTimestamp: new Date(),
      dedupeHash: randomUUID(),
    })
    .returning();
  if (!article) throw new Error("failed to create article");
  return article.id;
}

describe("resolveNewsEntityMentions (integration)", () => {
  it("matches an article to an entity via its exact canonical name", async () => {
    const name = `Canonical Corp ${randomUUID().slice(0, 8)}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} reports quarterly earnings`);

    const result = await resolveNewsEntityMentions(db, articleId);
    expect(result.resolved.map((c) => c.entityId)).toContain(entityId);
    expect(result.resolved.find((c) => c.entityId === entityId)?.matchMethod).toBe("exact_canonical");
  });

  it("matches an article via a registered alias", async () => {
    const name = `Alias Co ${randomUUID().slice(0, 8)}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const ticker = `TICK${randomUUID().slice(0, 5).toUpperCase()}`;
    await addAlias(db, { entityId, alias: ticker, aliasType: "ticker" });
    const articleId = await makeArticle(`${ticker} shares rise after results`);

    const result = await resolveNewsEntityMentions(db, articleId);
    expect(result.resolved.map((c) => c.entityId)).toContain(entityId);
  });

  it("does not associate an irrelevant article with any entity", async () => {
    const articleId = await makeArticle(`Local weather remains pleasant this week ${randomUUID()}`);
    const result = await resolveNewsEntityMentions(db, articleId);
    expect(result.resolved).toHaveLength(0);
  });

  it("resolves multiple distinct entities mentioned in one article", async () => {
    const nameA = `MultiA ${randomUUID().slice(0, 8)}`;
    const nameB = `MultiB ${randomUUID().slice(0, 8)}`;
    const idA = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: nameA });
    const idB = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: nameB });
    const articleId = await makeArticle(`${nameA} and ${nameB} announce joint venture`);

    const result = await resolveNewsEntityMentions(db, articleId);
    const resolvedIds = result.resolved.map((c) => c.entityId);
    expect(resolvedIds).toEqual(expect.arrayContaining([idA, idB]));
  });

  it("leaves an ambiguous alias unlinked to either candidate entity", async () => {
    const sharedTicker = `AMBIG${randomUUID().slice(0, 5).toUpperCase()}`;
    const idA = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: `AmbigA ${randomUUID()}` });
    const idB = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: `AmbigB ${randomUUID()}` });
    await addAlias(db, { entityId: idA, alias: sharedTicker, aliasType: "ticker" });
    await addAlias(db, { entityId: idB, alias: sharedTicker, aliasType: "ticker" });

    const articleId = await makeArticle(`${sharedTicker} mentioned in market roundup`);
    const result = await resolveNewsEntityMentions(db, articleId);

    expect(result.resolved.map((c) => c.entityId)).not.toContain(idA);
    expect(result.resolved.map((c) => c.entityId)).not.toContain(idB);
    expect(result.ambiguous.length).toBeGreaterThan(0);
  });

  it("records provenance (matchedText + matchMethod) for every resolved relationship", async () => {
    const name = `Provenance Co ${randomUUID().slice(0, 8)}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} unveils new product line`);
    await resolveNewsEntityMentions(db, articleId);

    const [relationship] = await db
      .select()
      .from(schema.entityRelationships)
      .where(
        and(
          eq(schema.entityRelationships.subjectType, "news_evidence"),
          eq(schema.entityRelationships.subjectId, articleId),
          eq(schema.entityRelationships.objectId, entityId),
        ),
      );
    expect(relationship?.matchMethod).toBe("exact_canonical");
    expect(relationship?.matchedText).toBe(name);
    expect(relationship?.strength).toBe("direct");
  });

  it("is idempotent: processing the same article twice does not duplicate relationships", async () => {
    const name = `Idempotent Co ${randomUUID().slice(0, 8)}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const articleId = await makeArticle(`${name} posts record revenue`);

    await resolveNewsEntityMentions(db, articleId);
    await resolveNewsEntityMentions(db, articleId);

    const rows = await db
      .select()
      .from(schema.entityRelationships)
      .where(
        and(
          eq(schema.entityRelationships.subjectType, "news_evidence"),
          eq(schema.entityRelationships.subjectId, articleId),
          eq(schema.entityRelationships.objectId, entityId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
