import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createSignalFromTelegramMessage } from "../../../packages/signals/src/ingestSignal";
import { buildSignalIntelligence } from "../../../packages/signals/src/intelligence";
import { ingestMarketBars } from "../../../packages/ingestion/src/market";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import { ingestMacroObservations } from "../../../packages/ingestion/src/macro";
import {
  createEntityWithCanonicalAlias,
  linkInstrumentToCompany,
  resolveNewsEntityMentions,
} from "../../../packages/entities/src/index";
import { findInstrumentByExchangeSymbol } from "../../../packages/entities/src/instrumentMapping";
import type {
  MacroProvider,
  MarketDataProvider,
  NewsProvider,
  NormalizedMacroObservation,
  NormalizedMarketBar,
  NormalizedNewsItem,
} from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName = "fixture-market";
  constructor(private bars: NormalizedMarketBar[]) {}
  async getHistoricalBars() {
    return this.bars;
  }
  async getLatestQuote() {
    return null;
  }
  async getHealth() {
    return { providerName: this.providerName, providerType: "market" as const, status: "healthy" as const, checkedAt: new Date() };
  }
}

class FixtureNewsProvider implements NewsProvider {
  readonly providerName = "fixture-news";
  readonly sourceTier = "B" as const;
  constructor(private items: NormalizedNewsItem[]) {}
  async fetchLatest() {
    return this.items;
  }
  async getHealth() {
    return { providerName: this.providerName, providerType: "news" as const, status: "healthy" as const, checkedAt: new Date() };
  }
}

class FixtureMacroProvider implements MacroProvider {
  readonly providerName = "fixture-macro";
  constructor(private observations: NormalizedMacroObservation[]) {}
  async fetchSeries() {
    return this.observations;
  }
  async getHealth() {
    return { providerName: this.providerName, providerType: "macro" as const, status: "healthy" as const, checkedAt: new Date() };
  }
}

async function makeTelegramMessage(rawText: string): Promise<string> {
  const channelIdentifier = `chan-${randomUUID()}`;
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier }).returning();
  if (!source) throw new Error("failed to create telegram source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({ telegramSourceId: source.id, externalMessageId: "1", messageTimestamp: new Date(), rawText })
    .returning();
  if (!message) throw new Error("failed to create telegram message");
  return message.id;
}

describe("buildSignalIntelligence (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("assembles market, news, and macro context and links evidence", async () => {
    const symbol = `INT-${randomLetters(6)}`;
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, {
      exchange: "NSE",
      instrumentType: "equity",
    });
    if (!signalId) throw new Error("signal was not created");

    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([
        {
          instrument: { symbol, exchange: "NSE" },
          source: "fixture-market",
          timeframe: "1d",
          observedAt: new Date(),
          close: 100,
          open: 99,
          high: 101,
          low: 98,
        },
      ]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: new Date(), to: new Date() },
      { instrumentType: "equity" },
    );

    // Phase 7: news relevance is now entity-based, not naive ILIKE substring
    // matching - configure the instrument -> company mapping and let the
    // article's own text resolve against the entity registry, the same way
    // production ingestion + entity resolution would run as separate steps.
    const companyName = `Company ${symbol}`;
    const companyEntityId = await createEntityWithCanonicalAlias(db, {
      entityType: "company",
      canonicalName: companyName,
    });
    const instrument = await findInstrumentByExchangeSymbol(db, "NSE", symbol);
    if (!instrument) throw new Error("instrument was not created by createSignalFromTelegramMessage");
    await linkInstrumentToCompany(db, instrument.id, companyEntityId);

    const newsUrl = `https://example.invalid/${randomUUID()}`;
    await ingestNewsItems(
      db,
      new FixtureNewsProvider([
        {
          sourceName: `source-${randomUUID()}`,
          sourceTier: "B",
          sourceUrl: newsUrl,
          headline: `${companyName} announces strong quarterly results`,
          sourceTimestamp: new Date(),
        },
      ]),
      {},
    );
    const [newsRow] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, newsUrl));
    if (!newsRow) throw new Error("news article was not ingested");
    await resolveNewsEntityMentions(db, newsRow.id);

    await ingestMacroObservations(
      db,
      new FixtureMacroProvider([
        { source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), value: 6.5 },
      ]),
      { region: "IN", seriesCode: "REPO_RATE" },
    );

    const intelligence = await buildSignalIntelligence(db, signalId, {
      macro: { seriesCodes: ["REPO_RATE"] },
    });

    expect(intelligence.marketContext).not.toBeNull();
    expect(intelligence.marketContext?.observation.source).toBe("fixture-market");
    expect(intelligence.marketContext?.quality.overallStatus).toBeDefined();

    expect(intelligence.newsContext).toHaveLength(1);
    expect(intelligence.newsContext[0]?.sourceUrl).toBe(newsUrl);

    expect(intelligence.macroContext.length).toBeGreaterThan(0);

    expect(intelligence.telegramMessageQuality?.overallStatus).toBe("flagged"); // Telegram is never fully trusted
    expect(intelligence.originalTelegramMessage?.id).toBe(messageId);

    expect(intelligence.signal.status).toBe("analyzed");
    expect(intelligence.dataCompletenessNotes).toEqual([]);

    const evidenceRows = await db
      .select()
      .from(schema.signalEvidence)
      .where(eq(schema.signalEvidence.signalId, signalId));
    expect(evidenceRows.length).toBeGreaterThanOrEqual(3); // market + news + macro
  });

  it("records explicit completeness notes when no market/news/macro evidence exists", async () => {
    const symbol = `INT-${randomUUID().slice(0, 6)}`;
    const messageId = await makeTelegramMessage(`SELL ${symbol} @ 50 SL 55 TGT 40`);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, {
      exchange: "NSE",
      instrumentType: "equity",
    });
    if (!signalId) throw new Error("signal was not created");

    const intelligence = await buildSignalIntelligence(db, signalId, {
      macro: { seriesCodes: [`NONEXISTENT-${randomUUID()}`] },
    });

    expect(intelligence.marketContext).toBeNull();
    expect(intelligence.newsContext).toHaveLength(0);
    expect(intelligence.macroContext).toHaveLength(0);
    expect(intelligence.dataCompletenessNotes.length).toBeGreaterThanOrEqual(3);
    expect(intelligence.signal.status).toBe("analyzed");
  });

  it("is idempotent: re-running does not create duplicate signal_evidence rows", async () => {
    const symbol = `INT-${randomLetters(6)}`;
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, {
      exchange: "NSE",
      instrumentType: "equity",
    });
    if (!signalId) throw new Error("signal was not created");

    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([
        {
          instrument: { symbol, exchange: "NSE" },
          source: "fixture-market",
          timeframe: "1d",
          observedAt: new Date(),
          close: 100,
        },
      ]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: new Date(), to: new Date() },
      { instrumentType: "equity" },
    );

    await buildSignalIntelligence(db, signalId);
    await buildSignalIntelligence(db, signalId);

    const evidenceRows = await db
      .select()
      .from(schema.signalEvidence)
      .where(and(eq(schema.signalEvidence.signalId, signalId), eq(schema.signalEvidence.evidenceKind, "market_observation")));
    expect(evidenceRows).toHaveLength(1);
  });
});
