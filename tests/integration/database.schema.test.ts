import { requireTestDatabaseUrl } from "./targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../packages/database/src/index";
import { createRiskDecision } from "../../packages/risk/src/index";

/**
 * Integration tests run against a real PostgreSQL instance (spec section
 * 47 - Postgres is the source of record, so its actual constraint
 * enforcement is what matters, not a mock). Requires DATABASE_URL to
 * point at a disposable development database with Phase 2 migrations
 * already applied.
 */
const DATABASE_URL =
  requireTestDatabaseUrl();

const db = createDb(DATABASE_URL);

async function insertUser() {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning();
  if (!user) throw new Error("insert did not return a row");
  return user;
}

async function insertInstrument() {
  const [instrument] = await db
    .insert(schema.instruments)
    .values({
      symbol: `TEST-${randomUUID().slice(0, 8)}`,
      exchange: "NSE",
      instrumentType: "equity",
    })
    .returning();
  if (!instrument) throw new Error("insert did not return a row");
  return instrument;
}

describe("database schema (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });

  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } })
      .$client;
    await pool.end();
  });

  it("connects and can round-trip a row", async () => {
    const user = await insertUser();
    const [found] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(found?.email).toBe(user.email);
  });

  it("enforces unique (exchange, symbol) on instruments", async () => {
    const symbol = `DUP-${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.instruments)
      .values({ symbol, exchange: "NSE", instrumentType: "equity" });

    await expect(
      db
        .insert(schema.instruments)
        .values({ symbol, exchange: "NSE", instrumentType: "equity" }),
    ).rejects.toThrow();
  });

  it("enforces telegram_messages idempotency on (source, external_message_id)", async () => {
    const [source] = await db
      .insert(schema.telegramSources)
      .values({ channelIdentifier: `chan-${randomUUID()}` })
      .returning();
    if (!source) throw new Error("insert did not return a row");

    const externalMessageId = "msg-1";
    await db.insert(schema.telegramMessages).values({
      telegramSourceId: source.id,
      externalMessageId,
      messageTimestamp: new Date(),
      rawText: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
    });

    await expect(
      db.insert(schema.telegramMessages).values({
        telegramSourceId: source.id,
        externalMessageId,
        messageTimestamp: new Date(),
        rawText: "a retried copy of the same message",
      }),
    ).rejects.toThrow();
  });

  it("enforces market_observations idempotency on (instrument, source, timeframe, observed_at)", async () => {
    const instrument = await insertInstrument();
    const observedAt = new Date("2026-01-02T09:15:00Z");

    await db.insert(schema.marketObservations).values({
      instrumentId: instrument.id,
      source: "test-provider",
      timeframe: "1d",
      observedAt,
      close: "100.00",
    });

    await expect(
      db.insert(schema.marketObservations).values({
        instrumentId: instrument.id,
        source: "test-provider",
        timeframe: "1d",
        observedAt,
        close: "999.00",
      }),
    ).rejects.toThrow();
  });

  it("rejects signal_evidence rows with zero evidence references", async () => {
    const instrument = await insertInstrument();
    const [signal] = await db
      .insert(schema.signals)
      .values({
        parserVersion: "test-fixture",
        sourceType: "manual",
        instrumentId: instrument.id,
        direction: "buy",
        signalTimestamp: new Date(),
      })
      .returning();
    if (!signal) throw new Error("insert did not return a row");

    await expect(
      db.insert(schema.signalEvidence).values({
        signalId: signal.id,
        evidenceKind: "market_observation",
        // no market_observation_id / macro_observation_id / news_evidence_id set
      }),
    ).rejects.toThrow();
  });

  it("rejects signal_evidence rows with more than one evidence reference", async () => {
    const instrument = await insertInstrument();
    const [signal] = await db
      .insert(schema.signals)
      .values({
        parserVersion: "test-fixture",
        sourceType: "manual",
        instrumentId: instrument.id,
        direction: "sell",
        signalTimestamp: new Date(),
      })
      .returning();
    if (!signal) throw new Error("insert did not return a row");

    const [marketObs] = await db
      .insert(schema.marketObservations)
      .values({
        instrumentId: instrument.id,
        source: "test-provider",
        timeframe: "1d",
        observedAt: new Date(),
      })
      .returning();
    const [macroObs] = await db
      .insert(schema.macroObservations)
      .values({
        source: "RBI",
        region: "IN",
        seriesCode: "REPO_RATE",
        observedAt: new Date(),
        value: "6.5",
      })
      .returning();
    if (!marketObs || !macroObs) throw new Error("insert did not return a row");

    await expect(
      db.insert(schema.signalEvidence).values({
        signalId: signal.id,
        evidenceKind: "market_observation",
        marketObservationId: marketObs.id,
        macroObservationId: macroObs.id,
      }),
    ).rejects.toThrow();
  });

  it("accepts a valid signal_evidence row and enforces evidenceKind match", async () => {
    const instrument = await insertInstrument();
    const [signal] = await db
      .insert(schema.signals)
      .values({
        parserVersion: "test-fixture",
        sourceType: "manual",
        instrumentId: instrument.id,
        direction: "buy",
        signalTimestamp: new Date(),
      })
      .returning();
    const [marketObs] = await db
      .insert(schema.marketObservations)
      .values({
        instrumentId: instrument.id,
        source: "test-provider",
        timeframe: "1d",
        observedAt: new Date(),
      })
      .returning();
    if (!signal || !marketObs) throw new Error("insert did not return a row");

    // kind mismatch should fail even with exactly one reference set
    await expect(
      db.insert(schema.signalEvidence).values({
        signalId: signal.id,
        evidenceKind: "macro_observation", // mismatched on purpose
        marketObservationId: marketObs.id,
      }),
    ).rejects.toThrow();

    const [valid] = await db
      .insert(schema.signalEvidence)
      .values({
        signalId: signal.id,
        evidenceKind: "market_observation",
        marketObservationId: marketObs.id,
      })
      .returning();
    expect(valid?.evidenceKind).toBe("market_observation");
  });

  it("pins accounts to a single trading mode and enforces order idempotency keys", async () => {
    const user = await insertUser();
    const [account] = await db
      .insert(schema.accounts)
      .values({ userId: user.id, name: "paper-account", tradingMode: "paper" })
      .returning();
    const instrument = await insertInstrument();
    if (!account) throw new Error("insert did not return a row");

    // Stage 3: an order requires a risk decision that is currently APPROVED_FOR_REVIEW (database guard); build the minimal valid chain for it.
    const [sig] = await db.insert(schema.signals).values({ sourceType: "synthetic", instrumentId: instrument.id, parserVersion: "schema-test", direction: "buy", entryPrice: "100", stopLoss: "95", signalTimestamp: new Date() }).returning();
    if (!sig) throw new Error("insert did not return a row");
    const [stop] = await db.insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: sig.id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
    if (!stop) throw new Error("insert did not return a row");
    const risk = await createRiskDecision(db, { subject: { kind: "signal", signalId: sig.id }, stopLossValidationId: stop.id, status: "APPROVED_FOR_REVIEW", plannedQuantity: 100, plannedNotional: 10000, plannedMaxLossAmount: 500, plannedMaxLossPercent: 0.5, outputSnapshot: { sizing: { status: "SIZED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW" }, market: { outcome: "PASSED" } }, idempotencyKey: `schema-test:${randomUUID()}`, createdBy: "service:schema-test", instrumentType: "equity", symbol: instrument.symbol, entryPrice: 100, stopLoss: 95, stopLossBasis: "price", decisionReasonCode: "schema_test", inputSnapshot: { synthetic: true } });

    const idempotencyKey = `order-${randomUUID()}`;
    await db.insert(schema.orders).values({
      accountId: account.id,
      instrumentId: instrument.id,
      riskDecisionId: risk.id,
      tradingMode: "paper",
      side: "buy",
      orderType: "market",
      quantity: "10",
      idempotencyKey,
    });

    await expect(
      db.insert(schema.orders).values({
        accountId: account.id,
        instrumentId: instrument.id,
        riskDecisionId: risk.id,
        tradingMode: "paper",
        side: "buy",
        orderType: "market",
        quantity: "10",
        idempotencyKey, // simulated retry of the same request
      }),
    ).rejects.toThrow();
  });

  it("restricts deleting a user that owns an account (no orphaned trading state)", async () => {
    const user = await insertUser();
    await db
      .insert(schema.accounts)
      .values({ userId: user.id, name: "paper-account", tradingMode: "paper" });

    await expect(
      db.delete(schema.users).where(eq(schema.users.id, user.id)),
    ).rejects.toThrow();
  });
});
