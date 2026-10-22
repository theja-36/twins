import { boolean, check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAtColumn, idColumn } from "./_columns";
import { telegramMessages } from "./telegram";

/**
 * UNVERIFIED options claims recognised in Telegram messages (offline parse + assessment). A row is a record of what a
 * message said and how the assessor classified it - NOT a signal, NOT an instrument, NOT an approval and NOT an order.
 *
 * - One row per (message, parser version): a retry finds the existing row and never creates a second or overwrites it.
 *   A different parser version is a separate, explicitly labelled row.
 * - `result_kind` = claim | ambiguous | unsupported. Only a "claim" carries a parsed `claim`; ambiguous/unsupported
 *   results keep their `detail` and never an invented complete claim.
 * - `provenance` records the contract master / premium provider actually used (or that none was configured).
 * - `approval_possible` is constrained to false at the database level.
 */
export const optionsClaims = pgTable(
  "options_claims",
  {
    id: idColumn(),
    telegramMessageId: uuid("telegram_message_id")
      .notNull()
      .references(() => telegramMessages.id, { onDelete: "restrict" }),
    parserVersion: text("parser_version").notNull(),
    resultKind: text("result_kind").notNull(), // claim | ambiguous | unsupported
    claim: jsonb("claim"), // parsed OptionsClaim; null unless result_kind = 'claim'
    detail: jsonb("detail"), // ambiguous directives / unsupported symbol + shape
    assessmentOutcome: text("assessment_outcome"), // INSUFFICIENT_EVIDENCE | REJECT; null when not assessed
    reasons: jsonb("reasons").notNull(), // [{ code, severity, description }]
    verification: jsonb("verification"), // contract verification actually obtained; null when not assessed
    premium: jsonb("premium"), // premium lookup actually obtained; null when not assessed
    provenance: jsonb("provenance").notNull(), // contract master / premium provider actually used
    approvalPossible: boolean("approval_possible").notNull().default(false),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    messageParserUnique: uniqueIndex("options_claims_message_parser_unique").on(table.telegramMessageId, table.parserVersion),
    messageIdx: index("options_claims_message_idx").on(table.telegramMessageId),
    kindCheck: check("options_claims_result_kind_check", sql`${table.resultKind} in ('claim', 'ambiguous', 'unsupported')`),
    claimShapeCheck: check("options_claims_claim_shape_check", sql`(${table.resultKind} = 'claim') = (${table.claim} is not null)`),
    neverApprovableCheck: check("options_claims_never_approvable_check", sql`${table.approvalPossible} = false`),
  }),
);
