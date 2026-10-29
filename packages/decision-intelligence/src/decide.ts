import type { schema } from "@twins/database";
import { assertStopLossAllowsEligibility } from "@twins/stop-loss";
import type { SignalIntelligenceReport } from "@twins/signals";
import { buildCounterThesis } from "./counterThesis";
import { assessSourceReliability } from "./sourceReliability";
import { validateSignalStructure, type StructuralValidationOptions } from "./structuralValidation";
import { buildBearThesis, buildBullThesis } from "./thesis";
import { CONFIDENCE_LABEL, CONFIDENCE_UNAVAILABLE_NOTE, type DecisionIntelligenceResult } from "./types";

export interface DecideOptions extends StructuralValidationOptions {
  now?: Date;
}

/**
 * The Phase 9 decision pipeline, as a pure function over already-fetched
 * data (spec section 4): Decision Context -> Evidence Evaluation -> Bull
 * Thesis -> Bear Thesis -> Counter-Thesis -> Conflict Analysis ->
 * Signal-vs-Evidence Validation -> Decision Determination -> Confidence.
 * No database access here, deliberately - this is the part unit tests
 * exercise directly with fixtures, no Postgres required.
 *
 * Determination logic & safety gates (R0A / LOG-01 & LOG-02):
 * - Any BLOCKING structural issue (unresolvable instrument, invalid
 *   direction, stale signal, future signal, invalid timestamp) -> REJECT outright.
 * - A "high" severity counter-thesis (a real negative-convention event
 *   opposing the trade) -> REJECT.
 * - Materially incomplete evidence -> INSUFFICIENT_EVIDENCE.
 * - Zero supporting evidence (supportingCount === 0) -> INSUFFICIENT_EVIDENCE
 *   (approvals are strictly prevented when required supporting evidence is absent).
 * - Contradicting factors >= supporting factors -> INSUFFICIENT_EVIDENCE.
 * - Numerical safety: zero denominators yield 0. A non-finite evidence-derived confidence is NEVER turned
 *   into a high confidence: it is discarded, the placeholder 0 is stored, `confidenceUnavailable` is set and
 *   the label/rationale say so (the outcome itself is unchanged and stays fail-closed). Confidence is a
 *   count-based measure of evidence support for the chosen outcome, not a calibrated probability.
 * - Freshness: `structural.stale_signal` is a HISTORICAL ingestion/analysis bound (see
 *   validateSignalStructure), not an executable-freshness policy. APPROVE here means "evidence sufficient for
 *   analysis" and does not authorise execution; executable freshness is undefined and must be decided
 *   separately before any execution capability consumes this result.
 * - Otherwise (supportingCount > 0, supportingCount > contradictingCount, no high/medium opposition) -> APPROVE.
 */
