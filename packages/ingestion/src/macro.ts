import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { MacroProvider, MacroSeriesRequest } from "@twins/types";
import type { Db } from "./db";
import { checkMacroObservationQuality } from "./dataQuality";

export interface IngestMacroSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  rejectedInvalid: number;
  [key: string]: unknown;
}

/**
 * Macro ingestion. `observedAt` here is the series' own reference/
 * publication timestamp (never TWINS' clock) - see spec's look-ahead
 * safety requirement: preserving this distinctly from `receivedAt` is
 * what lets a future backtester exclude data not yet published at a
 * given historical instant.
 */
export async function ingestMacroObservations(
  db: Db,
  provider: MacroProvider,
  request: MacroSeriesRequest,
): Promise<IngestMacroSummary> {
  const observations = await provider.fetchSeries(request);

  const summary: IngestMacroSummary = {
    fetched: observations.length,
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    rejectedInvalid: 0,
  };

  for (const observation of observations) {
    const receivedAt = new Date();
    const quality = checkMacroObservationQuality({
      observedAt: observation.observedAt,
      value: observation.value,
      region: observation.region,
      seriesCode: observation.seriesCode,
    });

    if (!quality.valid) {
      summary.rejectedInvalid += 1;
      continue;
    }

    const [inserted] = await db
      .insert(schema.macroObservations)
      .values({
        source: observation.source,
        region: observation.region,
        seriesCode: observation.seriesCode,
        observedAt: observation.observedAt,
        receivedAt,
        value: observation.value.toString(),
        unit: observation.unit,
        dataQualityStatus: quality.status,
        rawPayload: observation.rawPayload,
      })
      .onConflictDoNothing({
        target: [
          schema.macroObservations.source,
          schema.macroObservations.seriesCode,
          schema.macroObservations.observedAt,
        ],
      })
      .returning({ id: schema.macroObservations.id });

    if (inserted) {
      summary.inserted += 1;
      continue;
    }

    const [existing] = await db
      .select()
      .from(schema.macroObservations)
      .where(
        and(
          eq(schema.macroObservations.source, observation.source),
          eq(schema.macroObservations.seriesCode, observation.seriesCode),
          eq(schema.macroObservations.observedAt, observation.observedAt),
        ),
      );
    if (!existing) {
      summary.duplicates += 1;
      continue;
    }

    const existingValue = Number(existing.value);
    if (Math.abs(existingValue - observation.value) < 1e-9) {
      summary.duplicates += 1;
      continue;
    }

    summary.conflicts += 1;
    await db
      .update(schema.macroObservations)
      .set({ dataQualityStatus: "conflicting" })
      .where(eq(schema.macroObservations.id, existing.id));
    await db.insert(schema.auditEvents).values({
      eventType: "macro_observation_conflict",
      entityType: "macro_observations",
      entityId: existing.id,
      actorType: "system",
      beforeState: existing,
      afterState: { ...observation, receivedAt },
      metadata: { reason: "same key, differing values" },
    });
  }

  return summary;
}
