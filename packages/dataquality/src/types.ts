/**
 * Phase 5 - Data Quality & Integrity Engine. Purely deterministic: every
 * check here is a structural/statistical rule with a stable id, never an
 * LLM call and never a trading decision. Output is a QualityAssessment
 * that downstream analysis (a later phase) can consult; this engine does
 * not decide BUY/SELL/WAIT/REJECT and does not touch the Decision or
 * Risk Engine.
 */

export type QualityDimension =
  | "validity"
  | "completeness"
  | "freshness"
  | "consistency"
  | "uniqueness"
  | "source_reliability"
  | "temporal_integrity"
  | "cross_source_conflict"
  | "anomaly"
  | "lineage";

export type OverallStatus = "trusted" | "flagged" | "rejected";

export interface DimensionOutcome {
  dimension: QualityDimension;
  /** A stable, greppable identifier for the specific rule that produced this outcome. */
  ruleId: string;
  passed: boolean;
  /** True when the dimension does not apply to this entity type (excluded from scoring). */
  applicable: boolean;
  detail?: string | undefined;
}

export interface QualityAssessmentInput {
  entityType: string;
  entityId: string;
  source: string;
}

export interface QualityAssessmentResult extends QualityAssessmentInput {
  overallStatus: OverallStatus;
  qualityScore: number; // 0..1: passed applicable dimensions / total applicable dimensions
  dimensions: DimensionOutcome[];
  reasons: string[];
  evaluatedAt: Date;
}

/**
 * Combines individual dimension outcomes into a final verdict.
 * - "rejected": a validity or lineage failure - the record cannot be
 *   trusted at all (this should be rare, since Phase 4 already rejects
 *   structurally invalid data before it is ever persisted; this exists
 *   for defense-in-depth and for re-assessing older/directly-written rows).
 * - "flagged": any other applicable dimension failed.
 * - "trusted": every applicable dimension passed.
 */
export function summarizeAssessment(
  input: QualityAssessmentInput,
  outcomes: DimensionOutcome[],
): QualityAssessmentResult {
  const applicable = outcomes.filter((o) => o.applicable);
  const failed = applicable.filter((o) => !o.passed);
  const hardFailure = failed.some(
    (o) => o.dimension === "validity" || o.dimension === "lineage",
  );

  const overallStatus: OverallStatus = hardFailure
    ? "rejected"
    : failed.length > 0
      ? "flagged"
      : "trusted";

  const qualityScore = applicable.length === 0 ? 1 : (applicable.length - failed.length) / applicable.length;

  const reasons = failed
    .map((o) => o.detail ?? `${o.dimension} check failed (${o.ruleId})`)
    .sort();

  return {
    ...input,
    overallStatus,
    qualityScore,
    dimensions: outcomes,
    reasons,
    evaluatedAt: new Date(),
  };
}
