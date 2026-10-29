import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { signals } from "./signals";
import { optionsClaims } from "./optionsClaims";
import { stopLossValidations } from "./stopLossValidations";
import { decisions } from "./decisions";

/**
 * The risk decision (Stage 3 / Task 1): the mandatory, durable, IMMUTABLE link between a parsed signal / options claim, its stop-loss validation
 * evidence and every later stage (sizing, portfolio limits, approval, order intent). No order can reference anything else (migration 0014 adds the
 * orders guard). APPEND-ONLY and HASH-CHAINED like the other audit tables (the chain columns, triggers, view and guards are added by hand in
 * migration 0014 and are not modelled here, same convention as 0010/0011).
 *
 * LIFECYCLE WITHOUT UPDATES: a decision row never changes. A revision is a NEW row (`supersedes_id` -> the previous row, `decision_version` + 1);
 * the view `risk_decisions_effective` derives `superseded_by_id`, `superseded_at` and the effective status SUPERSEDED from that link.
 * Exactly one subject (a signal XOR an options claim). `stop_loss_validation_id` is mandatory and must belong to the same subject.
 *
 * The first five columns after `id` of the pre-Stage-3 table (`decision_id`, `approved`, `reasons`, `max_position_size`, `risk_per_trade`) are
 * DEPRECATED, kept only so no historical column is dropped; a check constraint forces them to NULL on every row.
 */
