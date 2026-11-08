import { endDecision, getDecision, invalidateDecision, recordDecisionApproval, type StoredDecision } from "@twins/database";
import { ACTION_APPROVE, ACTION_REJECT, mayEnterApproval, type ApprovalAction, type DecisionOutcome } from "@twins/types";
import type { EvaluationDeps } from "@twins/planning";
import { revalidateDecision, type Revalidation } from "./revalidate";

/**
 * Human approval (Module 13A). The owner approves or rejects a QUALIFIED decision. The approval is recorded ONLY by the database door (twins_record_decision_approval), which re-checks ownership, PAPER permission, the validity
 * window and the outcome; and this service first revalidates the decision with fresh data. An approval can therefore never override a failed risk evaluation, an invalid stop-loss or an expired decision.
 * No confidence score, agent verdict or AI output appears anywhere on this path.
 */
export class ApprovalError extends Error { constructor(readonly code: "NOT_FOUND" | "NOT_PENDING" | "NOT_QUALIFIED" | "EXPIRED" | "REVALIDATION_FAILED" | "ALREADY_ACTIONED" | "NOT_PERMITTED", m: string, readonly revalidation?: Revalidation) { super(m); this.name = "ApprovalError"; } }
export interface ApprovalCard {
  contractVersion: "approval-card-v1"; decisionId: string; candidateId: string; title: string; lines: string[]; permittedSize: StoredDecision["permittedSize"]; stopLoss: number | null; targets: number[]; validUntil: string;
  actions: readonly ApprovalAction[]; mode: "PAPER"; notice: string; evidenceRefs: string[];
}
export interface ApprovalNotification { kind: "APPROVAL_REQUEST"; userId: string; accountId: string; decisionId: string; dedupeKey: string; card: ApprovalCard }
/** The card shown to the owner: what is proposed, the exact permitted size, the stop and targets, when it expires, that it is a PAPER trade, and that approving is not a profit claim. */
export function buildApprovalCard(d: StoredDecision, c: { underlying: string; side: "BUY" | "SELL"; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[] }): ApprovalCard {
  const entry = c.entryLow !== null && c.entryHigh !== null ? (c.entryLow + c.entryHigh) / 2 : c.entryLow ?? c.entryHigh;
  const ex = d.explanation as { headline?: string; supporting?: string[]; missing?: string[]; riskRestrictions?: string[]; sizeRestriction?: string | null; expiry?: string } | null;
  return {
    contractVersion: "approval-card-v1", decisionId: d.id, candidateId: d.candidateId, title: `${c.side} ${c.underlying} (PAPER)`, permittedSize: d.permittedSize, stopLoss: c.stopLoss, targets: c.targets, validUntil: d.validUntil.toISOString(), actions: [ACTION_APPROVE, ACTION_REJECT], mode: "PAPER", evidenceRefs: d.evidenceRefs,
    lines: [ex?.headline ?? "", `entry ${entry ?? "n/a"}, stop ${c.stopLoss ?? "n/a"}, targets ${c.targets.join(", ") || "n/a"}`, ...(d.permittedSize ? [`size ${d.permittedSize.lots} lot(s) / ${d.permittedSize.quantity} units, maximum loss at the stop ${d.permittedSize.maxLossAtStop}`] : []), ...(ex?.riskRestrictions ?? []), ...(ex?.sizeRestriction ? [ex.sizeRestriction] : []), ...(ex?.missing?.length ? [`missing: ${ex.missing.join("; ")}`] : []), ex?.expiry ?? ""].filter(Boolean),
    notice: "Simulated paper trade. Approval records your decision to paper-trade; it does not claim any expected profit and does not override risk checks, which are repeated before execution.",
  };
}
export const approvalNotification = (d: StoredDecision, card: ApprovalCard): ApprovalNotification => ({ kind: "APPROVAL_REQUEST", userId: d.userId, accountId: d.accountId, decisionId: d.id, dedupeKey: `approval-request:${d.id}`, card });

