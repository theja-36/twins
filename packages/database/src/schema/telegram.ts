import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
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
    /**
     * Telegram chat.id (canonical identity for events ingested after revision-aware
     * ingestion). NULL for legacy sources whose chat id is not unambiguously recoverable.
     */
    chatId: text("chat_id"),
    displayName: text("display_name"),
    trustNotes: text("trust_notes"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    channelUnique: uniqueIndex("telegram_sources_channel_unique").on(
      table.channelIdentifier,
    ),
    chatIdUnique: uniqueIndex("telegram_sources_chat_id_unique").on(table.chatId),
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
    /**
     * Telegram message_id of the ORIGINAL message; shared by all revisions.
     * NULL for rows ingested before revision metadata existed (legacy `_edit` ids).
     */
    originMessageId: text("origin_message_id"),
    /** Telegram edit_date for a revision row; NULL for originals and legacy rows. */
    editDate: timestamp("edit_date", { withTimezone: true }),
    rawText: text("raw_text").notNull(),
    rawPayload: jsonb("raw_payload"),
    /**
     * How TWINS obtained this row: `bot_webhook` (the original Bot API path and the default for every existing row),
     * `api_live` (read-only User API session, live updates) or `api_history` (User API history import). Written at INSERT only.
     */
    captureMethod: text("capture_method").notNull().default("bot_webhook"),
    /**
     * When TWINS accepted this content (the API's clock; excludes queue delay, unlike `received_at`, which is the worker's
     * insert time). NULL = not recorded: legacy `bot_webhook` rows are deliberately NOT backfilled (raw rows are immutable).
     * Required for `api_live` / `api_history`.
     */
    observedAt: timestamp("observed_at", { withTimezone: true }),
    /** When a history import brought the row in. Set if and only if `capture_method = 'api_history'`. */
    importedAt: timestamp("imported_at", { withTimezone: true }),
    /**
     * TRUE when the first time TWINS saw this message it already carried an edit (typical for history import): the stored
     * text is then a LATER revision and no row claims to be the original. Excluded from timing-sensitive research.
     */
    firstSeenEdited: boolean("first_seen_edited").notNull().default(false),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    sourceExternalIdUnique: uniqueIndex(
      "telegram_messages_source_external_id_unique",
    ).on(table.telegramSourceId, table.externalMessageId),
    originIdx: index("telegram_messages_origin_idx").on(
      table.telegramSourceId,
      table.originMessageId,
    ),
    captureMethodCheck: check(
      "telegram_messages_capture_method_check",
      sql`${table.captureMethod} in ('bot_webhook', 'api_live', 'api_history')`,
    ),
    importedAtCheck: check(
      "telegram_messages_imported_at_check",
      sql`(${table.captureMethod} = 'api_history') = (${table.importedAt} is not null)`,
    ),
    observedAtCheck: check(
      "telegram_messages_observed_at_check",
      sql`${table.captureMethod} = 'bot_webhook' or ${table.observedAt} is not null`,
    ),
  }),
);

/**
 * APPEND-ONLY observations about Telegram messages captured through the User API: a message was seen, an edit was observed,
 * a deletion was observed. A deletion is an EVENT; it never alters or removes the stored message. Content is never stored
 * here, only a SHA-256 of the text at that revision. A database trigger (migration 0007) rejects UPDATE and DELETE.
 * `telegram_message_id` is NULL when the event concerns a message TWINS never stored (e.g. a deletion of an unknown id).
 */
export const telegramMessageEvents = pgTable(
  "telegram_message_events",
  {
    id: idColumn(),
    telegramSourceId: uuid("telegram_source_id")
      .notNull()
      .references(() => telegramSources.id, { onDelete: "restrict" }),
    telegramMessageId: uuid("telegram_message_id").references(() => telegramMessages.id, { onDelete: "restrict" }),
    /** Telegram message id (original id) as text. */
    externalMessageId: text("external_message_id").notNull(),
    eventType: text("event_type").notNull(),
    captureMethod: text("capture_method").notNull(),
    /** API clock at acceptance. For deletions: when the deletion was OBSERVED, not when it happened. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceEditDate: timestamp("source_edit_date", { withTimezone: true }),
    contentSha256: text("content_sha256"),
    /** Content-free metadata only (counters, batch id, client-claimed time); size-bounded by a CHECK. */
    rawMeta: jsonb("raw_meta").notNull().default({}),
    /** `<source>:<message id>:<event type>:<edit date unix or 0>:<hash12 or 0>`; makes every event idempotent. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("telegram_message_events_idempotency_key_unique").on(table.idempotencyKey),
    messageIdx: index("telegram_message_events_message_idx").on(
      table.telegramSourceId,
      table.externalMessageId,
      table.observedAt,
    ),
    eventTypeCheck: check(
      "telegram_message_events_event_type_check",
      sql`${table.eventType} in ('seen', 'edited_observed', 'deleted_observed')`,
    ),
    captureMethodCheck: check(
      "telegram_message_events_capture_method_check",
      sql`${table.captureMethod} in ('api_live', 'api_history')`,
    ),
    contentHashCheck: check(
      "telegram_message_events_content_sha256_check",
      sql`${table.contentSha256} is null or ${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    rawMetaSizeCheck: check(
      "telegram_message_events_raw_meta_size_check",
      sql`octet_length(${table.rawMeta}::text) <= 4096`,
    ),
  }),
);
