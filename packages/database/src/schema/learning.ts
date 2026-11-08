import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn } from "./_columns";
import { opportunityCandidates } from "./intelligence";
import { users } from "./users";
import { userDecisions } from "./userDecisions";

/**
 * Learning and analytics (Master Build Stage 02, spec Modules 07 and 15). Learning is VERSIONED: a version must be evaluated before it can influence live decision policy, and
 * every state change is an append-only event so a rollback is a recorded fact, not an edit. Performance snapshots keep PAPER, LIVE and HISTORICAL apart by `mode`.
 */
export const LEARNING_KINDS = ["PLAYBOOK", "CONFIDENCE_MODEL", "SCORING_WEIGHTS", "SOURCE_PROFILE"] as const;
export const LEARNING_STATES = ["PROPOSED", "EVALUATING", "ACTIVE", "REJECTED", "ROLLED_BACK"] as const;
export const learningVersions = pgTable("learning_versions", {
  id: idColumn(),
  kind: text("kind").notNull(),
  subjectId: uuid("subject_id"),
  version: integer("version").notNull(),
  state: text("state").notNull().default("PROPOSED"),
  evaluation: jsonb("evaluation"),
  influencesLive: boolean("influences_live").notNull().default(false),
  createdAt: createdAtColumn(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (t) => ({
  versionUnique: uniqueIndex("learning_versions_unique").on(t.kind, t.subjectId, t.version),
  kindCheck: check("learning_versions_kind_check", oneOf(t.kind, LEARNING_KINDS)),
  stateCheck: check("learning_versions_state_check", oneOf(t.state, LEARNING_STATES)),
  versionCheck: check("learning_versions_version_check", sql`${t.version} >= 1`),
  /** Unvalidated learning never changes live policy: influencing live needs ACTIVE, and ACTIVE needs a recorded evaluation. */
  liveNeedsActive: check("learning_versions_live_active_check", sql`${t.influencesLive} = false or ${t.state} = 'ACTIVE'`),
  activeNeedsEvaluation: check("learning_versions_active_evaluation_check", sql`${t.state} <> 'ACTIVE' or (${t.evaluation} is not null and ${t.activatedAt} is not null)`),
}));

export const learningVersionEvents = pgTable("learning_version_events", {
  id: idColumn(),
  learningVersionId: uuid("learning_version_id").notNull().references(() => learningVersions.id, { onDelete: "restrict" }),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("learning_version_events_version_idx").on(t.learningVersionId, t.at),
  toCheck: check("learning_version_events_to_check", oneOf(t.toState, LEARNING_STATES)),
}));

export const performanceSnapshots = pgTable("performance_snapshots", {
  id: idColumn(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id"),
  /** set only for USER scope; such rows are private to that user */
  userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
  mode: text("mode").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  metrics: jsonb("metrics").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  idx: index("performance_snapshots_scope_idx").on(t.scope, t.scopeId, t.mode, t.periodEnd),
  scopeCheck: check("performance_snapshots_scope_check", oneOf(t.scope, ["CHANNEL", "STRATEGY", "AGENT", "USER", "PLATFORM"])),
  modeCheck: check("performance_snapshots_mode_check", oneOf(t.mode, ["PAPER", "LIVE", "HISTORICAL"])),
  periodCheck: check("performance_snapshots_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
  userScopeCheck: check("performance_snapshots_user_scope_check", sql`(${t.scope} = 'USER') = (${t.userId} is not null)`),
}));

export const confidenceCalibrationRuns = pgTable("confidence_calibration_runs", {
  id: idColumn(),
  modelVersion: text("model_version").notNull(),
  sampleSize: integer("sample_size").notNull(),
  outOfSample: boolean("out_of_sample").notNull(),
  bins: jsonb("bins").notNull(),
  brierScore: numeric("brier_score"),
  calibrationStatus: text("calibration_status").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  statusCheck: check("confidence_calibration_runs_status_check", oneOf(t.calibrationStatus, ["UNCALIBRATED", "CALIBRATING", "CALIBRATED"])),
  sampleCheck: check("confidence_calibration_runs_sample_check", sql`${t.sampleSize} >= 0`),
  /** A model is CALIBRATED only on out-of-sample evidence (spec Module 09). */
  calibratedNeedsOos: check("confidence_calibration_runs_oos_check", sql`${t.calibrationStatus} <> 'CALIBRATED' or ${t.outOfSample} = true`),
}));

export const counterfactualReviews = pgTable("counterfactual_reviews", {
  id: idColumn(),
  candidateId: uuid("candidate_id").references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").references(() => userDecisions.id, { onDelete: "restrict" }),
  question: text("question").notNull(),
  result: jsonb("result").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({ subjectCheck: check("counterfactual_reviews_subject_check", sql`${t.candidateId} is not null or ${t.decisionId} is not null`) }));
