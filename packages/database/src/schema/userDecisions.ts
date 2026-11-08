import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { accounts } from "./accounts";
import { orders } from "./execution";
import { opportunityCandidates, researchPackages } from "./intelligence";
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
  candidateId: uuid("candidate_id").notNull(),
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
  candidateFk: foreignKey({ name: "confidence_assessments_candidate_fk", columns: [t.candidateId], foreignColumns: [opportunityCandidates.id] }),
  perModel: uniqueIndex("confidence_assessments_candidate_model_unique").on(t.candidateId, t.modelVersion),
  scoreCheck: check("confidence_assessments_score_check", sql`${t.score} >= 0 and ${t.score} <= 100`),
  calibrationCheck: check("confidence_assessments_calibration_check", oneOf(t.calibrationStatus, CALIBRATION_STATUSES)),
}));

export const riskAssessments = pgTable("risk_assessments", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  policyVersion: integer("policy_version").notNull(),
  passed: boolean("passed").notNull(),
  /** Stage 06: PASS, RESTRICTED or BLOCKED. `passed` is true only for PASS (a restricted result is not a pass). */
  verdict: text("verdict").notNull().default("BLOCKED"),
  researchPackageId: uuid("research_package_id").references(() => researchPackages.id, { onDelete: "restrict" }),
  blockers: jsonb("blockers").notNull().default(sql`'[]'::jsonb`),
  result: jsonb("result").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  idx: index("risk_assessments_user_candidate_idx").on(t.userId, t.candidateId, t.createdAt),
  verdictCheck: check("risk_assessments_verdict_check", sql`${t.verdict} in ('PASS', 'RESTRICTED', 'BLOCKED') and ${t.passed} = (${t.verdict} = 'PASS')`),
  ownerFk: foreignKey({ name: "risk_assessments_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  idUserUnique: uniqueIndex("risk_assessments_id_user_unique").on(t.id, t.userId),
}));

