import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { assembleSignalIntelligence } from "../../../packages/signals/src/engine";
import { createSignalFromTelegramMessage } from "../../../packages/signals/src/ingestSignal";
import { ingestMarketBars } from "../../../packages/ingestion/src/market";
import { ingestMacroObservations } from "../../../packages/ingestion/src/macro";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import {
  createEntityWithCanonicalAlias,
  linkInstrumentToCompany,
  resolveNewsEntityMentions,
} from "../../../packages/entities/src/index";
import { findInstrumentByExchangeSymbol } from "../../../packages/entities/src/instrumentMapping";
import { clusterNewsIntoEvent } from "../../../packages/entities/src/events";
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
  readonly providerName: string;
  constructor(private bars: NormalizedMarketBar[], providerName = "fixture-market") {
    this.providerName = providerName;
  }
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

async function makeTelegramMessage(rawText: string, messageTimestamp: Date): Promise<string> {
  const channelIdentifier = `chan-${randomUUID()}`;
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier }).returning();
  if (!source) throw new Error("failed to create telegram source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({ telegramSourceId: source.id, externalMessageId: "1", messageTimestamp, rawText })
    .returning();
  if (!message) throw new Error("failed to create telegram message");
  return message.id;
}

describe("assembleSignalIntelligence (Phase 8 engine, integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("assembles a full report: core + entity context + normalized evidence across all domains", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const signalTime = new Date("2026-02-01T00:00:00Z");
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, signalTime);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    const instrument = await findInstrumentByExchangeSymbol(db, "NSE", symbol);
    if (!instrument) throw new Error("instrument not created");
    const companyName = `Engine Co ${symbol}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrument.id, companyId);

    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([
        { instrument: { symbol, exchange: "NSE" }, source: "fixture-market", timeframe: "1d", observedAt: new Date(signalTime.getTime() - 1000 * 60 * 60), close: 100, open: 99, high: 101, low: 98 },
      ]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: signalTime, to: signalTime },
      { instrumentType: "equity" },
    );

    await ingestMacroObservations(
      db,
      new FixtureMacroProvider([{ source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(signalTime.getTime() - 1000 * 60 * 60), value: 6.5 }]),
      { region: "IN", seriesCode: "REPO_RATE" },
    );

    const newsUrl = `https://example.invalid/${randomUUID()}`;
    await ingestNewsItems(
      db,
      new FixtureNewsProvider([{ sourceName: `src-${randomUUID()}`, sourceTier: "B", sourceUrl: newsUrl, headline: `${companyName} reports earnings`, sourceTimestamp: new Date(signalTime.getTime() - 1000 * 60 * 60) }]),
      {},
    );
    const [newsRow] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, newsUrl));
    if (!newsRow) throw new Error("news not ingested");
    await resolveNewsEntityMentions(db, newsRow.id);
    await clusterNewsIntoEvent(db, newsRow.id);

    const report = await assembleSignalIntelligence(db, signalId, { macro: { seriesCodes: ["REPO_RATE"] } });

    expect(report.core.marketContext).not.toBeNull();
    expect(report.core.macroContext.length).toBeGreaterThan(0);
    expect(report.core.newsContext.length).toBeGreaterThan(0);
    expect(report.entityContext.company?.entityId).toBe(companyId);
    expect(report.entityContext.relevantEvents.length).toBeGreaterThan(0);

    const kinds = new Set(report.normalizedEvidence.map((e) => e.kind));
    expect(kinds).toEqual(
      new Set(["market_observation", "macro_observation", "news_evidence", "telegram_message", "entity_event"]),
    );

    // macro/news now carry Phase 5 quality, matching market/telegram (Phase 8 parity fix).
    const macroItem = report.normalizedEvidence.find((e) => e.kind === "macro_observation");
    const newsItem = report.normalizedEvidence.find((e) => e.kind === "news_evidence");
    expect(macroItem?.quality).toBeDefined();
    expect(newsItem?.quality).toBeDefined();

    expect(report.contextWindow.asOf.getTime()).toBe(signalTime.getTime());
  });

  it("enforces no-look-ahead: market/macro/news evidence reported AFTER the signal's timestamp is excluded", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const signalTime = new Date("2026-03-01T00:00:00Z");
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, signalTime);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    const instrument = await findInstrumentByExchangeSymbol(db, "NSE", symbol);
    if (!instrument) throw new Error("instrument not created");
    const companyName = `FutureEvidence Co ${symbol}`;
    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: companyName });
    await linkInstrumentToCompany(db, instrument.id, companyId);

    const futureTime = new Date(signalTime.getTime() + 1000 * 60 * 60 * 24);
    // A series code unique to this test - gatherMacroContext is a global,
    // non-instrument-scoped snapshot (unchanged Phase 6 design), so a
    // shared series code would legitimately pick up other tests' earlier
    // macro observations and defeat this test's isolation.
    const seriesCode = `SERIES-${randomUUID().slice(0, 8)}`;

    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([{ instrument: { symbol, exchange: "NSE" }, source: "fixture-market", timeframe: "1d", observedAt: futureTime, close: 999 }]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: futureTime, to: futureTime },
      { instrumentType: "equity" },
    );
    await ingestMacroObservations(
      db,
      new FixtureMacroProvider([{ source: "RBI", region: "IN", seriesCode, observedAt: futureTime, value: 9.9 }]),
      { region: "IN", seriesCode },
    );
    const newsUrl = `https://example.invalid/${randomUUID()}`;
    await ingestNewsItems(
      db,
      new FixtureNewsProvider([{ sourceName: `src-${randomUUID()}`, sourceTier: "B", sourceUrl: newsUrl, headline: `${companyName} announces future event`, sourceTimestamp: futureTime }]),
      {},
    );
    const [newsRow] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, newsUrl));
    if (!newsRow) throw new Error("news not ingested");
    await resolveNewsEntityMentions(db, newsRow.id);

    const report = await assembleSignalIntelligence(db, signalId, { macro: { seriesCodes: [seriesCode] } });

    expect(report.core.marketContext).toBeNull(); // the only bar is in the future
    expect(report.core.macroContext).toHaveLength(0);
    expect(report.core.newsContext).toHaveLength(0);
    expect(report.normalizedEvidence.some((e) => e.kind === "market_observation")).toBe(false);
    expect(report.normalizedEvidence.some((e) => e.kind === "macro_observation")).toBe(false);
    expect(report.normalizedEvidence.some((e) => e.kind === "news_evidence")).toBe(false);
  });

  it("surfaces a cross-source market conflict explicitly in the conflicts list, without altering the underlying rows", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const signalTime = new Date("2026-04-01T00:00:00Z");
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, signalTime);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    const observedAt = new Date(signalTime.getTime() - 1000 * 60 * 60);
    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([{ instrument: { symbol, exchange: "NSE" }, source: "provider-a", timeframe: "1d", observedAt, close: 100 }], "provider-a"),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: observedAt, to: observedAt },
      { instrumentType: "equity" },
    );
    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([{ instrument: { symbol, exchange: "NSE" }, source: "provider-b", timeframe: "1d", observedAt, close: 130 }], "provider-b"), // 30% disagreement
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: observedAt, to: observedAt },
      { instrumentType: "equity" },
    );

    // Two eligible sources exist, so the analysis input must be selected explicitly (no guessing); the cross-source
    // conflict is then still detected by the quality assessment against the other source.
    const report = await assembleSignalIntelligence(db, signalId, { market: { source: "provider-b" } });
    expect(report.conflicts.length).toBeGreaterThan(0);
    expect(report.conflicts[0]?.kind).toBe("market_observation");
  });

  it("surfaces stale evidence explicitly when a market bar exceeds the freshness threshold", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const signalTime = new Date(); // "now", so a very old bar is unambiguously stale under the default threshold
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, signalTime);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    const veryOld = new Date(signalTime.getTime() - 1000 * 60 * 60 * 24 * 30); // 30 days before "now"
    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([{ instrument: { symbol, exchange: "NSE" }, source: "fixture-market", timeframe: "1d", observedAt: veryOld, close: 100 }]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: veryOld, to: veryOld },
      { instrumentType: "equity" },
    );

    const report = await assembleSignalIntelligence(db, signalId);
    expect(report.staleEvidence.length).toBeGreaterThan(0);
  });

  it("is idempotent: re-running does not duplicate signal_evidence rows (reuses Phase 6's linking)", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const signalTime = new Date();
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, signalTime);
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    await ingestMarketBars(
      db,
      new FixtureMarketDataProvider([{ instrument: { symbol, exchange: "NSE" }, source: "fixture-market", timeframe: "1d", observedAt: signalTime, close: 100 }]),
      { instrument: { symbol, exchange: "NSE" }, timeframe: "1d", from: signalTime, to: signalTime },
      { instrumentType: "equity" },
    );

    await assembleSignalIntelligence(db, signalId);
    await assembleSignalIntelligence(db, signalId);

    const rows = await db.select().from(schema.signalEvidence).where(eq(schema.signalEvidence.signalId, signalId));
    const marketLinks = rows.filter((r) => r.evidenceKind === "market_observation");
    expect(marketLinks).toHaveLength(1);
  });

  it("never emits a trading decision - the report has no BUY/SELL/approve/reject field", async () => {
    const symbol = `ENG-${randomLetters(6)}`;
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`, new Date());
    const { signalId } = await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });
    if (!signalId) throw new Error("signal not created");

    const report = await assembleSignalIntelligence(db, signalId);
    const keys = Object.keys(report);
    for (const forbidden of ["decision", "approved", "rejected", "outcome", "riskDecision"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
