import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { signals } from "./signals";
import { optionsClaims } from "./optionsClaims";

/**
 * Evidence of the mandatory stop-loss validation (Stage 1 / Task 4), one row per validation of a signal or an options claim, produced by the
 * single shared rule in @twins/stop-loss. APPEND-ONLY and HASH-CHAINED like the other audit tables (migration 0011 adds the chain columns,
 * triggers and the signal_validations invariant by hand; the chain columns are not modelled here, same as migration 0010).
 * Exactly one subject (a signal, or an options claim). `reason_code` is NULL exactly when `result` is VALID.
 */
export const stopLossValidations = pgTable(
  "stop_loss_validations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    subjectKind: text("subject_kind").notNull(), // signal | options_claim
    signalId: uuid("signal_id").references(() => signals.id, { onDelete: "restrict" }),
    optionsClaimId: uuid("options_claim_id").references(() => optionsClaims.id, { onDelete: "restrict" }),
    /** Makes a retried validation idempotent (the validation's own key, prefixed). NULL = ordinary re-validation. */
    idempotencyKey: text("idempotency_key"),
    ruleVersion: text("rule_version").notNull(),
    result: text("result").notNull(), // VALID | INVALID | MISSING | AMBIGUOUS
    reasonCode: text("reason_code"),
    detail: text("detail"),
    instrumentType: text("instrument_type"),
    instrumentKind: text("instrument_kind"),
    side: text("side"),
    optionType: text("option_type"),
    levelBasis: text("level_basis"),
    /** The stop-loss exactly as parsed/stored (text); NULL when absent. */
    originalStopLoss: text("original_stop_loss"),
    normalizedStopLoss: numeric("normalized_stop_loss"),
    /** The entry/reference price the stop was compared with. */
    entryPrice: numeric("entry_price"),
    riskDistance: numeric("risk_distance"),
    riskPct: numeric("risk_pct"),
    maxRiskPct: numeric("max_risk_pct"),
    maxRiskSource: text("max_risk_source"),
    expectedStopSide: text("expected_stop_side"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    signalIdx: index("stop_loss_validations_signal_idx").on(table.signalId),
    claimIdx: index("stop_loss_validations_claim_idx").on(table.optionsClaimId),
    idempotencyUnique: uniqueIndex("stop_loss_validations_idempotency_unique").on(table.idempotencyKey),
    subjectCheck: check(
      "stop_loss_validations_subject_check",
      sql`(${table.subjectKind} = 'signal' and ${table.signalId} is not null and ${table.optionsClaimId} is null) or (${table.subjectKind} = 'options_claim' and ${table.optionsClaimId} is not null and ${table.signalId} is null)`,
    ),
    resultCheck: check("stop_loss_validations_result_check", sql`${table.result} in ('VALID', 'INVALID', 'MISSING', 'AMBIGUOUS')`),
    reasonCheck: check("stop_loss_validations_reason_check", sql`(${table.result} = 'VALID') = (${table.reasonCode} is null)`),
    validShapeCheck: check(
      "stop_loss_validations_valid_shape_check",
      sql`${table.result} <> 'VALID' or (${table.normalizedStopLoss} is not null and ${table.normalizedStopLoss} > 0 and ${table.entryPrice} is not null and ${table.entryPrice} > 0 and ${table.riskDistance} > 0)`,
    ),
  }),
);
