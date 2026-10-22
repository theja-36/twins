import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { gatherNewsContext } from "../../../packages/signals/src/context/news";
import { addAlias, createEntity, createEntityWithCanonicalAlias } from "../../../packages/entities/src/entities";
import { linkInstrumentToCompany } from "../../../packages/entities/src/instrumentMapping";
import { resolveNewsEntityMentions } from "../../../packages/entities/src/newsMentions";
import { resolveInstrument } from "../../../packages/ingestion/src/instruments";

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

async function makeArticle(headline: string): Promise<string> {
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
      sourceTimestamp: new Date(),
      dedupeHash: randomUUID(),
    })
    .returning();
  if (!article) throw new Error("failed to create article");
  return article.id;
}

/**
 * Proves the real, exported `gatherNewsContext()` production path - the
 * exact function packages/signals/src/intelligence.ts (Phase 6) calls -
 * actually runs through Phase 7 entity resolution end to end, not just
 * that the lower-level resolver functions work in isolation.
 */
describe("gatherNewsContext production path (integration)", () => {
  it("Article A: a headline containing the canonical company name is returned", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const companyName = `Canonical Co ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrumentId, companyId);

    const articleId = await makeArticle(`${companyName} reports record profits`);
    await resolveNewsEntityMentions(db, articleId);

    const result = await gatherNewsContext(db, instrumentId);
    expect(result.map((r) => r.id)).toContain(articleId);
  });

  it("Article B: a headline containing only the raw ticker/symbol, with NO entity relationship configured, is NOT returned", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const companyName = `TickerOnlyCo ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrumentId, companyId);
    // Deliberately do NOT register `symbol` as an alias of the company, and
    // do NOT run entity resolution against a symbol-only headline - this
    // reproduces exactly the shape of article the old ILIKE mechanism used
    // to match on ticker text alone.
    const articleId = await makeArticle(`${symbol} trades sideways in choppy session`);

    const result = await gatherNewsContext(db, instrumentId);
    expect(result.map((r) => r.id)).not.toContain(articleId);
  });

  it("Article C: a headline containing a registered alias of the canonical entity is returned", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const companyName = `Alias Co ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrumentId, companyId);
    const alias = `ALIASCO-${randomLetters(6)}`;
    await addAlias(db, { entityId: companyId, alias, aliasType: "ticker" });

    const articleId = await makeArticle(`${alias} shares climb after upgrade`);
    await resolveNewsEntityMentions(db, articleId);

    const result = await gatherNewsContext(db, instrumentId);
    expect(result.map((r) => r.id)).toContain(articleId);
  });

  it("Article D: a headline containing an alias shared by two entities (ambiguous) is NOT treated as a confirmed match for either", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const companyName = `AmbiguousCo ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrumentId, companyId);

    const sharedAlias = `SHARED-${randomLetters(6)}`;
    const otherCompanyId = await createEntity(db, { entityType: "company", canonicalName: `OtherCo ${randomUUID()}` });
    await addAlias(db, { entityId: companyId, alias: sharedAlias, aliasType: "ticker" });
    await addAlias(db, { entityId: otherCompanyId, alias: sharedAlias, aliasType: "ticker" });

    const articleId = await makeArticle(`${sharedAlias} mentioned in sector roundup`);
    const mentionResult = await resolveNewsEntityMentions(db, articleId);
    expect(mentionResult.resolved).toHaveLength(0);
    expect(mentionResult.ambiguous.length).toBeGreaterThan(0);

    const result = await gatherNewsContext(db, instrumentId);
    expect(result.map((r) => r.id)).not.toContain(articleId);
  });

  it("returns an empty array, not an error, when the instrument has no configured entity mapping at all", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const result = await gatherNewsContext(db, instrumentId);
    expect(result).toEqual([]);
  });

  it("rejects a raw symbol string where instrument.id is required, proving the parameter is genuinely a uuid FK lookup and not a re-labeled symbol match", async () => {
    const symbol = `NEWS-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const [instrument] = await db.select().from(schema.instruments).where(eq(schema.instruments.id, instrumentId));
    if (!instrument) throw new Error("instrument not found");

    // Calling with the raw symbol string (what the pre-Phase-7 signature
    // accepted) must NOT silently succeed - the underlying query targets a
    // uuid column, so a non-uuid string fails loudly at the database layer
    // rather than being quietly reinterpreted as a symbol to ILIKE-match.
    // This is stronger evidence than a graceful empty result: it proves
    // the call site genuinely changed shape rather than just being renamed.
    await expect(gatherNewsContext(db, instrument.symbol)).rejects.toBeTruthy();

    // The real production call (instrument.id) succeeds and returns cleanly.
    await expect(gatherNewsContext(db, instrument.id)).resolves.toEqual([]);
  });
});
