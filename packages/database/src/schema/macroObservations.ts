import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { dataQualityStatusEnum } from "./enums";

/**
 * OBSERVED macro-economic data points (spec sections 13/15) - e.g. RBI
 * repo rate, MOSPI CPI print, FRED series. `observedAt` is the series'
 * reference/publication timestamp; `receivedAt` is ingestion time.
 */
export const macroObservations = pgTable(
  "macro_observations",
  {
    id: idColumn(),
    source: text("source").notNull(), // e.g. RBI, MOSPI, FRED, BLS, ECB
    region: text("region").notNull(), // e.g. IN, US, EU
    seriesCode: text("series_code").notNull(), // e.g. CPI, REPO_RATE, GDP
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    value: numeric("value").notNull(),
    unit: text("unit"),
    dataQualityStatus: dataQualityStatusEnum("data_quality_status")
      .notNull()
      .default("ok"),
    rawPayload: jsonb("raw_payload"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    dedupeUnique: uniqueIndex("macro_observations_dedupe_unique").on(
      table.source,
      table.seriesCode,
      table.observedAt,
    ),
    regionSeriesIdx: index("macro_observations_region_series_idx").on(
      table.region,
      table.seriesCode,
    ),
  }),
);
