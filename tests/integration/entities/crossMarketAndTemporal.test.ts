import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createEntityWithCanonicalAlias } from "../../../packages/entities/src/entities";
import { resolveNewsEntityMentions } from "../../../packages/entities/src/newsMentions";
import { clusterNewsIntoEvent } from "../../../packages/entities/src/events";
import {
  linkCompanyToSector,
  linkEntityToCountry,
  linkInstrumentToCompany,
} from "../../../packages/entities/src/instrumentMapping";
import { gatherSignalEntityContext } from "../../../packages/entities/src/signalContext";
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

async function makeArticle(headline: string, sourceTimestamp: Date, sourceName: string): Promise<string> {
  const [source] = await db.insert(schema.newsSources).values({ name: sourceName, tier: "B" }).returning();
  if (!source) throw new Error("failed to create source");
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

async function makeSignal(instrumentId: string, signalTimestamp: Date): Promise<string> {
  const [source] = await db
    .insert(schema.telegramSources)
    .values({ channelIdentifier: `chan-${randomUUID()}` })
    .returning();
  if (!source) throw new Error("failed to create telegram source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({
      telegramSourceId: source.id,
      externalMessageId: "1",
      messageTimestamp: signalTimestamp,
      rawText: "BUY placeholder",
    })
    .returning();
  if (!message) throw new Error("failed to create telegram message");
  const [signal] = await db
    .insert(schema.signals)
    .values({
        parserVersion: "test-fixture",
      sourceType: "telegram",
      telegramMessageId: message.id,
      instrumentId,
      direction: "buy",
      targets: [],
      signalTimestamp,
    })
    .returning();
  if (!signal) throw new Error("failed to create signal");
  return signal.id;
}

describe("cross-market context (integration)", () => {
  it("supports a global (US) event linked to a US company and country", async () => {
    const name = `USCo ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const usId = await createEntityWithCanonicalAlias(db, { entityType: "country", canonicalName: `United States-${randomUUID()}` });
    await linkEntityToCountry(db, companyId, usId);

    const articleId = await makeArticle(`${name} reports earnings`, new Date(), `US Wire-${randomUUID()}`);
    const result = await resolveNewsEntityMentions(db, articleId);
    expect(result.resolved.map((c) => c.entityId)).toContain(companyId);
  });

  it("links a shared macro entity mentioned by both a global and an India source into one event", async () => {
    const fedName = `Federal Reserve ${randomUUID().slice(0, 6)}`;
    await createEntityWithCanonicalAlias(db, { entityType: "macro", canonicalName: fedName });
    const t0 = new Date("2026-04-01T12:00:00Z");

    const usArticle = await makeArticle(`${fedName} raises interest rates`, t0, `US Financial Times-${randomUUID()}`);
    await resolveNewsEntityMentions(db, usArticle);
    const first = await clusterNewsIntoEvent(db, usArticle);

    const indiaArticle = await makeArticle(
      `Markets react as ${fedName} raises interest rates`,
      new Date(t0.getTime() + 1000 * 60 * 60 * 6),
      `Economic Times-${randomUUID()}`,
    );
    await resolveNewsEntityMentions(db, indiaArticle);
    const second = await clusterNewsIntoEvent(db, indiaArticle);

    expect(second.eventId).toBe(first.eventId); // one canonical event, evidenced from both regions
  });

  it("does not present an unmapped cross-asset link as fact - absence of configuration means no relationship, not a guessed one", async () => {
    const symbol = `CROSS-${randomUUID().slice(0, 6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const rows = await db
      .select()
      .from(schema.entityRelationships)
      .where(and(eq(schema.entityRelationships.subjectType, "instrument"), eq(schema.entityRelationships.subjectId, instrumentId)));
    expect(rows).toHaveLength(0); // no speculative crude-oil/energy-sector link fabricated
  });
});

describe("temporal safety / no look-ahead (integration)", () => {
  it("excludes an event first reported AFTER the signal's own timestamp", async () => {
    const name = `TemporalCo ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const instrumentId = await resolveInstrument(db, { symbol: `T-${randomUUID().slice(0, 6)}`, exchange: "NSE" }, "equity");
    await linkInstrumentToCompany(db, instrumentId, companyId);

    const signalTime = new Date("2026-06-01T00:00:00Z");
    const signalId = await makeSignal(instrumentId, signalTime);

    // article/event reported AFTER the signal
    const futureArticle = await makeArticle(`${name} announces merger`, new Date(signalTime.getTime() + 1000 * 60 * 60 * 24), `Later Wire-${randomUUID()}`);
    await resolveNewsEntityMentions(db, futureArticle);
    await clusterNewsIntoEvent(db, futureArticle);

    const context = await gatherSignalEntityContext(db, signalId);
    expect(context.relevantEvents).toHaveLength(0);
  });

  it("includes an event known at or before the signal's timestamp", async () => {
    const name = `TemporalCo2 ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const instrumentId = await resolveInstrument(db, { symbol: `T2-${randomUUID().slice(0, 6)}`, exchange: "NSE" }, "equity");
    await linkInstrumentToCompany(db, instrumentId, companyId);

    const earlierTime = new Date("2026-06-01T00:00:00Z");
    const priorArticle = await makeArticle(`${name} posts earnings`, earlierTime, `Earlier Wire-${randomUUID()}`);
    await resolveNewsEntityMentions(db, priorArticle);
    await clusterNewsIntoEvent(db, priorArticle);

    const signalId = await makeSignal(instrumentId, new Date(earlierTime.getTime() + 1000 * 60 * 60));
    const context = await gatherSignalEntityContext(db, signalId);
    expect(context.relevantEvents.length).toBeGreaterThan(0);
  });
});

describe("Telegram -> canonical instrument integration (integration)", () => {
  it("resolves a signal to its canonical instrument, company, sector, and market via configured mappings", async () => {
    const name = `TelegramLinkCo ${randomUUID().slice(0, 8)}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const sectorId = await createEntityWithCanonicalAlias(db, { entityType: "sector", canonicalName: `Energy-${randomUUID()}` });
    await linkCompanyToSector(db, companyId, sectorId);

    const instrumentId = await resolveInstrument(db, { symbol: `TL-${randomUUID().slice(0, 6)}`, exchange: "NSE" }, "equity");
    await linkInstrumentToCompany(db, instrumentId, companyId);

    const signalId = await makeSignal(instrumentId, new Date());
    const context = await gatherSignalEntityContext(db, signalId);

    expect(context.company?.entityId).toBe(companyId);
    expect(context.sector?.entityId).toBe(sectorId);
  });

  it("leaves an ambiguous/unmapped instrument's entity context null rather than guessing", async () => {
    const instrumentId = await resolveInstrument(db, { symbol: `NOENTITY-${randomUUID().slice(0, 6)}`, exchange: "NSE" }, "equity");
    const signalId = await makeSignal(instrumentId, new Date());
    const context = await gatherSignalEntityContext(db, signalId);
    expect(context.company).toBeNull();
    expect(context.sector).toBeNull();
  });
});
