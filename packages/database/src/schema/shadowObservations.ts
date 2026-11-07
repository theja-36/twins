import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Durable shadow observations (HB-25). A shadow run (the agent-engine shadow, the reduce-only sizing shadow) is OBSERVE-ONLY: its result was only logged (journald, about 7 days). This table keeps one
 * row per (kind, decision, decision version) so shadow evidence can be scored beyond a week (HB-09 weights, HB-19 calibration). It is NOT hash-chained; it is append-only (UPDATE / DELETE / TRUNCATE
 * rejected by trigger, written by migration 0032), has NO foreign key (a shadow row may be recorded before, or outlive, a decision's later versions), and no decision, sizing, gate or approval ever reads it:
 * `used_for_decisions` is constrained to false. `result` carries codes and numbers only (the writer builds it from an allow-list; a size limit is enforced here as a last guard).
 */
export const shadowObservations = pgTable(
  "shadow_observations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: text("kind").notNull(),
    riskDecisionId: uuid("risk_decision_id").notNull(),
    decisionVersion: integer("decision_version").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    result: jsonb("result").notNull(),
    usedForDecisions: boolean("used_for_decisions").notNull().default(false),
  },
  (t) => ({
    onePerRun: uniqueIndex("shadow_observations_run_unique").on(t.kind, t.riskDecisionId, t.decisionVersion),
    kindCheck: check("shadow_observations_kind_check", sql`${t.kind} in ('agent_engine', 'reduce_only_sizing')`),
    notUsedCheck: check("shadow_observations_not_used_check", sql`${t.usedForDecisions} = false`),
    versionCheck: check("shadow_observations_version_check", sql`${t.decisionVersion} >= 1`),
    sizeCheck: check("shadow_observations_size_check", sql`pg_column_size(${t.result}) <= 16384`),
  }),
);
