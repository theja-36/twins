import { evaluateSafety } from "@twins/runtime-state";
import { isQualifiedOutcome } from "@twins/types";
import { computeEvaluation, type EvaluationDeps } from "@twins/planning";
import { getCandidate, hasPaperPermission, type StoredDecision } from "@twins/database";
import { validateCandidateStop } from "./engine";

/**
 * Revalidation (Module 12/13): a fresh, current answer to "is this decision still sound?", computed by the SAME code that produced it (the mandatory stop-loss rule, the capital / risk / sizing evaluation) plus the candidate, the
 * decision window, the permission and the kill switch. It is called immediately before an approval and immediately before every execution. An approval never overrides a failed check here.
 */
export interface RevalidationCheck { name: string; ok: boolean; detail: string }
export interface Revalidation { passed: boolean; at: string; checks: RevalidationCheck[]; freshVerdict: string | null; freshLots: number | null; approvedLots: number | null }
export async function revalidateDecision(d: EvaluationDeps, o: { decision: StoredDecision; requireWindow?: boolean }): Promise<Revalidation> {
  const now = (d.now ?? (() => new Date()))(), dec = o.decision, checks: RevalidationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  add("decision_outcome", isQualifiedOutcome(dec.outcome), `outcome ${dec.outcome}`);
  add("decision_state", dec.workflowState === "PENDING" || dec.workflowState === "APPROVED", `state ${dec.workflowState}`);
  add("decision_not_invalidated", dec.invalidated === null, dec.invalidated ? `invalidated: ${dec.invalidated.reasonCode}` : "not invalidated");
  if (o.requireWindow !== false) add("decision_window", now.getTime() <= dec.validUntil.getTime() && now.getTime() >= dec.validFrom.getTime(), `valid until ${dec.validUntil.toISOString()}`);
  let freshVerdict: string | null = null, freshLots: number | null = null;
  const cand = await getCandidate(d.db, dec.candidateId);
  add("candidate_active", !!cand && ["NEW", "IN_RESEARCH", "READY_FOR_DECISION"].includes(cand.state) && cand.expiresAt.getTime() > now.getTime(), cand ? `candidate ${cand.state}` : "candidate missing");
  if (cand) {
    const stop = validateCandidateStop({ id: cand.id, source: cand.source, state: cand.state, underlying: cand.underlying, exchange: cand.exchange, strike: cand.strike, optionType: cand.optionType, expiry: cand.expiry, side: cand.side, entryLow: cand.entryLow, entryHigh: cand.entryHigh, stopLoss: cand.stopLoss, targets: cand.targets, dataSource: cand.dataSource, expiresAt: cand.expiresAt, setup: cand.setup });
    add("stop_loss_validation", stop.result === "VALID", `mandatory stop-loss validation ${stop.result}${stop.reasonCode ? ` (${stop.reasonCode})` : ""}`);
    let ev: Awaited<ReturnType<typeof computeEvaluation>> | null = null;
    try { ev = await computeEvaluation(d, { userId: dec.userId, accountId: dec.accountId, candidate: cand }); } catch { ev = null; }
    if (!ev || ev.status !== "COMPUTED") add("risk_evaluation", false, ev ? ev.reason : "the evaluation could not be computed");
    else {
      const { risk, sizing } = ev.computed; freshVerdict = risk.verdict; freshLots = sizing.status === "SIZED" ? sizing.lots : 0;
      add("risk_evaluation", risk.verdict !== "BLOCKED", `risk ${risk.verdict}${risk.verdict === "BLOCKED" ? `: ${risk.reasons.filter((r) => r.severity === "BLOCK").map((r) => r.code).join(", ")}` : ""}`);
      add("size_within_current_limits", sizing.status === "SIZED" && !!dec.permittedSize && sizing.lots >= dec.permittedSize.lots, `current permitted ${freshLots} lot(s) vs approved ${dec.permittedSize?.lots ?? "none"}`);
    }
  }
  let kill = "unreadable";
  try { const r = await evaluateSafety("intake", "decision.revalidate"); kill = r ? `refused: ${r.reason}` : ""; } catch { kill = "the safety state could not be read"; }
  add("kill_switch", kill === "", kill === "" ? "kill switch and intake control allow" : kill);
  let perm = false; try { perm = await hasPaperPermission(d.db, dec.userId, dec.accountId); } catch { perm = false; }
  add("paper_permission", perm, perm ? "PAPER execution enabled" : "PAPER execution is not enabled for this account");
  return { passed: checks.every((c) => c.ok), at: now.toISOString(), checks, freshVerdict, freshLots, approvedLots: dec.permittedSize?.lots ?? null };
}
