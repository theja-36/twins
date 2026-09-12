import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { MarketBarRequest, MarketDataProvider } from "@twins/types";
import type { Db } from "./db";
import { checkMarketBarQuality } from "./dataQuality";
import { resolveInstrument } from "./instruments";

export interface IngestMarketBarsOptions {
  instrumentType: string;
  maxStalenessMs?: number | undefined;
}

export interface IngestMarketBarsSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  rejectedInvalid: number;
  [key: string]: unknown;
}

function numericFieldsEqual(
  existing: Record<string, unknown>,
  incoming: Record<string, number | undefined>,
  fields: string[],
): boolean {
  return fields.every((field) => {
    const existingRaw = existing[field];
    const incomingValue = incoming[field];
    const existingValue =
      existingRaw === null || existingRaw === undefined ? undefined : Number(existingRaw);
    if (existingValue === undefined && incomingValue === undefined) return true;
    if (existingValue === undefined || incomingValue === undefined) return false;
    return Math.abs(existingValue - incomingValue) < 1e-9;
  });
}

/**
 * Market data ingestion (spec: External Provider -> Adapter -> Ingestion
 * Job -> Validation -> Dedup -> Data Quality -> PostgreSQL). Pure
 * pipeline logic only - retry/backoff and job/provider-health bookkeeping
 * live in `runIngestionJob`, which is expected to wrap this function.
 */
export async function ingestMarketBars(
  db: Db,
  provider: MarketDataProvider,
  request: MarketBarRequest,
  options: IngestMarketBarsOptions,
): Promise<IngestMarketBarsSummary> {
  const bars = await provider.getHistoricalBars(request);
  const instrumentId = await resolveInstrument(db, request.instrument, options.instrumentType);

  const summary: IngestMarketBarsSummary = {
    fetched: bars.length,
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    rejectedInvalid: 0,
  };

  for (const bar of bars) {
    const receivedAt = new Date();
    const quality = checkMarketBarQuality({
      observedAt: bar.observedAt,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      timeframe: bar.timeframe,
      receivedAt,
      maxStalenessMs: options.maxStalenessMs,
    });

    if (!quality.valid) {
      summary.rejectedInvalid += 1;
      continue;
    }

    const [inserted] = await db
      .insert(schema.marketObservations)
      .values({
        instrumentId,
        source: bar.source,
        timeframe: bar.timeframe,
        observedAt: bar.observedAt,
        receivedAt,
        open: bar.open?.toString(),
        high: bar.high?.toString(),
        low: bar.low?.toString(),
        close: bar.close?.toString(),
        volume: bar.volume?.toString(),
        openInterest: bar.openInterest?.toString(),
        dataQualityStatus: quality.status,
        rawPayload: bar.rawPayload,
      })
      .onConflictDoNothing({
        target: [
          schema.marketObservations.instrumentId,
          schema.marketObservations.source,
          schema.marketObservations.timeframe,
          schema.marketObservations.observedAt,
        ],
      })
      .returning({ id: schema.marketObservations.id });

    if (inserted) {
      summary.inserted += 1;
      continue;
    }

    const [existing] = await db
      .select()
      .from(schema.marketObservations)
      .where(
        and(
          eq(schema.marketObservations.instrumentId, instrumentId),
          eq(schema.marketObservations.source, bar.source),
          eq(schema.marketObservations.timeframe, bar.timeframe),
          eq(schema.marketObservations.observedAt, bar.observedAt),
        ),
      );
    if (!existing) {
      // Should not happen: the row existed a moment ago to trigger the conflict.
      summary.duplicates += 1;
      continue;
    }

    const sameValues = numericFieldsEqual(
      existing as unknown as Record<string, unknown>,
      { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
      ["open", "high", "low", "close", "volume"],
    );

    if (sameValues) {
      summary.duplicates += 1;
      continue;
    }

    // Same (instrument, source, timeframe, observedAt) but different values:
    // never silently overwrite (spec section 21) - flag it and preserve the
    // original row; the incoming payload is captured in the audit trail.
    summary.conflicts += 1;
    await db
      .update(schema.marketObservations)
      .set({ dataQualityStatus: "conflicting" })
      .where(eq(schema.marketObservations.id, existing.id));
    await db.insert(schema.auditEvents).values({
      eventType: "market_observation_conflict",
      entityType: "market_observations",
      entityId: existing.id,
      actorType: "system",
      beforeState: existing,
      afterState: { ...bar, instrumentId, receivedAt },
      metadata: { reason: "same key, differing values" },
    });
  }

  return summary;
}
