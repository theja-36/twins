import { jsonb, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { signals } from "./signals";

/**
 * AI reasoning output for a signal (spec sections 24/28/30) - strictly
 * INFERRED information (spec section 22). Never treated as observed fact
 * and never directly executable (spec section 26); it only feeds the
 * Decision Engine, which itself cannot bypass the Risk Engine.
 *
 * `confidenceLabel` exists so any displayed confidence is explicitly
 * captioned rather than silently implying a calibrated probability of
 * profit (spec section 30).
 */
export const analyses = pgTable("analyses", {
  id: idColumn(),
  signalId: uuid("signal_id")
    .notNull()
    .references(() => signals.id, { onDelete: "cascade" }),
  aiProvider: text("ai_provider").notNull(),
  aiModel: text("ai_model").notNull(),
  bullThesis: text("bull_thesis"),
  bearThesis: text("bear_thesis"),
  supportingEvidenceIds: jsonb("supporting_evidence_ids"), // signal_evidence.id[]
  contradictingEvidenceIds: jsonb("contradicting_evidence_ids"), // signal_evidence.id[]
  marketRegime: text("market_regime"),
  macroContext: text("macro_context"),
  riskContext: text("risk_context"),
  confidence: numeric("confidence"),
  confidenceLabel: text("confidence_label"), // e.g. "model self-reported, not calibrated"
  rawAiResponse: jsonb("raw_ai_response"),
  createdAt: createdAtColumn(),
});
