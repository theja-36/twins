import type { schema } from "@twins/database";
import type { SignalIntelligenceReport } from "@twins/signals";
import { buildCounterThesis } from "./counterThesis";
import { assessSourceReliability } from "./sourceReliability";
import { validateSignalStructure, type StructuralValidationOptions } from "./structuralValidation";
import { buildBearThesis, buildBullThesis } from "./thesis";
import { CONFIDENCE_LABEL, type DecisionIntelligenceResult } from "./types";

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
 * Determination logic:
 * - Any BLOCKING structural issue (unresolvable instrument, invalid
 *   direction, a signal timestamped in the future) -> REJECT outright;
 *   evidence quality is irrelevant if the claim itself is invalid.
 * - A "high" severity counter-thesis (a real negative-convention event
 *   opposing the trade) -> REJECT (spec: "exposes a strong invalidating
 *   condition").
 * - Materially incomplete evidence (no market data at all, or both
 *   theses are empty/weak with nothing to reason from) ->
 *   INSUFFICIENT_EVIDENCE - this is a first-class outcome, never forced
 *   into a decision it can't support.
 * - Otherwise -> APPROVE.
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
  let rationale: string;

  if (counterThesis.severity === "high") {
    outcome = "REJECT";
    decisionConfidence = counterThesis.confidence;
    rationale = `Rejected: a high-severity invalidating factor was found - ${counterThesis.strongestFactor?.description ?? "unspecified"}.`;
  } else if (evidenceDomainsPresent === 0 || (bullThesis.factors.length === 0 && bearThesis.factors.length === 0 && evidenceDomainsPresent < 2)) {
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0.5;
    rationale = "Insufficient evidence: too little corroborating market/macro/news evidence exists to support a reliable decision either way.";
  } else if (counterThesis.severity === "medium" && contradictingCount >= supportingCount) {
    outcome = "INSUFFICIENT_EVIDENCE";
    decisionConfidence = 0.5;
    rationale = `Insufficient evidence: a medium-severity contradiction (${counterThesis.strongestFactor?.description ?? "unspecified"}) outweighs the available support for this signal's direction.`;
  } else {
    outcome = "APPROVE";
    decisionConfidence = supportingCount + contradictingCount > 0 ? supportingCount / (supportingCount + contradictingCount) : 0.5;
    rationale = "Approved: no blocking or high-severity contradiction was found, and available evidence does not materially oppose the signal's direction.";
  }

  return {
    signalId: signal.id,
    outcome,
    decisionConfidence,
    confidenceLabel: CONFIDENCE_LABEL,
    structuralIssues: structural.issues,
    bullThesis,
    bearThesis,
    counterThesis,
    sourceReliability,
    rationale,
    validatedAt: now,
  };
}