async function load(d: EvaluationDeps, userId: string, decisionId: string): Promise<StoredDecision> {
  const dec = await getDecision(d.db, userId, decisionId);
  if (!dec) throw new ApprovalError("NOT_FOUND", "no such decision for this user");
  return dec;
}
export async function approveDecision(d: EvaluationDeps, o: { userId: string; decisionId: string; idempotencyKey: string; reason?: string }): Promise<{ status: "APPROVED"; revalidation: Revalidation }> {
  const dec = await load(d, o.userId, o.decisionId), now = (d.now ?? (() => new Date()))();
  if (!mayEnterApproval(dec.outcome as DecisionOutcome)) throw new ApprovalError("NOT_QUALIFIED", `a ${dec.outcome} decision cannot be approved`);
  if (dec.workflowState !== "PENDING") throw new ApprovalError(dec.workflowState === "APPROVED" || dec.workflowState === "REJECTED" ? "ALREADY_ACTIONED" : "NOT_PENDING", `the decision is ${dec.workflowState}`);
  if (now.getTime() > dec.validUntil.getTime()) { await endDecision(d.db, o.userId, dec.id, "EXPIRED", "approval-service", "expired before approval"); throw new ApprovalError("EXPIRED", "the decision has expired"); }
  const rv = await revalidateDecision(d, { decision: dec });
  if (!rv.passed) { await invalidateDecision(d.db, o.userId, dec.id, "REVALIDATION_FAILED", { failed: rv.checks.filter((c) => !c.ok) }, "approval-service"); throw new ApprovalError("REVALIDATION_FAILED", `revalidation failed: ${rv.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`, rv); }
  try { await recordDecisionApproval(d.db, o.userId, { decisionId: dec.id, action: ACTION_APPROVE, revalidation: rv, idempotencyKey: o.idempotencyKey, reason: o.reason ?? null }); }
  catch (e) { throw mapDbError(e); }
  return { status: "APPROVED", revalidation: rv };
}
export async function rejectDecision(d: EvaluationDeps, o: { userId: string; decisionId: string; idempotencyKey: string; reason?: string }): Promise<{ status: "REJECTED" }> {
  const dec = await load(d, o.userId, o.decisionId);
  if (dec.workflowState !== "PENDING") throw new ApprovalError(dec.workflowState === "APPROVED" || dec.workflowState === "REJECTED" ? "ALREADY_ACTIONED" : "NOT_PENDING", `the decision is ${dec.workflowState}`);
  const now = (d.now ?? (() => new Date()))();
  try { await recordDecisionApproval(d.db, o.userId, { decisionId: dec.id, action: ACTION_REJECT, revalidation: { passed: false, at: now.toISOString(), checks: [], note: "rejected by the owner" }, idempotencyKey: o.idempotencyKey, reason: o.reason ?? "rejected by the owner" }); }
  catch (e) { throw mapDbError(e); }
  return { status: "REJECTED" };
}
/** Cancels a pending decision, or invalidates an approved one (an approved decision is final; invalidation withdraws its right to open new entries). */
export async function cancelDecision(d: EvaluationDeps, o: { userId: string; decisionId: string; reason: string; actor?: string }): Promise<"CANCELLED" | "INVALIDATED" | "NOT_FOUND" | "UNCHANGED"> {
  return invalidateDecision(d.db, o.userId, o.decisionId, "CANCELLED_BY_OWNER", { reason: o.reason }, o.actor ?? `user:${o.userId}`);
}
function mapDbError(e: unknown): ApprovalError | unknown {
  const msg = String((e as { cause?: { message?: string }; message?: string })?.cause?.message ?? (e as Error)?.message ?? "");
  if (/already been actioned/.test(msg)) return new ApprovalError("ALREADY_ACTIONED", "this decision has already been actioned");
  if (/has not enabled PAPER/.test(msg)) return new ApprovalError("NOT_PERMITTED", "the user has not enabled PAPER execution for this account");
  if (/expired/.test(msg)) return new ApprovalError("EXPIRED", "the decision has expired");
  if (/not PENDING/.test(msg)) return new ApprovalError("NOT_PENDING", "the decision is not pending");
  return e;
}
