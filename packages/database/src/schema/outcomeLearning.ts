import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn } from "./_columns";
import { accounts } from "./accounts";
import { opportunityCandidates } from "./intelligence";
import { paperPositions } from "./tradeExecution";
import { tradeOutcomes, userDecisions } from "./userDecisions";
import { users } from "./users";

/**
 * Outcome learning (Master Build Stage 08, Module 15). OUTCOMES are facts about what happened; they are kept apart from predictions (confidence / risk / simulation assessments) and from decisions, and are never inferred from a
 * decision. `outcome_attributions` ties one closed (or partly closed) paper position to everything needed to learn from it. It is append-only: a correction is a NEW VERSION with a reason, never an edit, and a PARTIAL record is
 * never final. Nothing is guessed: what was not recorded is listed in `missing`. `learning_insights` are reproducible, evidence-linked findings (they recommend a REVIEW at most and change nothing).
 */
export const OUTCOME_FINALITY = ["PARTIAL", "FINAL"] as const;
export const outcomeAttributions = pgTable("outcome_attributions", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  paperPositionId: uuid("paper_position_id").notNull(),
  outcomeId: uuid("outcome_id"),
  decisionId: uuid("decision_id").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => opportunityCandidates.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  supersedesId: uuid("supersedes_id"),
  correctionReason: text("correction_reason"),
  finality: text("finality").notNull(),
  /** PAPER or LIVE, explicit. Paper and live are separate datasets everywhere. (No LIVE row can be produced yet: no live execution exists.) */
  mode: text("mode").notNull(),
  /** The weakest provenance of the prices behind the fills: FIXTURE taints the whole record. */
  dataSource: text("data_source").notNull(),
  candidateSource: text("candidate_source").notNull(),
  setup: text("setup"),
  detectorVersion: text("detector_version"),
  channelId: text("channel_id"),
  playbookRef: jsonb("playbook_ref"),
  instrument: text("instrument").notNull(),
  timeframeSeconds: integer("timeframe_seconds"),
  side: text("side").notNull(),
  quantity: numeric("quantity").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  exitPrice: numeric("exit_price"),
  grossPnl: numeric("gross_pnl"),
  costs: numeric("costs"),
  netPnl: numeric("net_pnl"),
  /** The money planned to be at risk when the position opened (stop distance x initial quantity), and the realised multiple on that basis. */
  riskAmount: numeric("risk_amount"),
  rMultiple: numeric("r_multiple"),
  holdingSeconds: integer("holding_seconds"),
  exitReason: text("exit_reason"),
  /** How the stop and targets behaved: stop moves, rungs taken, partial exits. MAE / MFE are not recorded and are listed as missing. */
  trade: jsonb("trade").notNull().default(sql`'{}'::jsonb`),
  /** Market regime at decision time and during the trade, only where evidence exists. */
  regime: jsonb("regime"),
  agentVersions: jsonb("agent_versions").notNull().default(sql`'{}'::jsonb`),
  evidenceRefs: jsonb("evidence_refs").notNull().default(sql`'[]'::jsonb`),
  /** What was predicted at decision time (strength score, planned reward-to-risk, planned maximum loss): kept apart from what happened. */
  predicted: jsonb("predicted").notNull().default(sql`'{}'::jsonb`),
  confidenceScore: numeric("confidence_score"),
  confidenceAt: timestamp("confidence_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  dataQuality: jsonb("data_quality").notNull().default(sql`'[]'::jsonb`),
  missing: jsonb("missing").notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "outcome_attributions_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  outcomeFk: foreignKey({ name: "outcome_attributions_outcome_fk", columns: [t.outcomeId, t.userId], foreignColumns: [tradeOutcomes.id, tradeOutcomes.userId] }),
  positionFk: foreignKey({ name: "outcome_attributions_position_fk", columns: [t.paperPositionId, t.userId], foreignColumns: [paperPositions.id, paperPositions.userId] }),
  decisionFk: foreignKey({ name: "outcome_attributions_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  supersedesFk: foreignKey({ name: "outcome_attributions_supersedes_fk", columns: [t.supersedesId], foreignColumns: [t.id] }),
  versionUnique: uniqueIndex("outcome_attributions_position_version_unique").on(t.paperPositionId, t.version),
  idUserUnique: uniqueIndex("outcome_attributions_id_user_unique").on(t.id, t.userId),
  userIdx: index("outcome_attributions_user_idx").on(t.userId, t.mode, t.closedAt),
  finalityCheck: check("outcome_attributions_finality_check", oneOf(t.finality, OUTCOME_FINALITY)),
  modeCheck: check("outcome_attributions_mode_check", oneOf(t.mode, ["PAPER", "LIVE"])),
  sourceCheck: check("outcome_attributions_data_source_check", oneOf(t.dataSource, ["FIXTURE", "LIVE", "HISTORICAL"])),
  candSourceCheck: check("outcome_attributions_candidate_source_check", oneOf(t.candidateSource, ["TELEGRAM", "INDEPENDENT"])),
  versionCheck: check("outcome_attributions_version_check", sql`${t.version} >= 1 and ((${t.version} = 1 and ${t.supersedesId} is null and ${t.correctionReason} is null) or (${t.version} > 1 and ${t.supersedesId} is not null and length(${t.correctionReason}) >= 10))`),
  /** FINAL means closed and fully recorded; PARTIAL never carries a final result. */
  finalCheck: check("outcome_attributions_final_check", sql`(${t.finality} = 'FINAL' and ${t.outcomeId} is not null and ${t.exitPrice} is not null and ${t.netPnl} is not null and ${t.grossPnl} is not null and ${t.closedAt} is not null and ${t.holdingSeconds} is not null and ${t.exitReason} is not null and ${t.closedAt} >= ${t.openedAt}) or (${t.finality} = 'PARTIAL' and ${t.outcomeId} is null and ${t.closedAt} is null)`),
  valueCheck: check("outcome_attributions_value_check", sql`${t.quantity} > 0 and ${t.entryPrice} > 0 and (${t.holdingSeconds} is null or ${t.holdingSeconds} >= 0) and (${t.confidenceScore} is null or (${t.confidenceScore} >= 0 and ${t.confidenceScore} <= 100))`),
}));

export const INSIGHT_KINDS = ["PERFORMANCE", "STRATEGY", "CHANNEL", "PATTERN", "REGIME", "AGENT", "DECISION_QUALITY", "RISK_EXECUTION", "DRIFT", "DATA_QUALITY", "CALIBRATION", "RESEARCH_AREA"] as const;
export const INSIGHT_RELIABILITY = ["INSUFFICIENT_DATA", "NOT_VALIDATED_FIXTURE", "LOW", "MODERATE", "ADEQUATE", "NOT_CALIBRATED", "UNAVAILABLE"] as const;
export const learningInsights = pgTable("learning_insights", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  /** Deterministic key of (kind, scope, subject, method, algorithm version, the exact input set): the same inputs give the same key, so re-running changes nothing. */
  insightKey: text("insight_key").notNull(),
  kind: text("kind").notNull(),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  outcomeCount: integer("outcome_count").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  provenance: jsonb("provenance").notNull(),
  method: text("method").notNull(),
  algorithmVersion: text("algorithm_version").notNull(),
  evidenceRefs: jsonb("evidence_refs").notNull(),
  reliability: text("reliability").notNull(),
  severity: text("severity").notNull().default("INFO"),
  statement: text("statement").notNull(),
  metrics: jsonb("metrics").notNull(),
  limitations: jsonb("limitations").notNull(),
  /** A recommendation can only ever ask for a human REVIEW. It is advice: nothing reads it to change a limit, size, stop, weight, strategy, playbook, permission or kill switch. */
  recommendation: text("recommendation"),
  createdAt: createdAtColumn(),
}, (t) => ({
  keyUnique: uniqueIndex("learning_insights_key_unique").on(t.userId, t.insightKey),
  userIdx: index("learning_insights_user_idx").on(t.userId, t.kind, t.createdAt),
  kindCheck: check("learning_insights_kind_check", oneOf(t.kind, INSIGHT_KINDS)),
  reliabilityCheck: check("learning_insights_reliability_check", oneOf(t.reliability, INSIGHT_RELIABILITY)),
  severityCheck: check("learning_insights_severity_check", oneOf(t.severity, ["INFO", "WARNING"])),
  recommendationCheck: check("learning_insights_recommendation_check", sql`${t.recommendation} is null or ${t.recommendation} = 'REVIEW'`),
  countCheck: check("learning_insights_count_check", sql`${t.outcomeCount} >= 0`),
  /** A finding built on too little, or on fixture, data can never claim ADEQUATE reliability. */
  adequateNeedsCount: check("learning_insights_adequate_check", sql`${t.reliability} <> 'ADEQUATE' or ${t.outcomeCount} >= 30`),
}));

export const LEARNING_JOB_STATES = ["RUNNING", "COMPLETED", "FAILED", "ABANDONED"] as const;
/** One row per run of a background learning job: bounded, recoverable and auditable. At most one RUNNING run per job (a partial unique index); a run whose lease lapsed is marked ABANDONED so the next one can start. */
export const learningJobRuns = pgTable("learning_job_runs", {
  id: idColumn(),
  job: text("job").notNull(),
  status: text("status").notNull().default("RUNNING"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  errorKind: text("error_kind"),
}, (t) => ({
  oneRunning: uniqueIndex("learning_job_runs_one_running").on(t.job).where(sql`${t.status} = 'RUNNING'`),
  idx: index("learning_job_runs_job_idx").on(t.job, t.startedAt),
  statusCheck: check("learning_job_runs_status_check", oneOf(t.status, LEARNING_JOB_STATES)),
  finishedCheck: check("learning_job_runs_finished_check", sql`(${t.status} = 'RUNNING') = (${t.finishedAt} is null)`),
}));
