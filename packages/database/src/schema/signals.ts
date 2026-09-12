import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
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
  }),
);
