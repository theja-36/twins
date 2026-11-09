import { createDecision, endDecision, getCandidate, getLatestEvaluationBundle, getResearchPackageById, hasPaperPermission, invalidateDecision, listActiveAccounts, listCandidates, listDecisions, type StoredCandidate } from "@twins/database";
import type { ResearchPackage } from "@twins/agents";
import type { RiskDecision, SizingResultV2, EvaluationDeps } from "@twins/planning";
import { isQualifiedOutcome } from "@twins/types";
import { decide, DEFAULT_DECISION_POLICY, type DecisionPolicy, type DecisionResult } from "./engine";
import { buildApprovalCard, approvalNotification, type ApprovalNotification } from "./approval";
import { revalidateDecision } from "./revalidate";

/** Decision settings. DISABLED by default; strict parsing. */
export interface DecisionConfig { enabled: boolean; policy: DecisionPolicy; batchLimit: number }
export const DEFAULT_DECISION_CONFIG: DecisionConfig = { enabled: false, policy: DEFAULT_DECISION_POLICY, batchLimit: 50 };
export function loadDecisionConfig(env: Record<string, string | undefined> = process.env): DecisionConfig {
  const b = env["TWINS_DECISIONS_ENABLED"];
  if (b !== undefined && b !== "" && b !== "true" && b !== "false") throw new Error('TWINS_DECISIONS_ENABLED must be exactly "true" or "false"');
  const num = (n: string, d: number, lo: number, hi: number, int: boolean): number => { const v = env[n]; if (v === undefined || v === "") return d; const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi || (int && !Number.isInteger(x))) throw new Error(`${n} must be ${int ? "an integer" : "a number"} between ${lo} and ${hi}`); return x; };
  const base = DEFAULT_DECISION_POLICY;
  return { enabled: b === "true", batchLimit: num("TWINS_DECISIONS_BATCH", 50, 1, 500, true), policy: { ...base, minConfidenceScore: num("TWINS_DECISION_MIN_STRENGTH", base.minConfidenceScore, 0, 100, false), minEvidenceCompleteness: num("TWINS_DECISION_MIN_COMPLETENESS", base.minEvidenceCompleteness, 0, 1, false), decisionTtlMinutes: num("TWINS_DECISION_TTL_MINUTES", base.decisionTtlMinutes, 1, 240, true) } };
}
const toDecisionCandidate = (c: StoredCandidate) => ({ id: c.id, source: c.source, state: c.state, underlying: c.underlying, exchange: c.exchange, strike: c.strike, optionType: c.optionType, expiry: c.expiry, side: c.side, entryLow: c.entryLow, entryHigh: c.entryHigh, stopLoss: c.stopLoss, targets: c.targets, dataSource: c.dataSource, expiresAt: c.expiresAt, setup: c.setup });
export interface DecisionCycleReport { skipped: "DISABLED" | null; examined: number; created: number; superseded: number; unchanged: number; expired: number; invalidated: number; outcomes: Record<string, number>; notifications: ApprovalNotification[]; failed: number }
export const emptyReport = (): DecisionCycleReport => ({ skipped: null, examined: 0, created: 0, superseded: 0, unchanged: 0, expired: 0, invalidated: 0, outcomes: {}, notifications: [], failed: 0 });

/**
 * One decision cycle: (1) expire PENDING decisions past their window, (2) revalidate APPROVED decisions that have not opened a position and invalidate those whose basis failed, (3) for every READY candidate x account that
 * has a stored evaluation, produce a decision from the STORED evidence (superseding an older PENDING one when the evidence changed). QUALIFIED decisions yield an approval notification for the caller to deliver.
 */
