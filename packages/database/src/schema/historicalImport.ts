import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Historical archive import (Stage 4 / Task 1): research records built from a LOCAL, user-provided export of past Telegram messages. These tables are
 * deliberately SEPARATE from the live pipeline (telegram_messages, signals, options_claims): a historical record never becomes a live signal, a risk decision,
 * an approval card or an order, and the approval bot (which reads options_claims) can never see one.
 * Evidence (`historical_source_records`) is APPEND-ONLY and HASH-CHAINED (the chain columns and guards are hand-written in migration 0020, same convention as
 * 0010/0011/0014/0017/0018/0019); the batch, normalized, issue and checkpoint tables are append-only by trigger.
 */
export const historicalImportBatches = pgTable(
  "historical_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 over the input manifest (file hashes), the label, the parser version and the options: re-running the SAME import resolves to the same batch. */
    batchKey: text("batch_key").notNull(),
    label: text("label").notNull(),
    format: text("format").notNull(),
    contractVersion: text("contract_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    defaultMarket: text("default_market"),
    /** Files: base name, sha256, bytes, record count. Never a full path. */
    manifest: jsonb("manifest").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    options: jsonb("options").notNull(),
    confirmedSource: text("confirmed_source").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("historical_import_batches_key_unique").on(table.batchKey),
    keyCheck: check("historical_import_batches_key_check", sql`${table.batchKey} ~ '^[0-9a-f]{64}$' and ${table.manifestSha256} ~ '^[0-9a-f]{64}$'`),
    labelCheck: check("historical_import_batches_label_check", sql`${table.label} ~ '^[A-Za-z0-9_.:@ -]{1,80}$'`),
    actorCheck: check("historical_import_batches_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

export const historicalSourceRecords = pgTable(
  "historical_source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => historicalImportBatches.id, { onDelete: "restrict" }),
    /** sha256(channel | message id | message timestamp | content hash): the stable identity of one message VERSION. */
    identityKey: text("identity_key").notNull(),
    channelLabel: text("channel_label").notNull(),
    originalMessageId: text("original_message_id").notNull(),
    /** The message's own time (never changes between its revisions). */
    messageTimestamp: timestamp("message_timestamp", { withTimezone: true }).notNull(),
    author: text("author"),
    /** The message text after secret redaction (`raw_text_redacted` says whether anything was redacted). */
    rawText: text("raw_text").notNull(),
    contentSha256: text("content_sha256").notNull(),
    rawTextRedacted: text("raw_text_redacted").notNull().default("no"),
    mediaRefs: jsonb("media_refs").notNull(),
    editOfId: uuid("edit_of_id"),
    revisionNo: integer("revision_no").notNull().default(0),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    sourceFile: text("source_file").notNull(),
    sourceFileSha256: text("source_file_sha256").notNull(),
    sourceLine: integer("source_line").notNull(),
    provenance: jsonb("provenance").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUnique: uniqueIndex("historical_source_records_identity_unique").on(table.identityKey),
    revisionUnique: uniqueIndex("historical_source_records_revision_unique").on(table.channelLabel, table.originalMessageId, table.revisionNo),
    editUnique: uniqueIndex("historical_source_records_edit_unique").on(table.editOfId, table.contentSha256),
    batchIdx: index("historical_source_records_batch_idx").on(table.batchId),
    timeIdx: index("historical_source_records_time_idx").on(table.channelLabel, table.messageTimestamp),
    hashCheck: check("historical_source_records_hash_check", sql`${table.identityKey} ~ '^[0-9a-f]{64}$' and ${table.contentSha256} ~ '^[0-9a-f]{64}$' and ${table.sourceFileSha256} ~ '^[0-9a-f]{64}$'`),
    revisionCheck: check("historical_source_records_revision_check", sql`(${table.editOfId} is null) = (${table.revisionNo} = 0) and ${table.revisionNo} >= 0`),
    redactedCheck: check("historical_source_records_redacted_check", sql`${table.rawTextRedacted} in ('yes', 'no')`),
    shapeCheck: check("historical_source_records_shape_check", sql`${table.channelLabel} ~ '^[A-Za-z0-9_.:@ -]{1,80}$' and ${table.originalMessageId} ~ '^[A-Za-z0-9_.:-]{1,80}$' and ${table.sourceLine} >= 1 and length(${table.rawText}) <= 20000`),
    actorCheck: check("historical_source_records_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

export const historicalNormalizedRecords = pgTable(
  "historical_normalized_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceRecordId: uuid("source_record_id").notNull().references(() => historicalSourceRecords.id, { onDelete: "restrict" }),
    parserVersion: text("parser_version").notNull(),
    /** SIGNAL (equity directive) | OPTIONS_CLAIM | AMBIGUOUS | UNSUPPORTED | NO_SIGNAL */
    parseStatus: text("parse_status").notNull(),
    market: text("market"),
    /** record | batch_default | underlying_mapping | null */
    marketSource: text("market_source"),
    instrumentType: text("instrument_type"),
    underlying: text("underlying"),
    /** The claim's expiry exactly as parsed (status + raw); never completed. */
    expiry: jsonb("expiry"),
    /** Set ONLY when the message stated a complete, calendar-valid date. */
    expiryDate: date("expiry_date"),
    strike: numeric("strike"),
    optionType: text("option_type"),
    side: text("side"),
    entry: jsonb("entry"),
    stopLoss: numeric("stop_loss"),
    levelBasis: text("level_basis"),
    targets: jsonb("targets").notNull(),
    timeValidity: text("time_validity"),
    conditions: jsonb("conditions").notNull(),
    missingFields: jsonb("missing_fields").notNull(),
    ambiguousFields: jsonb("ambiguous_fields").notNull(),
    /** VALID | INCOMPLETE | AMBIGUOUS | UNSUPPORTED | NOT_A_SIGNAL */
    validationResult: text("validation_result").notNull(),
    /** The shared stop-loss rule's verdict (result, reason code, detail, rule version) where applicable. */
    stopLossValidation: jsonb("stop_loss_validation"),
    /** The parsed claim / signal exactly as the existing parser produced it. */
    parsed: jsonb("parsed"),
    warnings: jsonb("warnings").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceUnique: uniqueIndex("historical_normalized_records_source_unique").on(table.sourceRecordId, table.parserVersion),
    statusIdx: index("historical_normalized_records_status_idx").on(table.parseStatus, table.validationResult),
    statusCheck: check("historical_normalized_records_status_check", sql`${table.parseStatus} in ('SIGNAL', 'OPTIONS_CLAIM', 'AMBIGUOUS', 'UNSUPPORTED', 'NO_SIGNAL') and ${table.validationResult} in ('VALID', 'INCOMPLETE', 'AMBIGUOUS', 'UNSUPPORTED', 'NOT_A_SIGNAL')`),
    marketCheck: check("historical_normalized_records_market_check", sql`(${table.market} is null) = (${table.marketSource} is null) and (${table.marketSource} is null or ${table.marketSource} in ('record', 'batch_default', 'underlying_mapping'))`),
    numbersCheck: check("historical_normalized_records_numbers_check", sql`(${table.strike} is null or ${table.strike} > 0) and (${table.stopLoss} is null or ${table.stopLoss} > 0)`),
  }),
);

export const historicalImportIssues = pgTable(
  "historical_import_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => historicalImportBatches.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").references(() => historicalSourceRecords.id, { onDelete: "restrict" }),
    severity: text("severity").notNull(),
    code: text("code").notNull(),
    sourceFile: text("source_file"),
    sourceLine: integer("source_line"),
    /** Codes and counts only - never message content. */
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchIdx: index("historical_import_issues_batch_idx").on(table.batchId, table.severity, table.code),
    severityCheck: check("historical_import_issues_severity_check", sql`${table.severity} in ('WARNING', 'ERROR')`),
    codeCheck: check("historical_import_issues_code_check", sql`${table.code} ~ '^[a-z][a-z0-9_]{2,60}$' and octet_length(${table.detail}::text) <= 2048`),
  }),
);

export const historicalImportCheckpoints = pgTable(
  "historical_import_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => historicalImportBatches.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    /** Records of the input consumed so far (valid or not): resume continues from here. */
    recordsConsumed: bigint("records_consumed", { mode: "number" }).notNull(),
    counters: jsonb("counters").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    seqUnique: uniqueIndex("historical_import_checkpoints_seq_unique").on(table.batchId, table.sequence),
    statusCheck: check("historical_import_checkpoints_status_check", sql`${table.status} in ('IN_PROGRESS', 'COMPLETED')`),
    seqCheck: check("historical_import_checkpoints_seq_check", sql`${table.sequence} >= 1 and ${table.recordsConsumed} >= 0`),
  }),
);
