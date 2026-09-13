import { index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";

export const qualityOverallStatusEnum = pgEnum("quality_overall_status", [
  "trusted",
  "flagged",
  "rejected",
]);

/**
 * Phase 5 - Data Quality & Integrity Engine output. Deliberately separate
 * from the coarse `data_quality_status` enum already on observation rows
 * (Phase 2/4): that single value records the ingestion-time verdict,
 * while this table records a full, explainable, re-runnable assessment -
 * per-dimension pass/fail, a score, reasons, and which rule produced them
 * (spec: "quality score if appropriate, individual quality dimensions,
 * reasons for degradation, ... rule/check identifier").
 *
 * `entityType`/`entityId` is a generic reference (same pattern as
 * audit_events) rather than one FK per observation table, since the set
 * of assessable entity types grows independently of this table's shape.
 */
export const qualityAssessments = pgTable(
  "quality_assessments",
  {
    id: idColumn(),
    entityType: text("entity_type").notNull(), // market_observations | macro_observations | news_evidence | telegram_messages
    entityId: uuid("entity_id").notNull(),
    source: text("source").notNull(),
    overallStatus: qualityOverallStatusEnum("overall_status").notNull(),
    qualityScore: numeric("quality_score").notNull(), // 0..1, deterministic ratio of passed/applicable dimensions
    dimensions: jsonb("dimensions").notNull(), // [{ dimension, passed, ruleId, detail? }]
    reasons: jsonb("reasons").notNull(), // string[]
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    entityIdx: index("quality_assessments_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
    evaluatedAtIdx: index("quality_assessments_evaluated_at_idx").on(
      table.evaluatedAt,
    ),
  }),
);
