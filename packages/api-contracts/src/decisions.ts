/**
 * Stage 09.3B.1: decision record contents, verified against REAL engine output (packages/decision `decide` through the real decision cycle, stored in Postgres, read through GET /decisions/:id).
 * CORRECTION to the 09.3B.0 audit: the stored `explanation` is the engine's Explanation PLUS `reasons`, `restrictions`, `whatWouldChange` and `provenance` (decision/src/cycle.ts), so the full rationale IS exposed.
 * The OUTCOME vocabulary is deliberately NOT mirrored here (it stays an opaque string; see contracts-verification.md): an outcome is the engine's eligibility verdict, never an approval.
 */
import type { IsoTimestamp, Uuid } from "./wire";

export const DECISION_VIEW_KEYS = ["id", "accountId", "candidateId", "outcome", "workflowState", "explanation", "stopLossValidation", "permittedSize", "evidenceRefs", "versions", "validFrom", "validUntil", "supersedesId", "createdAt", "invalidated", "simulationId", "riskAssessmentId"] as const;
export const DECISION_EXPLANATION_KEYS = ["headline", "supporting", "missing", "contradictory", "riskRestrictions", "sizeRestriction", "expiry", "reassess", "invalidatedBy", "reasons", "restrictions", "whatWouldChange", "provenance"] as const;
export const DECISION_REASON_KEYS = ["code", "category", "detail"] as const;
export const EXPLANATION_PROVENANCE_KEYS = ["candidateId", "candidateSource", "dataSource", "researchPackageId", "researchPackageSha256", "confidenceAssessmentId", "riskAssessmentId", "simulationId"] as const;
export interface DecisionReasonView { code: string; category: string; detail: string }
export interface DecisionExplanationView {
  headline: string; supporting: string[]; missing: string[]; contradictory: string[]; riskRestrictions: string[]; sizeRestriction: string | null; expiry: string; reassess: string[]; invalidatedBy: string[];
  reasons: DecisionReasonView[]; restrictions: DecisionReasonView[]; whatWouldChange: string[];
  provenance: { candidateId: Uuid; candidateSource: string; dataSource: string; researchPackageId: Uuid | null; researchPackageSha256: string | null; confidenceAssessmentId: Uuid | null; riskAssessmentId: Uuid | null; simulationId: Uuid | null };
}
/** The four fields of StopLossValidation guaranteed by its type (packages/stop-loss). Other fields are present on a VALID result but are not guaranteed for every result, so they stay unverified. */
export const STOP_LOSS_VALIDATION_CORE_KEYS = ["ruleVersion", "result", "reasonCode", "detail"] as const;
export interface StopLossValidationView { ruleVersion: string; result: string; reasonCode: string | null; detail: string | null; [other: string]: unknown }

/** GET /decisions/:id/comparables `comparables`: a union taken from packages/decision/src/comparables.ts and exercised through the real route. `patterns` are reference STRINGS, not objects. */
export const COMPARABLES_NOT_AVAILABLE_REASONS = ["NO_RESEARCH_PACKAGE", "NO_PATTERN_REPORT", "PATTERN_AGENT_INCOMPLETE", "NO_PATTERN_REFERENCE"] as const;
export type ComparablesView =
  | { state: "AVAILABLE"; version: string; verdict: string; patterns: string[]; summary: string; note: string }
  | { state: "NOT_AVAILABLE"; version: string; reason: (typeof COMPARABLES_NOT_AVAILABLE_REASONS)[number]; detail: string; patterns: [] };
export type { IsoTimestamp };
