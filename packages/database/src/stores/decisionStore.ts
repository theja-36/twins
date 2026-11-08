import { sql } from "drizzle-orm";
import type { ApprovalAction } from "@twins/types";
import type { Db } from "../client";
import { withUser } from "../withUser";

/**
 * Persistence for decisions and approvals (Stage 07). The runtime role cannot write user_decisions directly: every change goes through the SECURITY DEFINER doors of migration 0038, each of which acts only for the
 * user bound to the transaction (withUser). Reads are plain selects under row-level security.
 */
type X = Pick<Db, "execute">;
const x = (tx: unknown): X => tx as X;
export interface NewDecision {
  accountId: string; candidateId: string; outcome: string; confidenceAssessmentId: string | null; riskAssessmentId: string | null; simulationId: string | null; researchPackageId: string | null;
  explanation: unknown; stopLossValidation: unknown; permittedSize: unknown; evidenceRefs: readonly string[]; versions: Record<string, string>; validUntil: Date; supersedesId: string | null; actor: string; reason: string | null;
}
export async function createDecision(db: Pick<Db, "transaction">, userId: string, d: NewDecision): Promise<string> {
  const p = { user_id: userId, account_id: d.accountId, candidate_id: d.candidateId, outcome: d.outcome, confidence_assessment_id: d.confidenceAssessmentId, risk_assessment_id: d.riskAssessmentId, simulation_id: d.simulationId, research_package_id: d.researchPackageId, explanation: d.explanation, stop_loss_validation: d.stopLossValidation, permitted_size: d.permittedSize, evidence_refs: d.evidenceRefs, versions: d.versions, valid_until: d.validUntil.toISOString(), supersedes_id: d.supersedesId, actor: d.actor, reason: d.reason };
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select twins_create_user_decision(${JSON.stringify(p)}::jsonb) as id`); return (r.rows[0] as { id: string }).id; });
}
export async function endDecision(db: Pick<Db, "transaction">, userId: string, decisionId: string, to: "EXPIRED" | "SUPERSEDED" | "CANCELLED", actor: string, reason: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select twins_end_user_decision(${decisionId}::uuid, ${to}, ${actor}, ${reason}) as ok`); return (r.rows[0] as { ok: boolean }).ok; });
}
export async function invalidateDecision(db: Pick<Db, "transaction">, userId: string, decisionId: string, code: string, detail: unknown, actor: string): Promise<"CANCELLED" | "INVALIDATED" | "NOT_FOUND" | "UNCHANGED"> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select twins_invalidate_decision(${decisionId}::uuid, ${code}, ${JSON.stringify(detail)}::jsonb, ${actor}) as s`); return (r.rows[0] as { s: "CANCELLED" | "INVALIDATED" | "NOT_FOUND" | "UNCHANGED" }).s; });
}
export async function recordDecisionApproval(db: Pick<Db, "transaction">, userId: string, a: { decisionId: string; action: ApprovalAction; revalidation: unknown; idempotencyKey: string; reason: string | null }): Promise<ApprovalAction> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select twins_record_decision_approval(${a.decisionId}::uuid, ${a.action}, ${JSON.stringify(a.revalidation)}::jsonb, ${a.idempotencyKey}, ${a.reason}) as a`); return (r.rows[0] as { a: ApprovalAction }).a; });
}
export interface StoredDecision {
  id: string; userId: string; accountId: string; candidateId: string; outcome: string; workflowState: string; confidenceAssessmentId: string | null; riskAssessmentId: string | null; simulationId: string | null; researchPackageId: string | null;
  explanation: unknown; stopLossValidation: unknown; permittedSize: { lots: number; quantity: number; maxLossAtStop: string; grossExposure: string } | null; evidenceRefs: string[]; versions: Record<string, string>;
  validFrom: Date; validUntil: Date; supersedesId: string | null; createdAt: Date; invalidated: { reasonCode: string; at: Date } | null;
}
const COLS = sql`d.id, d.user_id, d.account_id, d.candidate_id, d.outcome, d.workflow_state, d.confidence_assessment_id, d.risk_assessment_id, d.simulation_id, d.research_package_id, d.explanation, d.stop_loss_validation, d.permitted_size, d.evidence_refs, d.versions, d.valid_from, d.valid_until, d.supersedes_id, d.created_at, i.reason_code as inv_code, i.at as inv_at`;
const fromRow = (r: Record<string, unknown>): StoredDecision => ({
  id: r["id"] as string, userId: r["user_id"] as string, accountId: r["account_id"] as string, candidateId: r["candidate_id"] as string, outcome: r["outcome"] as string, workflowState: r["workflow_state"] as string,
  confidenceAssessmentId: (r["confidence_assessment_id"] ?? null) as string | null, riskAssessmentId: (r["risk_assessment_id"] ?? null) as string | null, simulationId: (r["simulation_id"] ?? null) as string | null, researchPackageId: (r["research_package_id"] ?? null) as string | null,
  explanation: r["explanation"], stopLossValidation: r["stop_loss_validation"] ?? null, permittedSize: (r["permitted_size"] ?? null) as StoredDecision["permittedSize"], evidenceRefs: (r["evidence_refs"] ?? []) as string[], versions: (r["versions"] ?? {}) as Record<string, string>,
  validFrom: new Date(r["valid_from"] as string), validUntil: new Date(r["valid_until"] as string), supersedesId: (r["supersedes_id"] ?? null) as string | null, createdAt: new Date(r["created_at"] as string),
  invalidated: r["inv_code"] ? { reasonCode: r["inv_code"] as string, at: new Date(r["inv_at"] as string) } : null,
});
export async function getDecision(db: Pick<Db, "transaction">, userId: string, id: string): Promise<StoredDecision | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select ${COLS} from user_decisions d left join decision_invalidations i on i.decision_id = d.id where d.user_id = ${userId}::uuid and d.id = ${id}::uuid`); return r.rows[0] ? fromRow(r.rows[0] as Record<string, unknown>) : null; });
}
export async function listDecisions(db: Pick<Db, "transaction">, userId: string, o: { accountId?: string; candidateId?: string; states?: readonly string[]; limit: number }): Promise<StoredDecision[]> {
  return withUser(db, userId, async (tx) => {
    const acc = o.accountId ? sql`and d.account_id = ${o.accountId}::uuid` : sql``, cand = o.candidateId ? sql`and d.candidate_id = ${o.candidateId}::uuid` : sql``;
    const st = o.states?.length ? sql`and d.workflow_state in (${sql.join(o.states.map((s) => sql`${s}`), sql`, `)})` : sql``;
    const r = await x(tx).execute(sql`select ${COLS} from user_decisions d left join decision_invalidations i on i.decision_id = d.id where d.user_id = ${userId}::uuid ${acc} ${cand} ${st} order by d.created_at desc, d.id limit ${Math.min(Math.max(o.limit, 1), 200)}`);
    return r.rows.map((q) => fromRow(q as Record<string, unknown>));
  });
}
export async function listDecisionEvents(db: Pick<Db, "transaction">, userId: string, decisionId: string): Promise<Array<{ fromState: string | null; toState: string; actor: string; reason: string | null; at: Date }>> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select from_state, to_state, actor, reason, at from user_decision_events where user_id = ${userId}::uuid and decision_id = ${decisionId}::uuid order by at, id`); return r.rows.map((q) => { const w = q as Record<string, unknown>; return { fromState: (w["from_state"] ?? null) as string | null, toState: w["to_state"] as string, actor: w["actor"] as string, reason: (w["reason"] ?? null) as string | null, at: new Date(w["at"] as string) }; }); });
}
export async function hasPaperPermission(db: Pick<Db, "transaction">, userId: string, accountId: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select 1 from user_execution_permissions where user_id = ${userId}::uuid and account_id = ${accountId}::uuid and mode = 'PAPER' and enabled limit 1`); return r.rows.length > 0; });
}
export async function getApproval(db: Pick<Db, "transaction">, userId: string, decisionId: string): Promise<{ action: string; revalidation: unknown; createdAt: Date; approverUserId: string } | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select action, revalidation, created_at, approver_user_id from decision_approvals where user_id = ${userId}::uuid and decision_id = ${decisionId}::uuid`); const w = r.rows[0] as Record<string, unknown> | undefined; return w ? { action: w["action"] as string, revalidation: w["revalidation"], createdAt: new Date(w["created_at"] as string), approverUserId: w["approver_user_id"] as string } : null; });
}
