import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GdeltNewsAdapter } from "../../../adapters/news/src/gdelt";
import { createDb, schema } from "../../../packages/database/src/index";
import { createEntityWithCanonicalAlias } from "../../../packages/entities/src/entities";
import { linkInstrumentToCompany } from "../../../packages/entities/src/instrumentMapping";
import { resolveNewsEntityMentions } from "../../../packages/entities/src/newsMentions";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import { resolveInstrument } from "../../../packages/ingestion/src/instruments";
import { gatherNewsContext } from "../../../packages/signals/src/context/news";
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

/** A fixture whose URLs and headline are unique per run so repeated runs on the retained test database never collide. */
function uniqueFixture(tag: string, company: string): string {
  return JSON.stringify({ articles: [
    { url: `https://example.invalid/${tag}/a`, title: `TESTFIXTURE ${company} announces results`, seendate: "20261020T143000Z", domain: "example.invalid" },
    { url: `https://example.invalid/${tag}/b`, title: "TESTFIXTURE unrelated item", seendate: "20261020T150000Z" },
    { url: "not a url", title: "TESTFIXTURE malformed", seendate: "20261020T150000Z" },
  ] });
}

describe("GDELT items through the existing news ingestion path (offline transport)", () => {
  it("persists tier-D items with provenance, de-duplicates a repeat retrieval, and replay cutoff uses receipt time", async () => {
    const tag = randomUUID();
    const company = `Gdeltco ${randomLetters(8)}`;
    const body = uniqueFixture(tag, company);
    const adapter = new GdeltNewsAdapter({ transport: async () => ({ status: 200, bodyText: body }), query: "test-query" });

    const before = new Date();
    const first = await ingestNewsItems(db, adapter, {});
    const afterFirst = new Date();
    expect(first).toMatchObject({ fetched: 2, inserted: 2, duplicates: 0, rejectedInvalid: 0 });
    const second = await ingestNewsItems(db, adapter, {});
    expect(second).toMatchObject({ fetched: 2, inserted: 0, duplicates: 2 });

    const [source] = await db.select().from(schema.newsSources).where(eq(schema.newsSources.name, "gdelt-doc"));
    expect(source?.tier).toBe("D");
    const rows = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.newsSourceId, source!.id));
    const a = rows.find((r) => r.sourceUrl === `https://example.invalid/${tag}/a`)!;
    expect(a.sourceTimestamp.toISOString()).toBe("2026-10-20T14:30:00.000Z");
    expect(a.receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(a.rawPayload).toMatchObject({ timestampField: "seendate", publishedAtVerified: false, provider: "gdelt-doc" });

    // Replay: link the article to a company/instrument and read it back with the information cutoff.
    const symbol = `GD-${randomLetters(6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: company });
    await linkInstrumentToCompany(db, instrumentId, companyId);
    await resolveNewsEntityMentions(db, a.id);
    const asOf = new Date("2026-10-21T00:00:00Z"); // after the article's seendate
    expect((await gatherNewsContext(db, instrumentId, { asOf })).map((r) => r.id)).toContain(a.id);
    // Same as-of by source time, but a cutoff BEFORE this run received it: the later retrieval must not appear.
    expect((await gatherNewsContext(db, instrumentId, { asOf, receivedBy: new Date(before.getTime() - 1) })).map((r) => r.id)).not.toContain(a.id);
    expect((await gatherNewsContext(db, instrumentId, { asOf, receivedBy: new Date(afterFirst.getTime() + 1000) })).map((r) => r.id)).toContain(a.id);
  });
});