export const simulations = pgTable("simulations", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  params: jsonb("params").notNull(),
  scenarios: jsonb("scenarios").notNull(),
  costModelVersion: text("cost_model_version").notNull(),
  /** Stage 06: the risk assessment these scenarios were run beside (same owner enforced by the composite key). */
  riskAssessmentId: uuid("risk_assessment_id"),
  createdAt: createdAtColumn(),
}, (t) => ({
  assessmentFk: foreignKey({ name: "simulations_assessment_owner_fk", columns: [t.riskAssessmentId, t.userId], foreignColumns: [riskAssessments.id, riskAssessments.userId] }),
  idx: index("simulations_user_candidate_idx").on(t.userId, t.candidateId, t.createdAt),
  ownerFk: foreignKey({ name: "simulations_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  idUserUnique: uniqueIndex("simulations_id_user_unique").on(t.id, t.userId),
}));

export const OUTCOME_VALUES = ["QUALIFIED", "WAIT", "REJECT", "EVALUATION_ONLY", "NO_TRADE"] as const;
export const WORKFLOW_STATE_VALUES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
export const userDecisions = pgTable("user_decisions", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  outcome: text("outcome").notNull(),
  workflowState: text("workflow_state").notNull().default("PENDING"),
  confidenceAssessmentId: uuid("confidence_assessment_id"),
  riskAssessmentId: uuid("risk_assessment_id"),
  simulationId: uuid("simulation_id"),
  /** the immutable chained decision this one builds on, when it came through the existing risk flow */
  riskDecisionId: uuid("risk_decision_id").references(() => riskDecisions.id, { onDelete: "restrict" }),
  /** why it qualified or not, why not larger, what supports it, what would invalidate it, comparable patterns, agent agreement */
  explanation: jsonb("explanation").notNull(),
  /** Stage 07: the FULL mandatory stop-loss validation (packages/stop-loss) this decision rests on. A QUALIFIED decision needs result VALID (database trigger). */
  stopLossValidation: jsonb("stop_loss_validation"),
  /** Stage 07: the size this decision permits (lots, quantity, maximum loss, exposure) from the risk-checked sizing; a QUALIFIED decision needs at least one lot. */
  permittedSize: jsonb("permitted_size"),
  researchPackageId: uuid("research_package_id").references(() => researchPackages.id, { onDelete: "restrict" }),
  evidenceRefs: jsonb("evidence_refs").notNull().default(sql`'[]'::jsonb`),
  /** Engine, policy, sizing, risk, confidence and stop-loss rule versions in force when the decision was made. */
  versions: jsonb("versions").notNull().default(sql`'{}'::jsonb`),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  supersedesId: uuid("supersedes_id"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "user_decisions_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  confidenceFk: foreignKey({ name: "user_decisions_confidence_fk", columns: [t.confidenceAssessmentId], foreignColumns: [confidenceAssessments.id] }),
  riskAssessmentFk: foreignKey({ name: "user_decisions_risk_assessment_fk", columns: [t.riskAssessmentId, t.userId], foreignColumns: [riskAssessments.id, riskAssessments.userId] }),
  simulationFk: foreignKey({ name: "user_decisions_simulation_fk", columns: [t.simulationId, t.userId], foreignColumns: [simulations.id, simulations.userId] }),
  supersedesFk: foreignKey({ name: "user_decisions_supersedes_fk", columns: [t.supersedesId, t.userId], foreignColumns: [t.id, t.userId] }),
  idUserUnique: uniqueIndex("user_decisions_id_user_unique").on(t.id, t.userId),
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
  decisionId: uuid("decision_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("user_decision_events_decision_idx").on(t.decisionId, t.at),
  userIdx: index("user_decision_events_user_idx").on(t.userId, t.at),
  decisionFk: foreignKey({ name: "user_decision_events_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  toCheck: check("user_decision_events_to_check", oneOf(t.toState, WORKFLOW_STATE_VALUES)),
  fromCheck: check("user_decision_events_from_check", sql`${t.fromState} is null or ${t.fromState} in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')`),
}));

export const MONITORING_KINDS = ["ENTRY_FILLED", "STOP_HIT", "TARGET_HIT", "TRAIL_MOVED", "TIME_EXIT", "RISK_BREACH", "PARTIAL_EXIT", "RECONCILIATION_MISMATCH", "PRICE_UNAVAILABLE", "STOP_MOVED", "EXPIRY_EXIT", "ORDER_REJECTED", "ALERT"] as const;
export const tradeMonitoringEvents = pgTable("trade_monitoring_events", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  decisionId: uuid("decision_id"),
  mode: text("mode").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx: index("trade_monitoring_events_user_idx").on(t.userId, t.at),
  ownerFk: foreignKey({ name: "trade_monitoring_events_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  decisionFk: foreignKey({ name: "trade_monitoring_events_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  kindCheck: check("trade_monitoring_events_kind_check", oneOf(t.kind, MONITORING_KINDS)),
  modeCheck: check("trade_monitoring_events_mode_check", oneOf(t.mode, ["PAPER", "LIVE"])),
}));

/** One closed trade. A PAPER outcome references its paper trade; a LIVE outcome references a real order. Paper and live are reported separately and never summed. */
export const tradeOutcomes = pgTable("trade_outcomes", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  decisionId: uuid("decision_id"),
  mode: text("mode").notNull(),
  paperTradeId: uuid("paper_trade_id").references(() => paperTrades.id, { onDelete: "restrict" }),
  /** Stage 07: the master-build paper position this outcome closes (the other PAPER source; exactly one of the two for a PAPER outcome). Owner-tied by a hand-appended composite foreign key. */
  paperPositionId: uuid("paper_position_id"),
  orderId: uuid("order_id"),
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
  ownerFk: foreignKey({ name: "trade_outcomes_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  decisionFk: foreignKey({ name: "trade_outcomes_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  orderFk: foreignKey({ name: "trade_outcomes_order_fk", columns: [t.orderId, t.accountId], foreignColumns: [orders.id, orders.accountId] }),
  modeCheck: check("trade_outcomes_mode_check", oneOf(t.mode, ["PAPER", "LIVE"])),
  sourceCheck: check("trade_outcomes_source_check", sql`(${t.mode} = 'PAPER' and ((${t.paperTradeId} is not null) <> (${t.paperPositionId} is not null)) and ${t.orderId} is null) or (${t.mode} = 'LIVE' and ${t.orderId} is not null and ${t.paperTradeId} is null and ${t.paperPositionId} is null)`),
  timeCheck: check("trade_outcomes_time_check", sql`${t.closedAt} >= ${t.openedAt} and ${t.quantity} > 0`),
}));
