import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestMacroObservations } from "../../../packages/ingestion/src/macro";
import type { MacroProvider, NormalizedMacroObservation } from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

class FixtureMacroProvider implements MacroProvider {
  readonly providerName = "fixture-macro";
  constructor(private observations: NormalizedMacroObservation[]) {}
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

describe("macro data ingestion (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("ingests a valid macro observation", async () => {
    const seriesCode = `SERIES-${randomUUID().slice(0, 8)}`;
    const observation: NormalizedMacroObservation = {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date("2026-01-01T00:00:00Z"),
      value: 6.5,
      unit: "percent",
    };
    const provider = new FixtureMacroProvider([observation]);
    const summary = await ingestMacroObservations(db, provider, {
      region: "IN",
      seriesCode,
    });
    expect(summary).toMatchObject({ fetched: 1, inserted: 1, rejectedInvalid: 0 });

    const [row] = await db
      .select()
      .from(schema.macroObservations)
      .where(eq(schema.macroObservations.seriesCode, seriesCode));
    expect(row?.dataQualityStatus).toBe("ok");
    expect(row?.observedAt).not.toEqual(row?.receivedAt);
  });

  it("rejects a non-finite value", async () => {
    const seriesCode = `SERIES-${randomUUID().slice(0, 8)}`;
    const observation = {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date("2026-01-01T00:00:00Z"),
      value: Number.NaN,
    } as NormalizedMacroObservation;
    const provider = new FixtureMacroProvider([observation]);
    const summary = await ingestMacroObservations(db, provider, { region: "IN", seriesCode });
    expect(summary).toMatchObject({ inserted: 0, rejectedInvalid: 1 });
  });

  it("is idempotent on (source, seriesCode, observedAt)", async () => {
    const seriesCode = `SERIES-${randomUUID().slice(0, 8)}`;
    const observation: NormalizedMacroObservation = {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt: new Date("2026-01-01T00:00:00Z"),
      value: 6.5,
    };
    const provider = new FixtureMacroProvider([observation]);
    const first = await ingestMacroObservations(db, provider, { region: "IN", seriesCode });
    const second = await ingestMacroObservations(db, provider, { region: "IN", seriesCode });
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("flags conflicting revisions from the same source without overwriting", async () => {
    const seriesCode = `SERIES-${randomUUID().slice(0, 8)}`;
    const observedAt = new Date("2026-01-01T00:00:00Z");
    const original: NormalizedMacroObservation = {
      source: "RBI",
      region: "IN",
      seriesCode,
      observedAt,
      value: 6.5,
    };
    const revised: NormalizedMacroObservation = { ...original, value: 7.0 };

    await ingestMacroObservations(db, new FixtureMacroProvider([original]), {
      region: "IN",
      seriesCode,
    });
    const summary = await ingestMacroObservations(db, new FixtureMacroProvider([revised]), {
      region: "IN",
      seriesCode,
    });
    expect(summary.conflicts).toBe(1);

    const [row] = await db
      .select()
      .from(schema.macroObservations)
      .where(eq(schema.macroObservations.seriesCode, seriesCode));
    expect(Number(row?.value)).toBe(6.5);
    expect(row?.dataQualityStatus).toBe("conflicting");
  });
});
