import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { optionsClaims } from "./optionsClaims";

/**
 * Approval bot (separate service; places NO orders). These four tables are the ONLY tables the bot's database role may
 * write (the bot role cannot write options_claims and cannot read telegram_messages.raw_text / raw_payload).
 *
 * - claim_review_cards: the mutable per-card state machine (pending -> sent -> decided | expired). `kind='test'` cards
 *   (handshake) have no claim. One card per claim (unique claim_id).
 * - claim_reviews: APPEND-ONLY decisions (trigger blocks UPDATE/DELETE/TRUNCATE; unique per card). "approve" records
 *   intent only: it changes no claim and enables nothing (options_claims.approval_possible stays false by CHECK).
 * - approval_bot_events: APPEND-ONLY, content-free lifecycle and security events.
 * - approval_bot_state: one row: activation time (only claims created after it get cards), pause flag, update offset.
 */
export const claimReviewCards = pgTable(
  "claim_review_cards",
  {
    id: idColumn(),
    kind: text("kind").notNull(), // claim | test
    claimId: uuid("claim_id").references(() => optionsClaims.id, { onDelete: "restrict" }),
    state: text("state").notNull(), // pending | sent | decided | expired
    nonce: text("nonce").notNull(), // 32 hex chars, binds the signed button data to this card instance
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    cardTextSha256: text("card_text_sha256"),
    createdAt: createdAtColumn(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    claimUnique: uniqueIndex("claim_review_cards_claim_unique").on(table.claimId),
    stateIdx: index("claim_review_cards_state_idx").on(table.state, table.expiresAt),
    kindCheck: check("claim_review_cards_kind_check", sql`${table.kind} in ('claim', 'test')`),
    stateCheck: check("claim_review_cards_state_check", sql`${table.state} in ('pending', 'sent', 'decided', 'expired')`),
    claimShapeCheck: check("claim_review_cards_claim_shape_check", sql`(${table.kind} = 'claim') = (${table.claimId} is not null)`),
    nonceCheck: check("claim_review_cards_nonce_check", sql`${table.nonce} ~ '^[0-9a-f]{32}$'`),
    hashCheck: check("claim_review_cards_hash_check", sql`${table.cardTextSha256} is null or ${table.cardTextSha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const claimReviews = pgTable(
  "claim_reviews",
  {
    id: idColumn(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => claimReviewCards.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => optionsClaims.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(), // approve | reject
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    approverTelegramUserId: bigint("approver_telegram_user_id", { mode: "number" }).notNull(),
    cardTelegramMessageId: bigint("card_telegram_message_id", { mode: "number" }).notNull(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    evidence: jsonb("evidence").notNull(), // claim id, parser version, sha256 of the claim JSON and of the card text, reason codes
    createdAt: createdAtColumn(),
  },
  (table) => ({
    cardUnique: uniqueIndex("claim_reviews_card_unique").on(table.cardId),
    claimIdx: index("claim_reviews_claim_idx").on(table.claimId),
    decisionCheck: check("claim_reviews_decision_check", sql`${table.decision} in ('approve', 'reject')`),
    evidenceSizeCheck: check("claim_reviews_evidence_size_check", sql`octet_length(${table.evidence}::text) <= 4096`),
  }),
);

export const approvalBotEvents = pgTable(
  "approval_bot_events",
  {
    id: idColumn(),
    eventType: text("event_type").notNull(),
    cardId: uuid("card_id").references(() => claimReviewCards.id, { onDelete: "restrict" }),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    typeCreatedIdx: index("approval_bot_events_type_idx").on(table.eventType, table.createdAt),
    typeCheck: check("approval_bot_events_type_check", sql`${table.eventType} ~ '^[a-z][a-z0-9_:]{2,60}$'`),
    detailSizeCheck: check("approval_bot_events_detail_size_check", sql`octet_length(${table.detail}::text) <= 2048`),
  }),
);

export const approvalBotState = pgTable(
  "approval_bot_state",
  {
    id: text("id").primaryKey(), // always 'bot'
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    paused: boolean("paused").notNull().default(false),
    updateOffset: bigint("update_offset", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleRowCheck: check("approval_bot_state_single_row_check", sql`${table.id} = 'bot'`),
  }),
);