export function decide(
  signal: typeof schema.signals.$inferSelect,
  instrument: typeof schema.instruments.$inferSelect | null,
  report: SignalIntelligenceReport,
  options: DecideOptions = {},
): DecisionIntelligenceResult {
  const now = options.now ?? new Date();
  const structural = validateSignalStructure(signal, instrument, now, options);
  const sourceReliability = assessSourceReliability();

  if (structural.blocking) {
    const bullThesis = { stance: "supporting" as const, factors: [], evidenceIds: [], strength: "weak" as const };
    const bearThesis = { stance: "contradicting" as const, factors: [], evidenceIds: [], strength: "weak" as const };
    const counterThesis = buildCounterThesis(signal.direction, bullThesis, bearThesis);
    return {
      signalId: signal.id,
      outcome: "REJECT",
      stopLoss: structural.stopLoss,
      ...(structural.stopLoss.reasonCode ? { stopLossReasonCode: structural.stopLoss.reasonCode } : {}),
      // Deterministic by rule (a structurally invalid claim is rejected outright); not derived from any
      // evidence-based or possibly non-finite input.
      decisionConfidence: 1,
      confidenceLabel: CONFIDENCE_LABEL,
      structuralIssues: structural.issues,
      bullThesis,
      bearThesis,
      counterThesis,
      sourceReliability,
      rationale: `Rejected: the signal itself is structurally invalid (${structural.issues.map((i) => i.description).join("; ")}).`,
      validatedAt: now,
    };
  }

  const bullThesis = buildBullThesis(report);
  const bearThesis = buildBearThesis(report);
  const counterThesis = buildCounterThesis(signal.direction, bullThesis, bearThesis);

  const evidenceDomainsPresent = [
    report.core.marketContext !== null,
    report.core.macroContext.length > 0,
    report.core.newsContext.length > 0,
  ].filter(Boolean).length;

  const supportingCount = signal.direction === "buy" ? bullThesis.factors.length : bearThesis.factors.length;
  const contradictingCount = signal.direction === "buy" ? bearThesis.factors.length : bullThesis.factors.length;

  let outcome: DecisionIntelligenceResult["outcome"];
  let decisionConfidence: number;
  let confidenceUnavailable = false;
  let rationale: string;

  if (structural.stopLoss.result !== "VALID") {
    // Not blocking-structural (AMBIGUOUS: no usable reference price, unsupported instrument or side): never approvable. Flagged, not silently passed.
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0;
    rationale = `Insufficient evidence: the mandatory stop-loss could not be validated (${structural.stopLoss.reasonCode}${structural.stopLoss.detail ? `: ${structural.stopLoss.detail}` : ""}); a signal without a valid stop-loss is never eligible.`;
  } else if (counterThesis.severity === "high") {
    outcome = "REJECT";
    const rawConfidence = counterThesis.confidence;
    if (Number.isFinite(rawConfidence)) {
      decisionConfidence = Math.min(1, Math.max(0, rawConfidence));
    } else {
      // Invalid/unavailable: never promoted to a high confidence. The REJECT outcome (fail-closed) stands.
      decisionConfidence = 0;
      confidenceUnavailable = true;
    }
    rationale = `Rejected: a high-severity invalidating factor was found - ${counterThesis.strongestFactor?.description ?? "unspecified"}.${confidenceUnavailable ? " (Decision confidence unavailable: the evidence-derived value was invalid.)" : ""}`;
  } else if (
    evidenceDomainsPresent === 0 ||
    (bullThesis.factors.length === 0 && bearThesis.factors.length === 0 && evidenceDomainsPresent < 2)
  ) {
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0.5;
    rationale =
      "Insufficient evidence: too little corroborating market/macro/news evidence exists to support a reliable decision either way.";
  } else if (counterThesis.severity === "medium" && contradictingCount >= supportingCount) {
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0.5;
    rationale = `Insufficient evidence: a medium-severity contradiction (${counterThesis.strongestFactor?.description ?? "unspecified"}) outweighs the available support for this signal's direction.`;
  } else if (supportingCount === 0) {
    // Missing required supporting evidence: cannot approve when supporting evidence is zero (LOG-01)
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0;
    rationale = "Insufficient evidence: no supporting evidence exists to corroborate this signal's direction.";
  } else if (contradictingCount >= supportingCount) {
    outcome = "INSUFFICIENT_EVIDENCE";
    const totalFactors = supportingCount + contradictingCount;
    const rawRatio = totalFactors > 0 ? supportingCount / totalFactors : 0;
    decisionConfidence = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 0;
    rationale = "Insufficient evidence: contradicting factors equal or exceed supporting evidence.";
  } else {
    outcome = "APPROVE";
    const totalFactors = supportingCount + contradictingCount;
    const rawRatio = totalFactors > 0 ? supportingCount / totalFactors : 0;
    decisionConfidence = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 0;
    rationale =
      "Approved: no blocking or high-severity contradiction was found, and available evidence does not materially oppose the signal's direction.";
  }

  // Defence in depth: whatever the branches above decided, an execution-eligible state (APPROVE today) cannot leave this function without a VALID stop-loss.
  assertStopLossAllowsEligibility(outcome, structural.stopLoss);

  return {
    signalId: signal.id,
    outcome,
    stopLoss: structural.stopLoss,
    ...(structural.stopLoss.reasonCode ? { stopLossReasonCode: structural.stopLoss.reasonCode } : {}),
    decisionConfidence,
    confidenceLabel: confidenceUnavailable ? `${CONFIDENCE_LABEL} ${CONFIDENCE_UNAVAILABLE_NOTE}` : CONFIDENCE_LABEL,
    ...(confidenceUnavailable ? { confidenceUnavailable: true } : {}),
    structuralIssues: structural.issues,
    bullThesis,
    bearThesis,
    counterThesis,
    sourceReliability,
    rationale,
    validatedAt: now,
  };
}
