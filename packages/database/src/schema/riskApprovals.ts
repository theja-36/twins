import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { riskDecisions } from "./riskDecisions";

/**
 * Risk approval cards (Stage 3 / Task 6): the proposal shown to the approver. Created by the application role with the card TEXT already rendered from the
 * approval-eligible risk decision (so the approval bot never reads risk decisions). The bot only reads a card and moves its state forward through
 * SECURITY DEFINER functions (migration 0019): pending -> sent -> decided | expired. The content columns can never change (trigger).
 */
export const riskApprovalCards = pgTable(
  "risk_approval_cards",
  {
    id: uuid("id").primaryKey(),
    riskDecisionId: uuid("risk_decision_id").notNull().references(() => riskDecisions.id, { onDelete: "restrict" }),
    decisionVersion: integer("decision_version").notNull(),
    nonce: text("nonce").notNull(),
    cardText: text("card_text").notNull(),
    /** SHA-256 of `card_text`, fixed at creation. */
    cardContentSha256: text("card_content_sha256").notNull(),
    state: text("state").notNull().default("pending"),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    /** Set when the bot sends the card; must equal `card_content_sha256`. */
    cardTextSha256: text("card_text_sha256"),
    /** The decision's validity: the card (and any approval through it) is void after this instant. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    decisionUnique: uniqueIndex("risk_approval_cards_decision_unique").on(table.riskDecisionId),
    stateIdx: index("risk_approval_cards_state_idx").on(table.state, table.expiresAt),
    stateCheck: check("risk_approval_cards_state_check", sql`${table.state} in ('pending', 'sent', 'decided', 'expired')`),
    shapeCheck: check("risk_approval_cards_shape_check", sql`${table.nonce} ~ '^[0-9a-f]{32}$' and ${table.cardContentSha256} ~ '^[0-9a-f]{64}$' and length(${table.cardText}) between 1 and 3800 and (${table.cardTextSha256} is null or ${table.cardTextSha256} = ${table.cardContentSha256})`),
    sentCheck: check("risk_approval_cards_sent_check", sql`(${table.state} in ('pending', 'expired')) or ${table.telegramMessageId} is not null`),
    actorCheck: check("risk_approval_cards_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

/**
 * Risk approvals (Stage 3 / Task 6): the IMMUTABLE record of an APPROVE or REJECT of ONE risk-decision version. APPEND-ONLY and HASH-CHAINED (hand-written
 * in migration 0019). Written ONLY by the SECURITY DEFINER function `twins_record_risk_approval`, which re-checks eligibility at the moment of approval; neither
 * the runtime role nor the approval bot holds INSERT on this table. One approval per decision version (unique): a changed decision is a new row and needs a
 * new approval. An approval creates no order, fill, position or broker call.
 */
export const riskApprovals = pgTable(
  "risk_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    riskDecisionId: uuid("risk_decision_id").notNull().references(() => riskDecisions.id, { onDelete: "restrict" }),
    decisionVersion: integer("decision_version").notNull(),
    cardId: uuid("card_id").references(() => riskApprovalCards.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    actorContext: jsonb("actor_context").notNull(),
    reason: text("reason"),
    decisionSnapshot: jsonb("decision_snapshot").notNull(),
    evidenceReferences: jsonb("evidence_references").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    cardTextSha256: text("card_text_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionUnique: uniqueIndex("risk_approvals_decision_unique").on(table.riskDecisionId),
    actionCheck: check("risk_approvals_action_check", sql`${table.action} in ('APPROVE', 'REJECT')`),
    actorCheck: check("risk_approvals_actor_check", sql`${table.actor} ~ '^(telegram|operator):[A-Za-z0-9._-]{1,64}$'`),
    rejectReasonCheck: check("risk_approvals_reject_reason_check", sql`${table.action} <> 'REJECT' or (${table.reason} is not null and length(btrim(${table.reason})) > 0)`),
    approveValidityCheck: check("risk_approvals_approve_validity_check", sql`${table.action} <> 'APPROVE' or ${table.validUntil} is not null`),
    reasonLengthCheck: check("risk_approvals_reason_length_check", sql`${table.reason} is null or length(${table.reason}) <= 500`),
  }),
);
