import {
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { newsEventStatusEnum, newsEventTypeEnum, sourceTierEnum } from "./enums";
import { instruments } from "./instruments";

/** A named news origin, tiered per spec section 11/17. */
export const newsSources = pgTable(
  "news_sources",
  {
    id: idColumn(),
    name: text("name").notNull(),
    tier: sourceTierEnum("tier").notNull(),
    homepageUrl: text("homepage_url"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    nameUnique: uniqueIndex("news_sources_name_unique").on(table.name),
  }),
);

/**
 * A single raw article/announcement (OBSERVED) - the atomic unit ingested
 * from a news_source before clustering. Preserves source identity and
 * both source and ingestion timestamps (spec section 17/21).
 */
export const newsEvidence = pgTable(
  "news_evidence",
  {
    id: idColumn(),
    newsSourceId: uuid("news_source_id")
      .notNull()
      .references(() => newsSources.id, { onDelete: "restrict" }),
    newsEventId: uuid("news_event_id").references(() => newsEvents.id, {
      onDelete: "set null",
    }),
    sourceUrl: text("source_url").notNull(),
    headline: text("headline").notNull(),
    bodyExcerpt: text("body_excerpt"),
    sourceTimestamp: timestamp("source_timestamp", {
      withTimezone: true,
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dedupeHash: text("dedupe_hash").notNull(),
    rawPayload: jsonb("raw_payload"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    sourceDedupeUnique: uniqueIndex(
      "news_evidence_source_dedupe_unique",
    ).on(table.newsSourceId, table.dedupeHash),
  }),
);

/**
 * A DERIVED cluster of one or more news_evidence rows describing the same
 * underlying event (spec section 16). Clustering logic itself belongs to
 * Phase 7 (Entity & Event Intelligence) - this table only holds the
 * resulting structure.
 *
 * `eventType`/`status` were added in Phase 7 (this table existed, unused,
 * since Phase 2 - no prior phase ever wrote to it, so both columns are
 * safe to add without a backfill). `eventType` is nullable: an event
 * whose keyword-based classification doesn't match any known type stays
 * untyped rather than being forced into the nearest category. Revisions
 * to title/summary/eventType/status are expected to be logged via
 * audit_events (entityType='news_events') rather than silently
 * overwritten, preserving event history (spec: "Event Revision").
 */
export const newsEvents = pgTable("news_events", {
  id: idColumn(),
  title: text("title").notNull(),
  summary: text("summary"),
  eventType: newsEventTypeEnum("event_type"),
  status: newsEventStatusEnum("status").notNull().default("reported"),
  eventTime: timestamp("event_time", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  relevanceScore: numeric("relevance_score"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

/** Many-to-many mapping of news events to the instruments they concern. */
export const newsEventInstruments = pgTable(
  "news_event_instruments",
  {
    newsEventId: uuid("news_event_id")
      .notNull()
      .references(() => newsEvents.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.newsEventId, table.instrumentId] }),
  }),
);
