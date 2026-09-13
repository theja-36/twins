import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { counterThesisSeverityEnum, signalValidationOutcomeEnum, sourceReliabilityEnum } from "./enums";
import { signals } from "./signals";

/**
 * Phase 9 - Decision Intelligence Engine output. Deliberately a new
 * table, not a reuse of `decisions` (that table's `decision_outcome`
 * enum - BUY/SELL/WAIT/REJECT - is a later trade-direction decision) or
 * `analyses` (that table requires a non-null `ai_provider`/`ai_model`
 * and is documented as AI reasoning output - Phase 9 is explicitly
 * deterministic, no AI/LLM). This table is the auditable record of
 * "was the evidence sufficient to let this signal proceed" - nothing
 * about position size, order creation, or trade direction.
 *
 * Multiple validation rows may exist per signal over time (no unique
 * constraint on signal_id) - each is an immutable, timestamped snapshot;
 * re-validating never overwrites an earlier verdict.
 */
export const signalValidations = pgTable(
  "signal_validations",
  {
    id: idColumn(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    outcome: signalValidationOutcomeEnum("outcome").notNull(),
    /**
     * Confidence that the available evidence supports the CHOSEN outcome -
     * explicitly NOT a probability of profit (spec section 30 and this
     * phase's own core distinction). `confidenceLabel` restates this on
     * every row so nothing downstream can display the number without the
     * caveat traveling with it.
     */
    decisionConfidence: numeric("decision_confidence").notNull(),
    confidenceLabel: text("confidence_label").notNull(),
    // Structured theses - see @twins/decision-intelligence's types.ts for the JSON shape.
    bullThesis: jsonb("bull_thesis").notNull(),
    bearThesis: jsonb("bear_thesis").notNull(),
    counterThesis: jsonb("counter_thesis").notNull(),
    counterThesisSeverity: counterThesisSeverityEnum("counter_thesis_severity").notNull(),
    sourceReliability: sourceReliabilityEnum("source_reliability").notNull(),
    sourceReliabilityReason: text("source_reliability_reason").notNull(),
    rationale: text("rationale").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    signalIdx: index("signal_validations_signal_idx").on(table.signalId),
  }),
);
