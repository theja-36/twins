import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Source scorecards and trust tiers (Stage 4 / Task 3): objective, auditable scorecards for historical signal sources, computed ONLY from evaluated outcome labels. All five tables are
 * APPEND-ONLY and HASH-CHAINED (chains 17-21; chain columns and guards are hand-written in migration 0022, same convention as before). Nothing here reads or writes the live pipeline.
 */
const ACTOR = sql`'^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`;

/** The source identity registry: one IDENTITY entry per channel label, plus explicit ALIAS_LINK entries (an alias is linked, never silently merged). */
export const historicalSourceRegistry = pgTable(
  "historical_source_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryType: text("entry_type").notNull(),
    /** sha256("channel|" + label) for an identity; sha256("alias|" + label) for an alias link. */
    sourceKey: text("source_key").notNull(),
    channelLabel: text("channel_label").notNull(),
    aliasOfId: uuid("alias_of_id").references((): AnyPgColumn => historicalSourceRegistry.id, { onDelete: "restrict" }),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("historical_source_registry_key_unique").on(t.sourceKey),
    typeCheck: check("historical_source_registry_type_check", sql`(${t.entryType} = 'IDENTITY' and ${t.aliasOfId} is null) or (${t.entryType} = 'ALIAS_LINK' and ${t.aliasOfId} is not null and ${t.aliasOfId} <> ${t.id})`),
    valueCheck: check("historical_source_registry_value_check", sql`${t.sourceKey} ~ '^[0-9a-f]{64}$' and char_length(${t.channelLabel}) between 1 and 200 and (${t.reason} is null or char_length(${t.reason}) <= 500)`),
    actorCheck: check("historical_source_registry_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalScorecardRuns = pgTable(
  "historical_scorecard_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(source, as-of, algorithm, configuration, label-set hash, source snapshot): rebuilding the same input resolves to the same run. */
    runKey: text("run_key").notNull(),
    sourceId: uuid("source_id").notNull().references(() => historicalSourceRegistry.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    config: jsonb("config").notNull(),
    configSha256: text("config_sha256").notNull(),
    /** sha256 over the sorted outcome-label ids actually used. */
    labelSetSha256: text("label_set_sha256").notNull(),
    /** Evaluation run ids, dataset references and label counts the scorecard was built from. */
    inputSummary: jsonb("input_summary").notNull(),
    /** Identity facts: member labels, authors, markets, first / last seen, message and signal counts. */
    sourceSnapshot: jsonb("source_snapshot").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("historical_scorecard_runs_key_unique").on(t.runKey),
    sourceIdx: index("historical_scorecard_runs_source_idx").on(t.sourceId, t.asOf),
    hashCheck: check("historical_scorecard_runs_hash_check", sql`${t.runKey} ~ '^[0-9a-f]{64}$' and ${t.configSha256} ~ '^[0-9a-f]{64}$' and ${t.labelSetSha256} ~ '^[0-9a-f]{64}$'`),
    sizeCheck: check("historical_scorecard_runs_size_check", sql`octet_length(${t.inputSummary}::text) <= 65536 and octet_length(${t.sourceSnapshot}::text) <= 16384`),
    actorCheck: check("historical_scorecard_runs_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalScorecardMetrics = pgTable(
  "historical_scorecard_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalScorecardRuns.id, { onDelete: "restrict" }),
    windowType: text("window_type").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    sampleSize: integer("sample_size").notNull(),
    metrics: jsonb("metrics").notNull(),
    caveats: jsonb("caveats").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    windowUnique: uniqueIndex("historical_scorecard_metrics_window_unique").on(t.runId, t.windowType, t.windowStart),
    typeCheck: check("historical_scorecard_metrics_type_check", sql`${t.windowType} in ('ALL_TIME', 'LAST_30D', 'LAST_90D', 'LAST_180D', 'LAST_365D', 'CALENDAR_MONTH') and ${t.sampleSize} >= 0 and ${t.windowEnd} >= ${t.windowStart}`),
    sizeCheck: check("historical_scorecard_metrics_size_check", sql`octet_length(${t.metrics}::text) <= 16384 and octet_length(${t.caveats}::text) <= 4096`),
    actorCheck: check("historical_scorecard_metrics_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalTrustTiers = pgTable(
  "historical_trust_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalScorecardRuns.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id").notNull().references(() => historicalSourceRegistry.id, { onDelete: "restrict" }),
    tier: text("tier").notNull(),
    tierLabel: text("tier_label").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Ordered list of the rule ids that decided the tier, each with the observed value and threshold. */
    explanation: jsonb("explanation").notNull(),
    metricSnapshot: jsonb("metric_snapshot").notNull(),
    thresholdConfig: jsonb("threshold_config").notNull(),
    evidenceReferences: jsonb("evidence_references").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runUnique: uniqueIndex("historical_trust_tiers_run_unique").on(t.runId),
    latestIdx: index("historical_trust_tiers_latest_idx").on(t.sourceId, t.asOf),
    tierCheck: check("historical_trust_tiers_tier_check", sql`(${t.tier} = 'A' and ${t.tierLabel} = 'HIGH_TRUST') or (${t.tier} = 'B' and ${t.tierLabel} = 'MODERATE_TRUST') or (${t.tier} = 'C' and ${t.tierLabel} = 'LOW_TRUST') or (${t.tier} = 'D' and ${t.tierLabel} = 'UNTRUSTED') or (${t.tier} = 'UNKNOWN' and ${t.tierLabel} = 'INSUFFICIENT_EVIDENCE')`),
    sizeCheck: check("historical_trust_tiers_size_check", sql`octet_length(${t.explanation}::text) <= 8192 and octet_length(${t.metricSnapshot}::text) <= 16384 and octet_length(${t.thresholdConfig}::text) <= 4096 and octet_length(${t.evidenceReferences}::text) <= 16384`),
    actorCheck: check("historical_trust_tiers_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);

export const historicalScorecardEvents = pgTable(
  "historical_scorecard_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => historicalScorecardRuns.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    sequence: integer("sequence").notNull(),
    detail: jsonb("detail").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUnique: uniqueIndex("historical_scorecard_events_seq_unique").on(t.runId, t.sequence),
    typeCheck: check("historical_scorecard_events_type_check", sql`${t.eventType} in ('RUN_STARTED', 'RUN_COMPLETED') and ${t.sequence} >= 1 and octet_length(${t.detail}::text) <= 4096`),
    actorCheck: check("historical_scorecard_events_actor_check", sql`${t.createdBy} ~ ${ACTOR}`),
  }),
);
