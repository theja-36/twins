/**
 * Phase 9 - Decision Intelligence Engine. Every type here is produced by
 * deterministic rules over Phase 8's evidence (@twins/signals) - there is
 * no AI/LLM call anywhere in this package, and nothing here is a trade
 * decision: no position size, no order, no trade direction. The output
 * is a candidate verdict on whether the evidence is sufficient for a
 * signal to proceed - suitable input for a future Decision/Risk Engine,
 * not a replacement for either.
 */

export type SignalValidationOutcome = "APPROVE" | "REJECT" | "INSUFFICIENT_EVIDENCE";

export type CounterThesisSeverity = "low" | "medium" | "high";

/**
 * Reliability must never be a fabricated trust score (spec: "Do not
 * hardcode arbitrary real-world credibility claims"). UNKNOWN is the
 * only value this phase ever produces, since no historical
 * outcome-tracking table exists yet; LOW/MODERATE/HIGH are reserved for
 * a future phase that actually measures verified track record.
 */
export type SourceReliabilityLevel = "UNKNOWN" | "LOW" | "MODERATE" | "HIGH";

export interface SourceReliabilityAssessment {
  level: SourceReliabilityLevel;
  reason: string;
}

/**
 * A single deterministic factor feeding a thesis. `evidenceId` ties it
 * back to an actual normalized-evidence item (spec: "Every supporting
 * claim must reference actual evidence" / "Never invent supporting
 * facts") - a factor with no evidenceId is a structural observation
 * about the evidence set itself (e.g. "no news evidence exists"), never
 * a claim about the world.
 */
export interface ThesisFactor {
  ruleId: string;
  description: string;
  evidenceId?: string | undefined;
}

export interface Thesis {
  /** "supporting" (bull, for the signal's proposed direction) or "contradicting" (bear, against it). */
  stance: "supporting" | "contradicting";
  factors: ThesisFactor[];
  evidenceIds: string[];
  /** Deterministic, not a probability: how many factors were found, not how likely they are to be right. */
  strength: "weak" | "moderate" | "strong";
}

export interface CounterThesis {
  /** The direction that would invalidate the signal's proposed trade. */
  opposingDirection: "buy" | "sell";
  strongestFactor: ThesisFactor | null;
  invalidationFactors: ThesisFactor[];
  evidenceIds: string[];
  severity: CounterThesisSeverity;
  /** Confidence that this counter-thesis's strongest factor is a real, evidenced concern - not a probability the trade will lose money. */
  confidence: number;
}

export interface StructuralValidationIssue {
  ruleId: string;
  description: string;
}

export interface DecisionIntelligenceResult {
  signalId: string;
  outcome: SignalValidationOutcome;
  /** Confidence that the evidence supports the CHOSEN outcome - explicitly NOT a probability of profit. */
  decisionConfidence: number;
  confidenceLabel: string;
  /**
   * True only when an evidence-derived confidence was not a finite number and was discarded: then
   * `decisionConfidence` is the placeholder 0 (NOT a measurement), `confidenceLabel` says so explicitly and
   * the outcome is unaffected. Absent in every normal result.
   */
  confidenceUnavailable?: boolean;
  structuralIssues: StructuralValidationIssue[];
  bullThesis: Thesis;
  bearThesis: Thesis;
  counterThesis: CounterThesis;
  sourceReliability: SourceReliabilityAssessment;
  rationale: string;
  validatedAt: Date;
}

export const CONFIDENCE_LABEL =
  "Confidence that available evidence supports this outcome, not a probability of profit.";

/** Appended to the label when a confidence value had to be discarded (see DecisionIntelligenceResult.confidenceUnavailable). */
export const CONFIDENCE_UNAVAILABLE_NOTE =
  "Confidence UNAVAILABLE for this decision: the evidence-derived value was invalid and was discarded; the stored 0 is a placeholder, not a measurement.";
