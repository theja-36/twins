import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { evaluateSafety } from "@twins/runtime-state";
import { getCircuitBreakerStatus, type BreakerOptions, type CircuitBreakerStatus } from "../breakers/record";
import { loadExpiryConfig, type ExpiryConfig } from "../expiry/config";
import { databaseNow } from "../expiry/record";
import { intelligenceOf, isIntelligenceValid } from "../intelligence/record";
import { getRiskDecision, RiskDecisionError, type RiskDecisionRecord } from "../riskDecisions";
import { loadResearchEligibilityConfig, researchEligibilityReasons, type ResearchEligibilityConfig } from "./researchEligibility";

/**
 * Approval eligibility (Stage 3 / Task 6). A risk decision may be PRESENTED for approval only when ALL of these hold at this moment: current (un-superseded)
 * APPROVED_FOR_REVIEW version; inside its validity window; the latest stop-loss validation is the cited one and VALID; sizing SUCCEEDED; the portfolio limits
 * PASSED; the market gates PASSED; valid source intelligence is recorded (trust A / B / C and a known confidence tier); no loss circuit breaker is open; the kill switch is off. Every unmet condition is listed with a fixed machine-readable
 * code. The same rules are enforced AGAIN inside the database at the instant an approval is recorded (twins_record_risk_approval), so a card shown a while ago
 * can never approve from stale state. This read-only assessment writes nothing.
 */
export const ELIGIBILITY_REASONS = [
  "decision_not_found", "decision_superseded", "decision_not_approved_for_review", "decision_expired", "stop_loss_not_valid", "sizing_missing", "portfolio_not_passed", "market_not_passed",
  "circuit_breaker_open", "kill_switch_active", "state_unavailable", "breaker_state_unavailable", "source_intelligence_not_valid",
  "research_assessment_blocked", "research_assessment_incomplete", "research_assessment_adverse", "research_assessment_caution", "research_assessment_neutral", "research_assessment_missing", "research_assessment_unavailable",
  "research_reference_missing", "research_assessment_changed", "research_adverse_not_superseded", "research_blocked_not_superseded",
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

type Snap = { sizing?: { status?: string }; portfolio?: { outcome?: string; capital?: unknown }; market?: { outcome?: string } } | null;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export interface EligibilityOptions extends BreakerOptions {
  now?: Date;
  capital?: number | null;
  /** Research-assessment re-check policy (Stage 5 / Task 8); defaults to the environment. */
  research?: ResearchEligibilityConfig;
}
export interface EligibilityAssessment {
  eligible: boolean;
  reasons: EligibilityReason[];
  decision: RiskDecisionRecord | undefined;
  /** When the decision (and a card for it) stops being valid. */
  validUntil: Date | null;
  breaker: CircuitBreakerStatus | null;
  assessedAt: Date;
}

export function validUntilOf(d: Pick<RiskDecisionRecord, "createdAt">, expiry: ExpiryConfig): Date {
  return new Date(d.createdAt.getTime() + expiry.approvedForReviewMinutes * 60_000);
}

export async function assessApprovalEligibility(db: Db, decisionId: string, opts: EligibilityOptions = {}): Promise<EligibilityAssessment> {
  const expiry = opts.expiry ?? loadExpiryConfig();
  const assessedAt = opts.now ?? (await databaseNow(db));
  const decision = await getRiskDecision(db, decisionId);
  if (!decision) return { eligible: false, reasons: ["decision_not_found"], decision: undefined, validUntil: null, breaker: null, assessedAt };
  const reasons: EligibilityReason[] = [];
  const out = decision.outputSnapshot as Snap;
  if (decision.supersededById) reasons.push("decision_superseded");
  if (decision.status !== "APPROVED_FOR_REVIEW") reasons.push("decision_not_approved_for_review");
  const validUntil = validUntilOf(decision, expiry);
  if (assessedAt.getTime() >= validUntil.getTime()) reasons.push("decision_expired");

  const subjectWhere = decision.signalId ? eq(schema.stopLossValidations.signalId, decision.signalId) : eq(schema.stopLossValidations.optionsClaimId, decision.optionsClaimId as string);
  const [latest] = await db.select().from(schema.stopLossValidations).where(subjectWhere).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  if (!latest || latest.id !== decision.stopLossValidationId || latest.result !== "VALID") reasons.push("stop_loss_not_valid");
  if (out?.sizing?.status !== "SIZED" || !((num(decision.plannedQuantity) ?? 0) > 0) || !((num(decision.plannedMaxLossAmount) ?? 0) > 0)) reasons.push("sizing_missing");
  if (out?.portfolio?.outcome !== "APPROVED_FOR_REVIEW") reasons.push("portfolio_not_passed");
  if (out?.market?.outcome !== "PASSED") reasons.push("market_not_passed");
  // Stage 4 / Task 5: valid source intelligence is mandatory. UNKNOWN / D trust, UNKNOWN confidence or no recorded intelligence can never be approval-eligible.
  if (!isIntelligenceValid(intelligenceOf(decision))) reasons.push("source_intelligence_not_valid");

  // Stage 5 / Task 8: the latest research assessment of the decision's lineage must not be BLOCKED, INCOMPLETE or ADVERSE (and must exist when the engine is enabled); see researchEligibility.ts
  for (const code of await researchEligibilityReasons(db, decision, opts.research ?? loadResearchEligibilityConfig())) reasons.push(code);

  // runtime safety: an unreadable state fails closed
  const refusal = await evaluateSafety("kill_switch_inactive", "risk_approval.eligibility").catch(() => ({ reason: "state_unavailable" }) as const);
  if (refusal) reasons.push(refusal.reason === "kill_switch_active" ? "kill_switch_active" : "state_unavailable");

  // circuit breakers (read-only here): a block or an unreadable state fails closed
  let breaker: CircuitBreakerStatus | null = null;
  const capital = opts.capital === undefined ? num(out?.portfolio?.capital) : opts.capital;
  try {
    if (capital === null || !(capital > 0)) throw new RiskDecisionError("invalid_input", "the capital the decision was evaluated with is unknown");
    breaker = await getCircuitBreakerStatus(db, { capital, asOf: assessedAt, ...(opts.breakers ? { breakers: opts.breakers } : {}), expiry });
    if (breaker.blocked) reasons.push("circuit_breaker_open");
  } catch {
    reasons.push("breaker_state_unavailable");
  }
  return { eligible: reasons.length === 0, reasons, decision, validUntil, breaker, assessedAt };
}
