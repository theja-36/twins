import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { InstrumentRef } from "@twins/types";
import type { Db } from "./db";

/**
 * Finds or creates the reference-data row for an instrument. This is not
 * "fake provider data" (spec section 45/55) - it is the same kind of
 * reference-data upsert any ingestion system needs for a symbol it has
 * not seen before; no price/volume/observation data is fabricated here.
 */
export async function resolveInstrument(
  db: Db,
  ref: InstrumentRef,
  instrumentType: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.instruments.id })
    .from(schema.instruments)
    .where(
      and(
        eq(schema.instruments.exchange, ref.exchange),
        eq(schema.instruments.symbol, ref.symbol),
      ),
    );
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(schema.instruments)
    .values({ symbol: ref.symbol, exchange: ref.exchange, instrumentType })
    .onConflictDoNothing({
      target: [schema.instruments.exchange, schema.instruments.symbol],
    })
    .returning({ id: schema.instruments.id });
  if (inserted) return inserted.id;

  // Lost a race with a concurrent ingestion job inserting the same instrument.
  const [afterRace] = await db
    .select({ id: schema.instruments.id })
    .from(schema.instruments)
    .where(
      and(
        eq(schema.instruments.exchange, ref.exchange),
        eq(schema.instruments.symbol, ref.symbol),
      ),
    );
  if (!afterRace) throw new Error(`failed to resolve instrument ${ref.exchange}:${ref.symbol}`);
  return afterRace.id;
}
