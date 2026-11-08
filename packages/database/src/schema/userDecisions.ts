import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { accounts } from "./accounts";
import { orders } from "./execution";
import { opportunityCandidates } from "./intelligence";
import { paperTrades } from "./paper";
import { riskDecisions } from "./riskDecisions";
import { users } from "./users";

/**
 * Confidence, per-user risk, simulation, per-user decisions, outcomes and monitoring (Master Build Stage 02).
 * Confidence is SHARED (a property of the candidate); everything below it is PRIVATE to one user and protected by row-level security (migration 0033).
 * `user_decisions` is NEW and sits beside the immutable hash-chained `risk_decisions` (reused through `risk_decision_id`): the chain is not altered (ADR-011).
 * Paper and live results are separate by `mode` and by their source reference; they are never summed.
 */
export const CALIBRATION_STATUSES = ["UNCALIBRATED", "CALIBRATING", "CALIBRATED"] as const;
export const confidenceAssessments = pgTable("confidence_assessments", {
  id: idColumn(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  score: numeric("score").notNull(),
  components: jsonb("components").notNull(),
  supporting: jsonb("supporting").notNull().default(sql`'[]'::jsonb`),
  contradicting: jsonb("contradicting").notNull().default(sql`'[]'::jsonb`),
  missing: jsonb("missing").notNull().default(sql`'[]'::jsonb`),
  riskFlags: jsonb("risk_flags").notNull().default(sql`'[]'::jsonb`),
  historicalComparison: jsonb("historical_comparison"),
  explanation: text("explanation").notNull(),
  calibrationStatus: text("calibration_status").notNull().default("UNCALIBRATED"),
  modelVersion: text("model_version").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  perModel: uniqueIndex("confidence_assessments_candidate_model_unique").on(t.candidateId, t.modelVersion),
  scoreCheck: check("confidence_assessments_score_check", sql`${t.score} >= 0 and ${t.score} <= 100`),
  calibrationCheck: check("confidence_assessments_calibration_check", oneOf(t.calibrationStatus, CALIBRATION_STATUSES)),
}));

export const riskAssessments = pgTable("risk_assessments", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  policyVersion: integer("policy_version").notNull(),
  passed: boolean("passed").notNull(),
  blockers: jsonb("blockers").notNull().default(sql`'[]'::jsonb`),
  result: jsonb("result").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({ idx: index("risk_assessments_user_candidate_idx").on(t.userId, t.candidateId, t.createdAt) }));

export const simulations = pgTable("simulations", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  params: jsonb("params").notNull(),
  scenarios: jsonb("scenarios").notNull(),
  costModelVersion: text("cost_model_version").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({ idx: index("simulations_user_candidate_idx").on(t.userId, t.candidateId, t.createdAt) }));

export const OUTCOME_VALUES = ["QUALIFIED", "WAIT", "REJECT", "EVALUATION_ONLY", "NO_TRADE"] as const;
export const WORKFLOW_STATE_VALUES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
export const userDecisions = pgTable("user_decisions", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  outcome: text("outcome").notNull(),
  workflowState: text("workflow_state").notNull().default("PENDING"),
  confidenceAssessmentId: uuid("confidence_assessment_id").references(() => confidenceAssessments.id, { onDelete: "restrict" }),
  riskAssessmentId: uuid("risk_assessment_id").references(() => riskAssessments.id, { onDelete: "restrict" }),
  simulationId: uuid("simulation_id").references(() => simulations.id, { onDelete: "restrict" }),
  /** the immutable chained decision this one builds on, when it came through the existing risk flow */
  riskDecisionId: uuid("risk_decision_id").references(() => riskDecisions.id, { onDelete: "restrict" }),
  /** why it qualified or not, why not larger, what supports it, what would invalidate it, comparable patterns, agent agreement */
  explanation: jsonb("explanation").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  supersedesId: uuid("supersedes_id"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  userIdx: index("user_decisions_user_idx").on(t.userId, t.workflowState, t.validUntil),
  candidateIdx: index("user_decisions_candidate_idx").on(t.candidateId),
  outcomeCheck: check("user_decisions_outcome_check", oneOf(t.outcome, OUTCOME_VALUES)),
  stateCheck: check("user_decisions_state_check", oneOf(t.workflowState, WORKFLOW_STATE_VALUES)),
  windowCheck: check("user_decisions_window_check", sql`${t.validUntil} > ${t.validFrom}`),
  /** Only a QUALIFIED assessment can be approved; anything else cannot reach execution (ADR-004/ADR-009). */
  approvedNeedsQualified: check("user_decisions_approved_qualified_check", sql`${t.workflowState} <> 'APPROVED' or ${t.outcome} = 'QUALIFIED'`),
}));

export const userDecisionEvents = pgTable("user_decision_events", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").notNull().references(() => userDecisions.id, { onDelete: "restrict" }),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("user_decision_events_decision_idx").on(t.decisionId, t.at),
  toCheck: check("user_decision_events_to_check", oneOf(t.toState, WORKFLOW_STATE_VALUES)),
  fromCheck: check("user_decision_events_from_check", sql`${t.fromState} is null or ${t.fromState} in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')`),
}));

export const MONITORING_KINDS = ["ENTRY_FILLED", "STOP_HIT", "TARGET_HIT", "TRAIL_MOVED", "TIME_EXIT", "RISK_BREACH", "PARTIAL_EXIT", "RECONCILIATION_MISMATCH"] as const;
export const tradeMonitoringEvents = pgTable("trade_monitoring_events", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").references(() => userDecisions.id, { onDelete: "restrict" }),
  mode: text("mode").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("trade_monitoring_events_user_idx").on(t.userId, t.at),
  kindCheck: check("trade_monitoring_events_kind_check", oneOf(t.kind, MONITORING_KINDS)),
  modeCheck: check("trade_monitoring_events_mode_check", oneOf(t.mode, ["PAPER", "LIVE"])),
}));

/** One closed trade. A PAPER outcome references its paper trade; a LIVE outcome references a real order. Paper and live are reported separately and never summed. */
export const tradeOutcomes = pgTable("trade_outcomes", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").references(() => userDecisions.id, { onDelete: "restrict" }),
  mode: text("mode").notNull(),
  paperTradeId: uuid("paper_trade_id").references(() => paperTrades.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
  instrument: text("instrument").notNull(),
  side: text("side").notNull(),
  quantity: numeric("quantity").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  exitPrice: numeric("exit_price").notNull(),
  pnl: numeric("pnl").notNull(),
  rMultiple: numeric("r_multiple"),
  exitReason: text("exit_reason").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  idx: index("trade_outcomes_user_idx").on(t.userId, t.mode, t.closedAt),
  modeCheck: check("trade_outcomes_mode_check", oneOf(t.mode, ["PAPER", "LIVE"])),
  sourceCheck: check("trade_outcomes_source_check", sql`(${t.mode} = 'PAPER' and ${t.paperTradeId} is not null and ${t.orderId} is null) or (${t.mode} = 'LIVE' and ${t.orderId} is not null and ${t.paperTradeId} is null)`),
  timeCheck: check("trade_outcomes_time_check", sql`${t.closedAt} >= ${t.openedAt} and ${t.quantity} > 0`),
}));
