import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestMarketBars } from "../../../packages/ingestion/src/market";
import { assessMarketObservation } from "../../../packages/dataquality/src/rules/market";
import { persistAssessment } from "../../../packages/dataquality/src/persist";
import type { MarketBarRequest, MarketDataProvider, NormalizedMarketBar } from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName: string;
  constructor(private bars: NormalizedMarketBar[], providerName = "fixture-market") {
    this.providerName = providerName;
  }
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

async function insertBar(symbol: string, bar: NormalizedMarketBar): Promise<string> {
  await ingestMarketBars(db, new FixtureMarketDataProvider([bar], bar.source), baseRequest(symbol), {
    instrumentType: "equity",
  });
  const [row] = await db
    .select()
    .from(schema.marketObservations)
    .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
    .where(
      and(
        eq(schema.instruments.symbol, symbol),
        eq(schema.marketObservations.observedAt, bar.observedAt),
        eq(schema.marketObservations.source, bar.source),
      ),
    );
  if (!row) throw new Error("bar was not inserted");
  return row.market_observations.id;
}

describe("assessMarketObservation (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("assesses a clean, complete, fresh bar as trusted with score 1", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    const id = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    });

    const assessment = await assessMarketObservation(db, id);
    expect(assessment.overallStatus).toBe("trusted");
    expect(assessment.qualityScore).toBe(1);
    expect(assessment.reasons).toEqual([]);

    const persistedId = await persistAssessment(db, assessment);
    const [saved] = await db
      .select()
      .from(schema.qualityAssessments)
      .where(eq(schema.qualityAssessments.id, persistedId));
    expect(saved?.overallStatus).toBe("trusted");
    expect(saved?.entityType).toBe("market_observations");
  });

  it("flags a stale bar (old observedAt, tight freshness threshold)", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    const id = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
    });

    const assessment = await assessMarketObservation(db, id, { maxAgeMs: 1000 * 60 * 60 * 24 });
    expect(assessment.overallStatus).toBe("flagged");
    expect(assessment.reasons.some((r) => r.includes("days old"))).toBe(true);
  });

  it("flags an incomplete bar (missing open/high/low)", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    const id = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(),
      close: 105,
    });

    const assessment = await assessMarketObservation(db, id);
    expect(assessment.overallStatus).toBe("flagged");
    const completeness = assessment.dimensions.find((d) => d.dimension === "completeness");
    expect(completeness?.passed).toBe(false);
  });

  it("detects an anomalous price jump vs the prior bar from the same source", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date("2026-01-01T00:00:00Z"),
      close: 100,
    });
    const secondId = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date("2026-01-02T00:00:00Z"),
      close: 500, // 400% jump
    });

    const assessment = await assessMarketObservation(db, secondId);
    const anomaly = assessment.dimensions.find((d) => d.dimension === "anomaly");
    expect(anomaly?.applicable).toBe(true);
    expect(anomaly?.passed).toBe(false);
    expect(assessment.overallStatus).toBe("flagged");
  });

  it("does not flag anomaly when there is no prior history to compare against", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    const id = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "fixture-market",
      timeframe: "1d",
      observedAt: new Date(),
      close: 100,
      open: 100,
      high: 101,
      low: 99,
    });
    const assessment = await assessMarketObservation(db, id);
    const anomaly = assessment.dimensions.find((d) => d.dimension === "anomaly");
    expect(anomaly?.applicable).toBe(false);
  });

  it("detects a cross-source conflict without altering either row", async () => {
    const symbol = `DQ-${randomUUID().slice(0, 8)}`;
    const observedAt = new Date("2026-01-01T00:00:00Z");
    await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "provider-a",
      timeframe: "1d",
      observedAt,
      close: 100,
    });
    const bId = await insertBar(symbol, {
      instrument: { symbol, exchange: "NSE" },
      source: "provider-b",
      timeframe: "1d",
      observedAt,
      close: 120, // 20% disagreement with provider-a
    });

    const assessment = await assessMarketObservation(db, bId);
    const conflict = assessment.dimensions.find((d) => d.dimension === "cross_source_conflict");
    expect(conflict?.applicable).toBe(true);
    expect(conflict?.passed).toBe(false);
    expect(assessment.overallStatus).toBe("flagged");

    const rows = await db
      .select()
      .from(schema.marketObservations)
      .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
      .where(eq(schema.instruments.symbol, symbol));
    expect(rows).toHaveLength(2); // both preserved, neither deleted/overwritten
  });
});
