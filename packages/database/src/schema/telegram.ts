import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";

/** A Telegram channel/chat TWINS ingests signals from (Tier E - spec section 11/18). */
export const telegramSources = pgTable(
  "telegram_sources",
  {
    id: idColumn(),
    channelIdentifier: text("channel_identifier").notNull(),
    displayName: text("display_name"),
    trustNotes: text("trust_notes"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    channelUnique: uniqueIndex("telegram_sources_channel_unique").on(
      table.channelIdentifier,
    ),
  }),
);

/**
 * Raw, immutable Telegram messages (spec section 18: "Do not modify the
 * original message"). Application code must never UPDATE `raw_text` or
 * `raw_payload` after insert - there is deliberately no updated_at column
 * to make that expectation explicit at the schema level.
 */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: idColumn(),
    telegramSourceId: uuid("telegram_source_id")
      .notNull()
      .references(() => telegramSources.id, { onDelete: "restrict" }),
    externalMessageId: text("external_message_id").notNull(),
    messageTimestamp: timestamp("message_timestamp", {
      withTimezone: true,
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawText: text("raw_text").notNull(),
    rawPayload: jsonb("raw_payload"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    sourceExternalIdUnique: uniqueIndex(
      "telegram_messages_source_external_id_unique",
    ).on(table.telegramSourceId, table.externalMessageId),
  }),
);
