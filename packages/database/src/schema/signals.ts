import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { evidenceKindEnum, signalDirectionEnum, signalStatusEnum } from "./enums";
import { instruments } from "./instruments";
import { telegramMessages } from "./telegram";
import { marketObservations } from "./marketObservations";
import { macroObservations } from "./macroObservations";
import { newsEvidence } from "./news";

/**
 * A structured trading signal (spec section 18/19). May originate from a
 * Telegram message (`telegramMessageId` set) or another source in future
 * phases. The original Telegram message is preserved separately and never
 * altered - this row only ever holds TWINS' own parsed/derived view of it.
 */
export const signals = pgTable(
  "signals",
  {
    id: idColumn(),
    sourceType: text("source_type").notNull(), // telegram | manual | other
    telegramMessageId: uuid("telegram_message_id").references(
      () => telegramMessages.id,
      { onDelete: "restrict" },
    ),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    /**
     * Version of the deterministic parser that produced this row. Historical rows
     * created before versions were recorded carry the explicit label
     * "legacy-unversioned" (provenance unknown, not inferred). Together
     * with `telegramMessageId` it identifies the canonical parse of a raw
     * message: re-parsing with a NEW parser version is a legitimate new row,
     * re-running the SAME version must reuse the existing row.
     */
    parserVersion: text("parser_version").notNull(), // no default: callers must state it explicitly
    direction: signalDirectionEnum("direction").notNull(),
    entryPrice: numeric("entry_price"),
    stopLoss: numeric("stop_loss"),
    targets: jsonb("targets"), // array of numeric targets, order preserved
    timeframe: text("timeframe"),
    extractedConfidence: numeric("extracted_confidence"),
    status: signalStatusEnum("status").notNull().default("pending"),
    signalTimestamp: timestamp("signal_timestamp", {
      withTimezone: true,
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    instrumentStatusIdx: index("signals_instrument_status_idx").on(
      table.instrumentId,
      table.status,
    ),
    telegramMessageIdx: index("signals_telegram_message_idx").on(
      table.telegramMessageId,
    ),
    // NULL telegram_message_id (non-Telegram signals) never collides: NULLs are distinct.
    telegramMessageParserUnique: uniqueIndex("signals_telegram_message_parser_unique").on(
      table.telegramMessageId,
      table.parserVersion,
    ),
  }),
);

/**
 * Polymorphic link from a signal to the evidence used to evaluate it
 * (spec section 23: data lineage). Exactly one of the three evidence
 * foreign keys must be set, matching `evidenceKind` - enforced by the
 * check constraint below rather than trusted to application code alone.
 */
export const signalEvidence = pgTable(
  "signal_evidence",
  {
    id: idColumn(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    evidenceKind: evidenceKindEnum("evidence_kind").notNull(),
    marketObservationId: uuid("market_observation_id").references(
      () => marketObservations.id,
      { onDelete: "restrict" },
    ),
    macroObservationId: uuid("macro_observation_id").references(
      () => macroObservations.id,
      { onDelete: "restrict" },
    ),
    newsEvidenceId: uuid("news_evidence_id").references(
      () => newsEvidence.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    exactlyOneReference: check(
      "signal_evidence_exactly_one_reference",
      sql`(
        (case when ${table.marketObservationId} is not null then 1 else 0 end) +
        (case when ${table.macroObservationId} is not null then 1 else 0 end) +
        (case when ${table.newsEvidenceId} is not null then 1 else 0 end)
      ) = 1`,
    ),
    kindMatchesReference: check(
      "signal_evidence_kind_matches_reference",
      sql`(
        (${table.evidenceKind} = 'market_observation' and ${table.marketObservationId} is not null) or
        (${table.evidenceKind} = 'macro_observation' and ${table.macroObservationId} is not null) or
        (${table.evidenceKind} = 'news_evidence' and ${table.newsEvidenceId} is not null)
      )`,
    ),
    signalIdx: index("signal_evidence_signal_idx").on(table.signalId),
    // One link per (signal, referenced evidence row). evidence_kind is implied by which
    // reference column is set (enforced by the two check constraints above), so three
    // PARTIAL unique indexes express the identity without relying on NULL semantics.
    marketLinkUnique: uniqueIndex("signal_evidence_signal_market_unique")
      .on(table.signalId, table.marketObservationId)
      .where(sql`${table.marketObservationId} is not null`),
    macroLinkUnique: uniqueIndex("signal_evidence_signal_macro_unique")
      .on(table.signalId, table.macroObservationId)
      .where(sql`${table.macroObservationId} is not null`),
    newsLinkUnique: uniqueIndex("signal_evidence_signal_news_unique")
      .on(table.signalId, table.newsEvidenceId)
      .where(sql`${table.newsEvidenceId} is not null`),
  }),
);
