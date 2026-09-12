import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { dataQualityStatusEnum } from "./enums";
import { instruments } from "./instruments";

/**
 * OBSERVED market data (spec section 22) - raw provider output, never a
 * derived/inferred value. `observedAt` is the source's own timestamp for
 * the bar/tick; `receivedAt` is when TWINS ingested it. The two are kept
 * separate deliberately (spec section 21) so staleness/lag is measurable
 * instead of assumed away.
 *
 * The unique constraint on (instrument, source, timeframe, observedAt) is
 * the idempotency guard for ingestion retries (spec section 33).
 */
export const marketObservations = pgTable(
  "market_observations",
  {
    id: idColumn(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    timeframe: text("timeframe").notNull(), // tick | 1m | 5m | 1d | ...
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    open: numeric("open"),
    high: numeric("high"),
    low: numeric("low"),
    close: numeric("close"),
    volume: numeric("volume"),
    openInterest: numeric("open_interest"),
    dataQualityStatus: dataQualityStatusEnum("data_quality_status")
      .notNull()
      .default("ok"),
    rawPayload: jsonb("raw_payload"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    dedupeUnique: uniqueIndex("market_observations_dedupe_unique").on(
      table.instrumentId,
      table.source,
      table.timeframe,
      table.observedAt,
    ),
    instrumentObservedIdx: index(
      "market_observations_instrument_observed_idx",
    ).on(table.instrumentId, table.observedAt),
  }),
);
