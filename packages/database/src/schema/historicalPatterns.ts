import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { historicalImportBatches, historicalNormalizedRecords, historicalSourceRecords } from "./historicalImport";

/**
 * Historical pattern library and calibrated confidence (Stage 4 / Task 4): deterministic feature-combination patterns learned from evaluated historical outcomes, their performance
 * snapshots, and local (non-LLM) confidence estimates. All five tables are APPEND-ONLY and HASH-CHAINED (chains 22-26; chain columns and guards are hand-written in migration 0023).
 * Everything is historical ASSOCIATION only. Nothing here reads or writes the live pipeline.
 */
const ACTOR = sql`'^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`;

export const historicalPatternDefinitions = pgTable(
  "historical_pattern_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(feature version + "|" + key text). */
    patternKey: text("pattern_key").notNull(),
    /** e.g. "L2|market=NSE|instrument=equity|side=buy|underlying=RELIANCE" - deterministic, never a generated name. */
    keyText: text("key_text").notNull(),
    level: integer("level").notNull(),
    features: jsonb("features").notNull(),
    definitionVersion: text("definition_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("historical_pattern_definitions_key_unique").on(t.patternKey),
    levelCheck: check("historical_pattern_definitions_level_check", sql`${t.patternKey} ~ '^[0-9a-f]{64}$' and ${t.level} between 1 and 4 and char_length(${t.keyText}) between 1 and 400`),
    actorCheck: check("historical_pattern_definitions_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalPatternRuns = pgTable(
  "historical_pattern_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runKey: text("run_key").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    config: jsonb("config").notNull(),
    configSha256: text("config_sha256").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Only signals sent at or before this instant (as-of minus the embargo) are in the training set. */
    embargoCutoff: timestamp("embargo_cutoff", { withTimezone: true }).notNull(),
    labelSetSha256: text("label_set_sha256").notNull(),
    /** Evaluation runs, dataset references, scorecard runs and counts the metrics were built from. */
    inputSummary: jsonb("input_summary").notNull(),
    patternCount: integer("pattern_count").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("historical_pattern_runs_key_unique").on(t.runKey),
    asOfIdx: index("historical_pattern_runs_as_of_idx").on(t.asOf),
    hashCheck: check("historical_pattern_runs_hash_check", sql`${t.runKey} ~ '^[0-9a-f]{64}$' and ${t.configSha256} ~ '^[0-9a-f]{64}$' and ${t.labelSetSha256} ~ '^[0-9a-f]{64}$' and ${t.patternCount} >= 0 and ${t.embargoCutoff} <= ${t.asOf}`),
    sizeCheck: check("historical_pattern_runs_size_check", sql`octet_length(${t.inputSummary}::text) <= 65536`),
    actorCheck: check("historical_pattern_runs_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalPatternSnapshots = pgTable(
  "historical_pattern_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalPatternRuns.id, { onDelete: "restrict" }),
    patternId: uuid("pattern_id").notNull().references(() => historicalPatternDefinitions.id, { onDelete: "restrict" }),
    level: integer("level").notNull(),
    evidenceStatus: text("evidence_status").notNull(),
    flags: jsonb("flags").notNull(),
    sampleSize: integer("sample_size").notNull(),
    /** Full metric snapshot plus the Wilson interval and the conservative expectancy bound. */
    metrics: jsonb("metrics").notNull(),
    /** Source-trust-tier and data-quality mix of the signals in the pattern (counts). */
    mixes: jsonb("mixes").notNull(),
    firstObserved: timestamp("first_observed", { withTimezone: true }),
    lastObserved: timestamp("last_observed", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patternUnique: uniqueIndex("historical_pattern_snapshots_run_pattern_unique").on(t.runId, t.patternId),
    statusIdx: index("historical_pattern_snapshots_status_idx").on(t.runId, t.evidenceStatus),
    statusCheck: check("historical_pattern_snapshots_status_check", sql`${t.evidenceStatus} in ('SUFFICIENT', 'INSUFFICIENT_EVIDENCE', 'LOW_QUALITY_EVIDENCE') and ${t.sampleSize} >= 0 and ${t.level} between 1 and 4`),
    sizeCheck: check("historical_pattern_snapshots_size_check", sql`octet_length(${t.metrics}::text) <= 16384 and octet_length(${t.mixes}::text) <= 4096`),
    actorCheck: check("historical_pattern_snapshots_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalConfidenceRuns = pgTable(
  "historical_confidence_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runKey: text("run_key").notNull(),
    patternRunId: uuid("pattern_run_id").notNull().references(() => historicalPatternRuns.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    importBatchId: uuid("import_batch_id").references(() => historicalImportBatches.id, { onDelete: "restrict" }),
    normalizedRecordId: uuid("normalized_record_id").references(() => historicalNormalizedRecords.id, { onDelete: "restrict" }),
    algorithmVersion: text("algorithm_version").notNull(),
    config: jsonb("config").notNull(),
    configSha256: text("config_sha256").notNull(),
    trustMode: text("trust_mode").notNull(),
    /** True when the pattern run (or the trust tiers) post-date a signal in scope: the estimates are in-sample and say so. */
    lookahead: boolean("lookahead").notNull(),
    inputSummary: jsonb("input_summary").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("historical_confidence_runs_key_unique").on(t.runKey),
    scopeCheck: check("historical_confidence_runs_scope_check", sql`((${t.scope} = 'BATCH' and ${t.importBatchId} is not null and ${t.normalizedRecordId} is null) or (${t.scope} = 'RECORD' and ${t.normalizedRecordId} is not null and ${t.importBatchId} is null)) and ${t.trustMode} in ('point_in_time', 'latest')`),
    hashCheck: check("historical_confidence_runs_hash_check", sql`${t.runKey} ~ '^[0-9a-f]{64}$' and ${t.configSha256} ~ '^[0-9a-f]{64}$'`),
    actorCheck: check("historical_confidence_runs_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalConfidenceEstimates = pgTable(
  "historical_confidence_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalConfidenceRuns.id, { onDelete: "restrict" }),
    normalizedRecordId: uuid("normalized_record_id").notNull().references(() => historicalNormalizedRecords.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").notNull().references(() => historicalSourceRecords.id, { onDelete: "restrict" }),
    score: integer("score").notNull(),
    tier: text("tier").notNull(),
    evidenceQuality: text("evidence_quality").notNull(),
    sampleSize: integer("sample_size").notNull(),
    patternRefs: jsonb("pattern_refs").notNull(),
    inputs: jsonb("inputs").notNull(),
    explanation: jsonb("explanation").notNull(),
    limitations: jsonb("limitations").notNull(),
    evidenceReferences: jsonb("evidence_references").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runRecordUnique: uniqueIndex("historical_confidence_estimates_run_record_unique").on(t.runId, t.normalizedRecordId),
    tierIdx: index("historical_confidence_estimates_tier_idx").on(t.runId, t.tier),
    tierCheck: check("historical_confidence_estimates_tier_check", sql`${t.tier} in ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN') and ${t.score} between 0 and 100 and ((${t.tier} = 'UNKNOWN') = (${t.score} = 0)) and ${t.sampleSize} >= 0`),
    qualityCheck: check("historical_confidence_estimates_quality_check", sql`${t.evidenceQuality} in ('SUFFICIENT', 'LOW_QUALITY_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'NO_MATCH', 'NO_LIBRARY')`),
    sizeCheck: check("historical_confidence_estimates_size_check", sql`octet_length(${t.inputs}::text) <= 8192 and octet_length(${t.explanation}::text) <= 8192 and octet_length(${t.patternRefs}::text) <= 8192 and octet_length(${t.evidenceReferences}::text) <= 8192`),
    actorCheck: check("historical_confidence_estimates_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);