export async function runDecisionCycle(d: EvaluationDeps & { config: DecisionConfig; scope?: { underlyings: readonly string[] } }): Promise<DecisionCycleReport> {
  const r = emptyReport();
  if (!d.config.enabled) return { ...r, skipped: "DISABLED" };
  const now = (d.now ?? (() => new Date()))();
  const accounts = await listActiveAccounts(d.db);
  for (const a of accounts) {
    try {
      // (1) + (2) housekeeping
      for (const pd of await listDecisions(d.db, a.userId, { accountId: a.accountId, states: ["PENDING"], limit: 100 })) if (pd.validUntil.getTime() <= now.getTime() && (await endDecision(d.db, a.userId, pd.id, "EXPIRED", "decision-cycle", "validity window passed"))) r.expired++;
      for (const ad of await listDecisions(d.db, a.userId, { accountId: a.accountId, states: ["APPROVED"], limit: 100 })) {
        if (ad.invalidated) continue;
        const rv = await revalidateDecision(d, { decision: ad, requireWindow: false });
        if (!rv.passed && (await invalidateDecision(d.db, a.userId, ad.id, "REVALIDATION_FAILED", { failed: rv.checks.filter((c) => !c.ok) }, "decision-cycle")) === "INVALIDATED") r.invalidated++;
      }
      // (3) new decisions from stored evidence
      const cands = await listCandidates(d.db, { states: ["READY_FOR_DECISION"], limit: d.config.batchLimit, ...(d.scope ? { scope: d.scope } : {}) });
      const paperEnabled = await hasPaperPermission(d.db, a.userId, a.accountId);
      for (const c of cands) {
        r.examined++;
        const bundle = await getLatestEvaluationBundle(d.db, a.userId, a.accountId, c.id);
        if (!bundle) continue;
        const live = await getCandidate(d.db, c.id);
        if (!live) continue;
        const existing = (await listDecisions(d.db, a.userId, { accountId: a.accountId, candidateId: c.id, states: ["PENDING", "APPROVED"], limit: 5 }))[0] ?? null;
        if (existing && existing.riskAssessmentId === bundle.riskAssessmentId && existing.validUntil.getTime() > now.getTime()) { r.unchanged++; continue; }
        // The decision is a function of the stored evaluation: it uses the research package the risk assessment and confidence used (by id), never a newer version stored since (G-41). A newer version makes planning re-evaluate (its dedupe compares package ids), and the next cycle then decides on that new evaluation.
        const stored = bundle.researchPackageId ? await getResearchPackageById(d.db, bundle.researchPackageId) : null;
        const res = bundle.result as { risk: RiskDecision; sizing: SizingResultV2 };
        const comp = (bundle.confidence?.components ?? {}) as { completeness?: number; caps?: Array<{ code: string }> };
        const result: DecisionResult = decide({ now, candidate: toDecisionCandidate(live), research: (stored?.agentResults ?? null) as ResearchPackage | null, researchPackageId: stored?.id ?? null,
          confidence: bundle.confidence ? { id: bundle.confidence.id, score: bundle.confidence.score, calibrationStatus: bundle.confidence.calibrationStatus, completeness: comp.completeness ?? null, missing: (bundle.confidence.missing ?? []) as string[], caps: (comp.caps ?? []).map((x) => x.code) } : null,
          risk: res.risk, riskAssessmentId: bundle.riskAssessmentId, sizing: res.sizing, simulationId: bundle.simulationId, paperEnabled, policy: d.config.policy });
        const supersedes = existing && existing.workflowState === "PENDING" ? existing.id : null;
        if (existing && existing.workflowState === "APPROVED") { r.unchanged++; continue; } // an approved decision is never replaced; it is revalidated above
        await createDecision(d.db, a.userId, { accountId: a.accountId, candidateId: c.id, outcome: result.outcome, confidenceAssessmentId: result.provenance.confidenceAssessmentId, riskAssessmentId: bundle.riskAssessmentId, simulationId: bundle.simulationId, researchPackageId: stored?.id ?? null,
          explanation: { ...result.explanation, reasons: result.reasons, restrictions: result.restrictions, whatWouldChange: result.whatWouldChange, provenance: result.provenance }, stopLossValidation: result.stopLoss.validation, permittedSize: result.permittedSize, evidenceRefs: result.evidenceRefs, versions: result.versions, validUntil: result.validUntil, supersedesId: supersedes, actor: "decision-engine", reason: result.explanation.headline });
        r.created++; if (supersedes) r.superseded++; r.outcomes[result.outcome] = (r.outcomes[result.outcome] ?? 0) + 1;
        if (isQualifiedOutcome(result.outcome)) {
          const stored2 = (await listDecisions(d.db, a.userId, { accountId: a.accountId, candidateId: c.id, states: ["PENDING"], limit: 1 }))[0];
          if (stored2) r.notifications.push(approvalNotification(stored2, buildApprovalCard(stored2, { underlying: live.underlying, side: live.side, entryLow: live.entryLow, entryHigh: live.entryHigh, stopLoss: live.stopLoss, targets: live.targets })));
        }
      }
    } catch (e) { r.failed++; d.log?.("decision.cycle_failed", { errorName: e instanceof Error ? e.name : "Error" }); }
  }
  return r;
}