export const riskDecisions = pgTable(
  "risk_decisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** @deprecated pre-Stage-3 column; must be NULL. */
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "cascade" }),
    /** @deprecated pre-Stage-3 column; must be NULL. */
    approved: boolean("approved"),
    /** @deprecated pre-Stage-3 column; must be NULL. */
    reasons: jsonb("reasons"),
    /** @deprecated pre-Stage-3 column; must be NULL. */
    maxPositionSize: numeric("max_position_size"),
    /** @deprecated pre-Stage-3 column; must be NULL. */
    riskPerTrade: numeric("risk_per_trade"),
    signalId: uuid("signal_id").references(() => signals.id, { onDelete: "restrict" }),
    optionsClaimId: uuid("options_claim_id").references(() => optionsClaims.id, { onDelete: "restrict" }),
    stopLossValidationId: uuid("stop_loss_validation_id").references(() => stopLossValidations.id, { onDelete: "restrict" }),
    /** The previous version this row replaces (NULL for version 1). At most one successor per row. */
    supersedesId: uuid("supersedes_id"),
    decisionVersion: integer("decision_version"),
    /** PENDING | APPROVED_FOR_REVIEW | REJECTED | EXPIRED | SUPERSEDED (SUPERSEDED is only ever derived by the view, never stored). */
    status: text("status"),
    /** Makes a retried creation idempotent. */
    idempotencyKey: text("idempotency_key"),
    instrumentType: text("instrument_type"),
    market: text("market"),
    symbol: text("symbol"),
    expiry: date("expiry"),
    strike: numeric("strike"),
    optionType: text("option_type"),
    side: text("side"),
    entryPrice: numeric("entry_price"),
    stopLoss: numeric("stop_loss"),
    stopLossBasis: text("stop_loss_basis"),
    target1: numeric("target_1"),
    target2: numeric("target_2"),
    target3: numeric("target_3"),
    /** Sizing and exposure fields are NULL in this task (no position sizing yet); later stages append new versions that fill them. */
    plannedQuantity: numeric("planned_quantity"),
    plannedNotional: numeric("planned_notional"),
    plannedMaxLossAmount: numeric("planned_max_loss_amount"),
    plannedMaxLossPercent: numeric("planned_max_loss_percent"),
    plannedRiskRewardRatio: numeric("planned_risk_reward_ratio"),
    confidenceScore: numeric("confidence_score"),
    sourceTrustTier: text("source_trust_tier"),
    decisionReasonCode: text("decision_reason_code"),
    decisionReason: text("decision_reason"),
    /** Complete inputs the decision was made from (signal/claim fields, stop-loss evidence, validation, trust). */
    inputSnapshot: jsonb("input_snapshot"),
    outputSnapshot: jsonb("output_snapshot"),
    /** Ids of the records this decision rests on (stop-loss validation, signal validation, message, ...). */
    evidenceReferences: jsonb("evidence_references"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => ({
    signalIdx: index("risk_decisions_signal_idx").on(table.signalId),
    claimIdx: index("risk_decisions_claim_idx").on(table.optionsClaimId),
    evidenceIdx: index("risk_decisions_stop_loss_idx").on(table.stopLossValidationId),
    supersedesUnique: uniqueIndex("risk_decisions_supersedes_unique").on(table.supersedesId),
    idempotencyUnique: uniqueIndex("risk_decisions_idempotency_unique").on(table.idempotencyKey),
    firstSignalUnique: uniqueIndex("risk_decisions_first_signal_unique").on(table.signalId).where(sql`${table.supersedesId} is null and ${table.signalId} is not null`),
    firstClaimUnique: uniqueIndex("risk_decisions_first_claim_unique").on(table.optionsClaimId).where(sql`${table.supersedesId} is null and ${table.optionsClaimId} is not null`),
    statusCheck: check("risk_decisions_status_check", sql`${table.status} in ('PENDING', 'APPROVED_FOR_REVIEW', 'REJECTED', 'EXPIRED', 'SUPERSEDED')`),
    subjectCheck: check("risk_decisions_subject_check", sql`(${table.signalId} is not null) <> (${table.optionsClaimId} is not null)`),
    legacyNullCheck: check("risk_decisions_legacy_null_check", sql`${table.decisionId} is null and ${table.approved} is null and ${table.reasons} is null and ${table.maxPositionSize} is null and ${table.riskPerTrade} is null`),
    requiredCheck: check(
      "risk_decisions_required_check",
      sql`${table.stopLossValidationId} is not null and ${table.decisionVersion} >= 1 and ${table.status} is not null and ${table.idempotencyKey} is not null and ${table.inputSnapshot} is not null and ${table.evidenceReferences} is not null and ${table.decisionReasonCode} is not null and ${table.createdBy} is not null and ${table.instrumentType} is not null and ${table.symbol} is not null`,
    ),
    versionCheck: check("risk_decisions_version_check", sql`(${table.supersedesId} is null) = (${table.decisionVersion} = 1)`),
    numbersCheck: check(
      "risk_decisions_numbers_check",
      sql`(${table.entryPrice} is null or ${table.entryPrice} > 0) and (${table.stopLoss} is null or ${table.stopLoss} > 0) and (${table.target1} is null or ${table.target1} > 0) and (${table.target2} is null or ${table.target2} > 0) and (${table.target3} is null or ${table.target3} > 0) and (${table.strike} is null or ${table.strike} > 0) and (${table.plannedQuantity} is null or ${table.plannedQuantity} >= 0) and (${table.plannedNotional} is null or ${table.plannedNotional} >= 0) and (${table.plannedMaxLossAmount} is null or ${table.plannedMaxLossAmount} >= 0) and (${table.plannedMaxLossPercent} is null or ${table.plannedMaxLossPercent} >= 0) and (${table.plannedRiskRewardRatio} is null or ${table.plannedRiskRewardRatio} >= 0) and (${table.confidenceScore} is null or (${table.confidenceScore} >= 0 and ${table.confidenceScore} <= 100))`,
    ),
    reviewShapeCheck: check("risk_decisions_review_shape_check", sql`${table.status} <> 'APPROVED_FOR_REVIEW' or (${table.stopLoss} is not null and ${table.entryPrice} is not null and ${table.stopLossBasis} is not null)`),
    // Stage 3 / Task 2: a decision without a valid position size can never be approval-eligible.
    sizedReviewCheck: check(
      "risk_decisions_sized_review_check",
      sql`${table.status} <> 'APPROVED_FOR_REVIEW' or (coalesce(${table.plannedQuantity} > 0, false) and coalesce(${table.plannedNotional} > 0, false) and coalesce(${table.plannedMaxLossAmount} > 0, false) and coalesce(${table.plannedMaxLossPercent} > 0, false) and coalesce(${table.outputSnapshot} -> 'sizing' ->> 'status' = 'SIZED', false))`,
    ),
    // Stage 3 / Task 3: an approval for review also needs a passing portfolio evaluation (NULL counts as not evaluated).
    portfolioReviewCheck: check(
      "risk_decisions_portfolio_review_check",
      sql`${table.status} <> 'APPROVED_FOR_REVIEW' or coalesce(${table.outputSnapshot} -> 'portfolio' ->> 'outcome' = 'APPROVED_FOR_REVIEW', false)`,
    ),
    // Stage 3 / Task 5: an approval for review also needs PASSING market-risk gates (NULL counts as not evaluated).
    marketReviewCheck: check(
      "risk_decisions_market_review_check",
      sql`${table.status} <> 'APPROVED_FOR_REVIEW' or coalesce(${table.outputSnapshot} -> 'market' ->> 'outcome' = 'PASSED', false)`,
    ),
    actorCheck: check("risk_decisions_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);
