import type { ResearchAssessment } from "../config";

/**
 * The research STATUS model (Stage 04). The platform already stores a candidate's lifecycle state and each research package's assessment; this maps them to the specification's eight words WITHOUT a new stored state, so
 * nothing persisted changes and nothing can drift: the status is always DERIVED from what is stored.
 *   PENDING    candidate NEW (waiting for the dispatcher)             RUNNING   candidate IN_RESEARCH (claimed, lease held)
 *   COMPLETED  a package exists and no required agent is missing        PARTIAL   a package exists but is RESEARCH_INCOMPLETE (a valid partial package, never a pass)
 *   FAILED     the dispatcher withdrew the candidate after exhausting its research attempts with no package    EXPIRED   the candidate expired        SUPERSEDED  a newer candidate replaced it        CANCELLED  withdrawn or invalidated
 */
export const RESEARCH_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];
export interface ResearchStatusInput { candidateState: string; hasPackage: boolean; assessment?: ResearchAssessment | null; attempts?: number | null; maxAttempts?: number | null }
/** null for a candidate state this model does not know: an unknown state is never guessed into a status. */
export function deriveResearchStatus(i: ResearchStatusInput): ResearchStatus | null {
  switch (i.candidateState) {
    case "EXPIRED": return "EXPIRED";
    case "SUPERSEDED": return "SUPERSEDED";
    // the dispatcher WITHDRAWS a candidate whose research attempts are exhausted without a package: that is FAILED, not a cancellation
    case "WITHDRAWN": return !i.hasPackage && i.attempts != null && i.maxAttempts != null && i.attempts >= i.maxAttempts ? "FAILED" : "CANCELLED";
    case "INVALIDATED": return "CANCELLED";
    case "NEW": return i.hasPackage ? (i.assessment === "RESEARCH_INCOMPLETE" ? "PARTIAL" : "COMPLETED") : "PENDING";
    case "IN_RESEARCH": return "RUNNING";
    case "READY_FOR_DECISION": return i.hasPackage ? (i.assessment === "RESEARCH_INCOMPLETE" ? "PARTIAL" : "COMPLETED") : null;
    default: return null;
  }
}
