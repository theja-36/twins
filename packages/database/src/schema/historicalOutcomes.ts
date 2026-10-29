import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigint } from "drizzle-orm/pg-core";
import { historicalImportBatches, historicalNormalizedRecords, historicalSourceRecords } from "./historicalImport";

/**
 * Historical outcome evaluation (Stage 4 / Task 2): objective, auditable outcome labels for imported historical signals, computed against PRE-EXPORTED historical market data (no live
 * provider). All four tables are APPEND-ONLY and HASH-CHAINED (chains 13-16; the chain columns and guards are hand-written in migration 0021, same convention as before). A label is
 * never edited: a different dataset, configuration or algorithm version is a different RUN with its own labels. Nothing here touches the imported records or the live pipeline.
 */
export const historicalDatasets = pgTable(
  "historical_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    datasetId: text("dataset_id").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    /** SHA-256 of the dataset file / canonical content: the exact data an evaluation used. */
    contentSha256: text("content_sha256").notNull(),
    seriesCount: integer("series_count").notNull(),
    barCount: bigint("bar_count", { mode: "number" }).notNull(),
    coverageFrom: timestamp("coverage_from", { withTimezone: true }),
    coverageTo: timestamp("coverage_to", { withTimezone: true }),
    /** Per series: kind, symbol / contract key, interval, bar count, first / last bar, series hash. Never bar content. */
    descriptor: jsonb("descriptor").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    refUnique: uniqueIndex("historical_datasets_ref_unique").on(table.providerId, table.datasetId, table.datasetVersion, table.contentSha256),
    hashCheck: check("historical_datasets_hash_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$' and ${table.providerId} ~ '^[A-Za-z0-9_.:-]{1,80}$' and ${table.datasetId} ~ '^[A-Za-z0-9_.:-]{1,80}$' and ${table.datasetVersion} ~ '^[A-Za-z0-9_.:-]{1,80}$'`),
    countsCheck: check("historical_datasets_counts_check", sql`${table.seriesCount} >= 0 and ${table.barCount} >= 0`),
    actorCheck: check("historical_datasets_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

export const historicalEvaluationRuns = pgTable(
  "historical_evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(scope, target, dataset references, algorithm version, configuration): re-running the same evaluation resolves to the same run (resume / no-op). */
    runKey: text("run_key").notNull(),
    scope: text("scope").notNull(),
    importBatchId: uuid("import_batch_id").references(() => historicalImportBatches.id, { onDelete: "restrict" }),
    normalizedRecordId: uuid("normalized_record_id").references(() => historicalNormalizedRecords.id, { onDelete: "restrict" }),
    algorithmVersion: text("algorithm_version").notNull(),
    config: jsonb("config").notNull(),
    configSha256: text("config_sha256").notNull(),
    /** The instant the run treated as "now": bars not complete by then are future-dated and rejected. */
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    datasetIds: jsonb("dataset_ids").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("historical_evaluation_runs_key_unique").on(table.runKey),
    scopeCheck: check("historical_evaluation_runs_scope_check", sql`(${table.scope} = 'BATCH' and ${table.importBatchId} is not null and ${table.normalizedRecordId} is null) or (${table.scope} = 'RECORD' and ${table.normalizedRecordId} is not null and ${table.importBatchId} is null)`),
    hashCheck: check("historical_evaluation_runs_hash_check", sql`${table.runKey} ~ '^[0-9a-f]{64}$' and ${table.configSha256} ~ '^[0-9a-f]{64}$'`),
    actorCheck: check("historical_evaluation_runs_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

export const historicalOutcomeLabels = pgTable(
  "historical_outcome_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalEvaluationRuns.id, { onDelete: "restrict" }),
    normalizedRecordId: uuid("normalized_record_id").notNull().references(() => historicalNormalizedRecords.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").notNull().references(() => historicalSourceRecords.id, { onDelete: "restrict" }),
    datasetId: uuid("dataset_id").references(() => historicalDatasets.id, { onDelete: "restrict" }),
    algorithmVersion: text("algorithm_version").notNull(),
    finalOutcome: text("final_outcome").notNull(),
    /** The primary machine-readable reason (always present for INVALID_SIGNAL / UNVERIFIABLE; descriptive otherwise). */
    primaryReason: text("primary_reason"),
    reasons: jsonb("reasons").notNull(),
    entryStatus: text("entry_status").notNull(),
    entryFirstTouchAt: timestamp("entry_first_touch_at", { withTimezone: true }),
    slStatus: text("sl_status").notNull(),
    slFirstTouchAt: timestamp("sl_first_touch_at", { withTimezone: true }),
    /** [{ index, price, status, firstTouchAt, hitBeforeSl }] for T1..T3. */
    targetEvaluations: jsonb("target_evaluations").notNull(),
    /** GOOD | DEGRADED | INSUFFICIENT | NOT_APPLICABLE (the signal was invalid, so no data was examined) */
    dataQuality: text("data_quality").notNull(),
    /** The exact data window: signal time (exclusive), validity end and its kind, first / last bar used, bar count, gaps, dropped bars. */
    dataWindow: jsonb("data_window").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    evidence: jsonb("evidence").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runRecordUnique: uniqueIndex("historical_outcome_labels_run_record_unique").on(table.runId, table.normalizedRecordId),
    recordIdx: index("historical_outcome_labels_record_idx").on(table.normalizedRecordId),
    outcomeIdx: index("historical_outcome_labels_outcome_idx").on(table.runId, table.finalOutcome),
    outcomeCheck: check("historical_outcome_labels_outcome_check", sql`${table.finalOutcome} in ('WIN_T1', 'WIN_T2', 'WIN_T3', 'LOSS_SL', 'NO_ENTRY', 'EXPIRED_NO_ENTRY', 'EXPIRED_AFTER_ENTRY', 'INVALID_SIGNAL', 'UNVERIFIABLE')`),
    statusCheck: check("historical_outcome_labels_status_check", sql`${table.entryStatus} in ('ENTRY_REACHED', 'ENTRY_NOT_REACHED', 'ENTRY_INVALID', 'UNVERIFIABLE') and ${table.slStatus} in ('SL_HIT', 'SL_NOT_HIT', 'SL_INVALID', 'UNVERIFIABLE') and ${table.dataQuality} in ('GOOD', 'DEGRADED', 'INSUFFICIENT', 'NOT_APPLICABLE')`),
    reasonCheck: check("historical_outcome_labels_reason_check", sql`(${table.finalOutcome} not in ('INVALID_SIGNAL', 'UNVERIFIABLE') or ${table.primaryReason} is not null) and (${table.primaryReason} is null or ${table.primaryReason} ~ '^[A-Z][A-Z0-9_]{2,60}$')`),
    sizeCheck: check("historical_outcome_labels_size_check", sql`octet_length(${table.evidence}::text) <= 65536 and octet_length(${table.inputSnapshot}::text) <= 16384`),
    actorCheck: check("historical_outcome_labels_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

export const historicalEvaluationEvents = pgTable(
  "historical_evaluation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalEvaluationRuns.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    sequence: integer("sequence").notNull(),
    /** Counts and codes only (records consumed, counters): never message content. */
    detail: jsonb("detail").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    seqUnique: uniqueIndex("historical_evaluation_events_seq_unique").on(table.runId, table.sequence),
    typeCheck: check("historical_evaluation_events_type_check", sql`${table.eventType} in ('RUN_STARTED', 'CHECKPOINT', 'RUN_COMPLETED')`),
    seqCheck: check("historical_evaluation_events_seq_check", sql`${table.sequence} >= 1 and octet_length(${table.detail}::text) <= 4096`),
    actorCheck: check("historical_evaluation_events_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);
