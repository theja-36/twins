import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestMarketBars } from "../../../packages/ingestion/src/market";
import type { MarketBarRequest, MarketDataProvider, NormalizedMarketBar } from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName = "fixture-market";
  constructor(private bars: NormalizedMarketBar[]) {}

  async getHistoricalBars(): Promise<NormalizedMarketBar[]> {
    return this.bars;
  }
  async getLatestQuote(): Promise<NormalizedMarketBar | null> {
    return null;
  }
  async getHealth() {
    return {
      providerName: this.providerName,
      providerType: "market" as const,
      status: "healthy" as const,
      checkedAt: new Date(),
    };
  }
}

function baseRequest(symbol: string): MarketBarRequest {
  return {
    instrument: { symbol, exchange: "NSE" },
    timeframe: "1d",
    from: new Date("2026-01-01"),
    to: new Date("2026-01-02"),
  };
}

describe("market data ingestion (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });

  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("ingests a valid bar and marks it ok", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const bar: NormalizedMarketBar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date("2026-01-01T09:15:00Z"),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    };
    const provider = new FixtureMarketDataProvider([bar]);
    const summary = await ingestMarketBars(db, provider, baseRequest(symbol), {
      instrumentType: "equity",
    });

    expect(summary).toMatchObject({ fetched: 1, inserted: 1, duplicates: 0, rejectedInvalid: 0 });

    const [row] = await db
      .select()
      .from(schema.marketObservations)
      .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
      .where(eq(schema.instruments.symbol, symbol));
    expect(row?.market_observations.dataQualityStatus).toBe("ok");
  });

  it("rejects a bar with missing/invalid observedAt (missing timestamp)", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const bar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(NaN),
      close: 100,
    } as NormalizedMarketBar;
    const provider = new FixtureMarketDataProvider([bar]);
    const summary = await ingestMarketBars(db, provider, baseRequest(symbol), {
      instrumentType: "equity",
    });
    expect(summary).toMatchObject({ fetched: 1, inserted: 0, rejectedInvalid: 1 });
  });

  it("rejects a malformed bar (negative volume, high < low) without persisting it", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const bar: NormalizedMarketBar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date("2026-01-01T09:15:00Z"),
      high: 90,
      low: 100,
      volume: -5,
    };
    const provider = new FixtureMarketDataProvider([bar]);
    const summary = await ingestMarketBars(db, provider, baseRequest(symbol), {
      instrumentType: "equity",
    });
    expect(summary.rejectedInvalid).toBe(1);
    expect(summary.inserted).toBe(0);
  });

  it("marks a bar stale when observedAt exceeds the freshness threshold", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const bar: NormalizedMarketBar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), // 30 days ago
      close: 100,
      open: 100,
      high: 101,
      low: 99,
    };
    const provider = new FixtureMarketDataProvider([bar]);
    const summary = await ingestMarketBars(db, provider, baseRequest(symbol), {
      instrumentType: "equity",
      maxStalenessMs: 1000 * 60 * 60 * 24, // 1 day
    });
    expect(summary.inserted).toBe(1);

    const [row] = await db
      .select()
      .from(schema.marketObservations)
      .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
      .where(eq(schema.instruments.symbol, symbol));
    expect(row?.market_observations.dataQualityStatus).toBe("stale");
  });

  it("is idempotent: re-ingesting the same bar produces a duplicate, not a new row", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const bar: NormalizedMarketBar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date("2026-01-01T09:15:00Z"),
      close: 100,
      open: 99,
      high: 101,
      low: 98,
    };
    const provider = new FixtureMarketDataProvider([bar]);
    const request = baseRequest(symbol);

    const first = await ingestMarketBars(db, provider, request, { instrumentType: "equity" });
    const second = await ingestMarketBars(db, provider, request, { instrumentType: "equity" });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);

    const rows = await db
      .select()
      .from(schema.marketObservations)
      .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
      .where(eq(schema.instruments.symbol, symbol));
    expect(rows).toHaveLength(1);
  });

  it("flags a same-key differing-value re-ingestion as a conflict and preserves the original row", async () => {
    const symbol = `MKT-${randomUUID().slice(0, 8)}`;
    const observedAt = new Date("2026-01-01T09:15:00Z");
    const first: NormalizedMarketBar = {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt,
      close: 100,
    };
    const revised: NormalizedMarketBar = { ...first, close: 999 };

    const request = baseRequest(symbol);
    await ingestMarketBars(db, new FixtureMarketDataProvider([first]), request, {
      instrumentType: "equity",
    });
    const summary = await ingestMarketBars(db, new FixtureMarketDataProvider([revised]), request, {
      instrumentType: "equity",
    });

    expect(summary.conflicts).toBe(1);

    const [row] = await db
      .select()
      .from(schema.marketObservations)
      .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
      .where(eq(schema.instruments.symbol, symbol));
    // original value preserved, never silently overwritten
    expect(Number(row?.market_observations.close)).toBe(100);
    expect(row?.market_observations.dataQualityStatus).toBe("conflicting");

    const [auditEvent] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "market_observation_conflict"));
    expect(auditEvent).toBeTruthy();
  });
});
