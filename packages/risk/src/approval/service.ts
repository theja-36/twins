import { randomBytes, randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { evaluateSafety } from "@twins/runtime-state";
import { breakerGate } from "../breakers/record";
import { loadExpiryConfig } from "../expiry/config";
import { getRiskDecision, listRiskDecisions, refuseUnlessSafe, RiskDecisionError, type RiskDecisionRecord } from "../riskDecisions";
import { buildApprovalCardData, renderApprovalCard, type ApprovalCardData } from "./card";
import { loadResearchEligibilityConfig, researchEligibilityReasons, type ResearchEligibilityConfig } from "./researchEligibility";
import { assessApprovalEligibility, validUntilOf, type EligibilityAssessment, type EligibilityOptions } from "./eligibility";

/**
 * Risk approval service (Stage 3 / Task 6): create the approval card for an approval-eligible decision, record an APPROVE / REJECT, and read safe summaries.
 * An approval records a decision about ONE decision version; it creates no order, fill, position or broker call. The runtime role cannot INSERT into
 * `risk_approvals` at all: approvals are written only by the database function `twins_record_risk_approval`, which re-checks eligibility at that instant.
 */
export const APPROVAL_ACTOR = "service:risk-approval";

export interface CreatedCard { cardId: string; created: boolean; decisionId: string; decisionVersion: number; expiresAt: Date; cardSha256: string; data: ApprovalCardData }

/** Creates the approval card (idempotent per decision). Refuses - writing nothing - unless the decision is approval-eligible RIGHT NOW. */
export async function createApprovalCard(db: Db, decisionId: string, opts: EligibilityOptions = {}): Promise<CreatedCard> {
  await refuseUnlessSafe("risk_approval.card"); // runtime state, fail closed, before any read
  const expiry = opts.expiry ?? loadExpiryConfig();
  const a = await assessApprovalEligibility(db, decisionId, { ...opts, expiry });
  if (!a.eligible || !a.decision) throw new RiskDecisionError(a.reasons[0] === "decision_not_found" ? "not_found" : "not_approval_eligible", `the decision is not approval-eligible: ${a.reasons.join(", ")}`);
  const d = a.decision;
  // record the breaker state at the enforcement point itself (the assessment above only reads it)
  const capital = a.breaker?.capital as number;
  const gate = await breakerGate(db, capital, { asOf: a.assessedAt, expiry });
  if (gate.blocked) throw new RiskDecisionError("not_approval_eligible", "the decision is not approval-eligible: circuit_breaker_open");
  const data = buildApprovalCardData(d, { breaker: gate, validUntil: a.validUntil as Date });
  const rendered = renderApprovalCard(data);
  const id = randomUUID();
  const inserted = await db.insert(schema.riskApprovalCards).values({
    id, riskDecisionId: d.id, decisionVersion: d.decisionVersion, nonce: randomBytes(16).toString("hex"), cardText: rendered.text, cardContentSha256: rendered.sha256, expiresAt: a.validUntil as Date, createdBy: APPROVAL_ACTOR,
  }).onConflictDoNothing({ target: schema.riskApprovalCards.riskDecisionId }).returning({ id: schema.riskApprovalCards.id });
  if (inserted[0]) return { cardId: id, created: true, decisionId: d.id, decisionVersion: d.decisionVersion, expiresAt: a.validUntil as Date, cardSha256: rendered.sha256, data };
  const [existing] = await db.select().from(schema.riskApprovalCards).where(eq(schema.riskApprovalCards.riskDecisionId, d.id));
  if (!existing) throw new RiskDecisionError("store_failure", "the card conflicted but the canonical row was not found");
  return { cardId: existing.id, created: false, decisionId: d.id, decisionVersion: existing.decisionVersion, expiresAt: existing.expiresAt, cardSha256: existing.cardContentSha256, data };
}

export type ApprovalRecordOutcome = { outcome: "recorded"; approvalId: string } | { outcome: "duplicate" } | { outcome: "refused"; reason: string };

/**
 * Records an APPROVE or REJECT through the database function (the single enforcement point). `actor` is `operator:<name>` (self-declared, like the other
 * operations paths; the API endpoint additionally requires the bearer token). A REJECT needs a reason. A duplicate is reported, never overwritten.
 */
export async function recordRiskApproval(db: Db, input: { decisionId: string; action: "APPROVE" | "REJECT"; actor: string; reason?: string; context?: Record<string, unknown>; expiry?: ReturnType<typeof loadExpiryConfig>; research?: ResearchEligibilityConfig }): Promise<ApprovalRecordOutcome> {
  if (input.action !== "APPROVE" && input.action !== "REJECT") throw new RiskDecisionError("invalid_input", "action must be APPROVE or REJECT");
  if (!/^operator:[A-Za-z0-9._-]{1,64}$/.test(input.actor)) throw new RiskDecisionError("invalid_input", "actor must be operator:<name>");
  if (input.action === "REJECT" && !(input.reason ?? "").trim()) throw new RiskDecisionError("invalid_input", "a REJECT needs a reason");
  if ((input.reason ?? "").length > 500) throw new RiskDecisionError("invalid_input", "the reason may not exceed 500 characters");
  if (input.action === "APPROVE") {
    // fail closed on an unreadable runtime state before anything else (a REJECT is risk-reducing and does not need it)
    const refusal = await evaluateSafety("kill_switch_inactive", "risk_approval.record").catch(() => ({ reason: "state_unavailable" }) as const);
    if (refusal) return { outcome: "refused", reason: refusal.reason === "kill_switch_active" ? "kill_switch_active" : "state_unavailable" };
  }
  const decision = await getRiskDecision(db, input.decisionId);
  if (!decision) return { outcome: "refused", reason: "decision_not_found" };
  if (input.action === "APPROVE") {
    // Stage 5 / Task 8: an unacceptable (or, with the engine enabled, missing) research assessment refuses before the database function is even called; the function enforces the BLOCKED / INCOMPLETE / ADVERSE refusal again
    const research = await researchEligibilityReasons(db, decision, input.research ?? loadResearchEligibilityConfig());
    if (research[0]) return { outcome: "refused", reason: research[0] };
  }
  const validUntil = validUntilOf(decision, input.expiry ?? loadExpiryConfig());
  const context = JSON.stringify({ ...(input.context ?? {}), via: "api" });
  const r = await db.execute(sql`select twins_record_risk_approval(${input.decisionId}::uuid, null::uuid, ${input.action}, ${input.actor}, ${context}::jsonb, ${input.reason ?? null}, ${validUntil.toISOString()}::timestamptz) as outcome`);
  const outcome = String((r.rows[0] as { outcome: string }).outcome);
  if (outcome === "recorded") {
    const [row] = await db.select({ id: schema.riskApprovals.id }).from(schema.riskApprovals).where(eq(schema.riskApprovals.riskDecisionId, input.decisionId));
    return { outcome: "recorded", approvalId: row?.id as string };
  }
  if (outcome === "duplicate") return { outcome: "duplicate" };
  return { outcome: "refused", reason: outcome.replace(/^refused:/, "") };
}

// ── safe read models (no snapshots, no idempotency keys, no raw inputs) ──
export interface DecisionSummary {
  id: string; version: number; status: string; effectiveStatus: string; supersededById: string | null; subjectKind: "signal" | "options_claim"; market: string | null; instrumentType: string; symbol: string;
  expiry: string | null; strike: string | null; optionType: string | null; side: string | null; entryPrice: string | null; stopLoss: string | null; stopLossBasis: string | null; targets: string[];
  plannedQuantity: string | null; plannedNotional: string | null; plannedMaxLossAmount: string | null; plannedMaxLossPercent: string | null; riskReward: string | null; confidenceScore: string | null; sourceTrustTier: string | null;
  reasonCode: string; createdAt: string; createdBy: string;
}
export function summarizeDecision(d: RiskDecisionRecord): DecisionSummary {
  return {
    id: d.id, version: d.decisionVersion, status: d.status, effectiveStatus: d.effectiveStatus, supersededById: d.supersededById, subjectKind: d.signalId ? "signal" : "options_claim", market: d.market, instrumentType: d.instrumentType, symbol: d.symbol,
    expiry: d.expiry, strike: d.strike, optionType: d.optionType, side: d.side, entryPrice: d.entryPrice, stopLoss: d.stopLoss, stopLossBasis: d.stopLossBasis, targets: [d.target1, d.target2, d.target3].filter((x): x is string => x !== null),
    plannedQuantity: d.plannedQuantity, plannedNotional: d.plannedNotional, plannedMaxLossAmount: d.plannedMaxLossAmount, plannedMaxLossPercent: d.plannedMaxLossPercent, riskReward: d.plannedRiskRewardRatio, confidenceScore: d.confidenceScore,
    sourceTrustTier: d.sourceTrustTier, reasonCode: d.decisionReasonCode, createdAt: d.createdAt.toISOString(), createdBy: d.createdBy,
  };
}

export interface ApprovalSummary { id: string; riskDecisionId: string; decisionVersion: number; action: string; actorType: string; actorRef: string; reason: string | null; validUntil: string | null; createdAt: string }
const maskRef = (actor: string): { actorType: string; actorRef: string } => {
  const [type = "unknown", ref = ""] = actor.split(":");
  return { actorType: type, actorRef: ref.length > 4 ? `***${ref.slice(-4)}` : "***" }; // the approver's identity is never returned in full
};
export async function listRecentApprovals(db: Db, limit = 50): Promise<ApprovalSummary[]> {
  const rows = await db.select().from(schema.riskApprovals).orderBy(desc(schema.riskApprovals.createdAt), desc(schema.riskApprovals.id)).limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({ id: r.id, riskDecisionId: r.riskDecisionId, decisionVersion: r.decisionVersion, action: r.action, ...maskRef(r.actor), reason: r.reason, validUntil: r.validUntil ? r.validUntil.toISOString() : null, createdAt: r.createdAt.toISOString() }));
}
export async function listRecentDecisionSummaries(db: Db, limit = 50, status?: RiskDecisionRecord["status"]): Promise<DecisionSummary[]> {
  return (await listRiskDecisions(db, { limit, ...(status ? { status } : {}) })).map(summarizeDecision);
}

export interface SafeEligibility { eligible: boolean; reasons: string[]; validUntil: string | null; assessedAt: string; decision: DecisionSummary | null }
export const safeEligibility = (a: EligibilityAssessment): SafeEligibility => ({ eligible: a.eligible, reasons: a.reasons, validUntil: a.validUntil ? a.validUntil.toISOString() : null, assessedAt: a.assessedAt.toISOString(), decision: a.decision ? summarizeDecision(a.decision) : null });
