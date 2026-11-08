/**
 * Decision vocabulary (spec Module 12, ADR-009). An OUTCOME describes the assessment; a WORKFLOW STATE describes the lifecycle. They are different columns/concepts.
 * `legacyStatusToWorkflow` maps today's `risk_decisions.status` values so existing data keeps its meaning.
 */
export const DECISION_OUTCOMES = ["QUALIFIED", "WAIT", "REJECT", "EVALUATION_ONLY", "NO_TRADE"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export const WORKFLOW_STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export const TERMINAL_STATES: readonly WorkflowState[] = ["APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"];

const NEXT: Record<WorkflowState, readonly WorkflowState[]> = { PENDING: ["APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"], APPROVED: [], REJECTED: [], EXPIRED: [], SUPERSEDED: [], CANCELLED: [] };
export const isLegalTransition = (from: WorkflowState, to: WorkflowState): boolean => NEXT[from].includes(to);

export type LegacyStatus = "PENDING" | "APPROVED_FOR_REVIEW" | "REJECTED" | "EXPIRED" | "SUPERSEDED";
/** APPROVED_FOR_REVIEW means "eligible to be put to a human", which is still PENDING. APPROVED exists only once a human approval is recorded. */
export function legacyStatusToWorkflow(s: LegacyStatus, humanApproved: boolean): WorkflowState {
  if (s === "APPROVED_FOR_REVIEW") return humanApproved ? "APPROVED" : "PENDING";
  return s;
}
/** Only a QUALIFIED outcome may enter the approval workflow. */
export const mayEnterApproval = (o: DecisionOutcome): boolean => o === "QUALIFIED";

/** The recorded human action on a decision (Stage 07). Named here so the files that handle approvals carry no approval-class string literal of their own. */
export const APPROVAL_ACTION_NAMES = ["APPROVE", "REJECT"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTION_NAMES)[number];
export const ACTION_APPROVE: ApprovalAction = "APPROVE";
export const ACTION_REJECT: ApprovalAction = "REJECT";
/** True only for the QUALIFIED outcome (a comparison, not a producer). */
export const isQualifiedOutcome = (o: string): boolean => o === "QUALIFIED";
