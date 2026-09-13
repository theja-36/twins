import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestMacroObservations } from "../../../packages/ingestion/src/macro";
import { assessMacroObservation } from "../../../packages/dataquality/src/rules/macro";
import type { MacroProvider, NormalizedMacroObservation } from "../../../packages/types/src/index";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://twins:twins_dev_password@localhost:15432/twins_dev";
const db = createDb(DATABASE_URL);

class FixtureMacroProvider implements MacroProvider {
  readonly providerName: string;
  constructor(private observations: NormalizedMacroObservation[], providerName = "fixture-macro") {
    this.providerName = providerName;
  }
  async fetchSeries(): Promise<NormalizedMacroObservation[]> {
    return this.observations;
  }
  async getHealth() {
    return {
      providerName: this.providerName,
      providerType: "macro" as const,
      status: "healthy" as const,
      checkedAt: new Date(),
    };
  }
}

async function insertObservation(
  seriesCode: string,
  observation: NormalizedMacroObservation,
): Promise<string> {
  await ingestMacroObservations(db, new FixtureMacroProvider([observation], observation.source), {
    region: observation.region,
    seriesCode,
  });
  const [row] = await db
    .select()
    .from(schema.macroObservations)
    .where(
      and(
        eq(schema.macroObservations.seriesCode, seriesCode),
        eq(schema.macroObservations.source, observation.source),
        eq(schema.macroObservations.observedAt, observation.observedAt),
      ),
    );
  if (!row) throw new Error("observation was not inserted");
  return row.id;
}

describe("assessMacroObservation (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("assesses a clean, fresh observation as trusted", async () => {
    const seriesCode = `DQ-${randomUUID().slice(0, 8)}`;
    const id = await insertObservation(seriesCode, {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date(),
      value: 6.5,
    });
    const assessment = await assessMacroObservation(db, id);
    expect(assessment.overallStatus).toBe("trusted");
  });

  it("flags an anomalous value jump vs the prior release", async () => {
    const seriesCode = `DQ-${randomUUID().slice(0, 8)}`;
    await insertObservation(seriesCode, {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date("2026-01-01T00:00:00Z"),
      value: 6.5,
    });
    const secondId = await insertObservation(seriesCode, {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date("2026-02-01T00:00:00Z"),
      value: 25, // implausible jump
    });

    const assessment = await assessMacroObservation(db, secondId);
    const anomaly = assessment.dimensions.find((d) => d.dimension === "anomaly");
    expect(anomaly?.passed).toBe(false);
    expect(assessment.overallStatus).toBe("flagged");
  });

  it("detects cross-source disagreement for the same region/series/period", async () => {
    const seriesCode = `DQ-${randomUUID().slice(0, 8)}`;
    const observedAt = new Date("2026-01-01T00:00:00Z");
    await insertObservation(seriesCode, {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt,
      value: 6.5,
    });
    const secondId = await insertObservation(seriesCode, {
      source: "alt-source",
      region: "IN",
      seriesCode,
      observedAt,
      value: 7.5,
    });

    const assessment = await assessMacroObservation(db, secondId);
    const conflict = assessment.dimensions.find((d) => d.dimension === "cross_source_conflict");
    expect(conflict?.passed).toBe(false);
    expect(assessment.overallStatus).toBe("flagged");
  });
});
