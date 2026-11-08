import { assertStopLossAllowsEligibility, validateStopLoss, STOP_LOSS_RULE_VERSION, type StopLossValidation } from "@twins/stop-loss";
import type { ResearchPackage } from "@twins/agents";
import type { RiskDecision, SizingResultV2 } from "@twins/planning";
import type { DecisionOutcome } from "@twins/types";

/**
 * The decision engine (Module 12). PURE and deterministic: evidence in, one of five outcomes out, with every reason, restriction and the condition that would change it.
 * Order matters and is fixed: NO_TRADE (the situation forbids trading now) > REJECT (the candidate fails a hard rule) > EVALUATION_ONLY (the inputs are not fit to trade on) > WAIT (not yet: something is missing or unresolved) > QUALIFIED.
 * SAFETY: the mandatory stop-loss rule (packages/stop-loss) runs here, always, from the candidate's own levels, and the producer's last statement before it returns is assertStopLossAllowsEligibility. If the full validation did not
 * come back VALID the outcome cannot be QUALIFIED. Confidence can only make the engine MORE conservative (a minimum strength); it never raises a size, overrides a risk restriction or substitutes for evidence. The size is the risk-checked
 * sizing, never anything derived from confidence. Fixture-backed data can never qualify.
 */
export const DECISION_ENGINE_VERSION = "decision-engine-v1";
export interface DecisionPolicy { minConfidenceScore: number; minEvidenceCompleteness: number; decisionTtlMinutes: number; acceptableResearch: readonly string[] }
export const DEFAULT_DECISION_POLICY: DecisionPolicy = { minConfidenceScore: 50, minEvidenceCompleteness: 0.6, decisionTtlMinutes: 15, acceptableResearch: ["RESEARCH_SUPPORTIVE", "RESEARCH_NEUTRAL"] };
export interface DecisionCandidate {
  id: string; source: "TELEGRAM" | "INDEPENDENT"; state: string; underlying: string; exchange: string; strike: number | null; optionType: "CE" | "PE" | null; expiry: string | null; side: "BUY" | "SELL";
  entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: readonly number[]; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; expiresAt: Date; setup: string | null;
}
export interface ConfidenceRef { id: string; score: number; calibrationStatus: string; completeness: number | null; missing: readonly string[]; caps: readonly string[] }
export interface DecisionInput {
  now: Date; candidate: DecisionCandidate; research: ResearchPackage | null; researchPackageId: string | null; confidence: ConfidenceRef | null;
  risk: RiskDecision | null; riskAssessmentId: string | null; sizing: SizingResultV2 | null; simulationId: string | null; paperEnabled: boolean; policy?: DecisionPolicy;
}
export type ReasonCategory = "SUPPORTING" | "MISSING" | "CONTRADICTORY" | "RISK" | "SIZE" | "VALIDITY" | "STOP_LOSS" | "PROVENANCE" | "PERMISSION";
export interface DecisionReason { code: string; category: ReasonCategory; detail: string }
export interface DecisionResult {
  engineVersion: string; outcome: DecisionOutcome; reasons: DecisionReason[]; restrictions: DecisionReason[]; whatWouldChange: string[];
  permittedSize: null | { lots: number; quantity: number; maxLossAtStop: string; riskPerLot: string; grossExposure: string; sizeMultiplier: number; binding: string };
  stopLoss: { validation: StopLossValidation; level: number | null; targets: number[] }; validFrom: Date; validUntil: Date; validityReason: string;
  evidenceRefs: string[]; versions: Record<string, string>; explanation: Explanation;
  provenance: { candidateId: string; candidateSource: string; dataSource: string; researchPackageId: string | null; researchPackageSha256: string | null; confidenceAssessmentId: string | null; riskAssessmentId: string | null; simulationId: string | null };
  grantsApproval: false;
}
export interface Explanation { headline: string; supporting: string[]; missing: string[]; contradictory: string[]; riskRestrictions: string[]; sizeRestriction: string | null; expiry: string; reassess: string[]; invalidatedBy: string[] }

const NO_TRADE_CODES = new Set(["MARKET_CLOSED", "OUTSIDE_SESSION", "CLOSING_WINDOW", "DAILY_LOSS_LIMIT_REACHED", "DAILY_RISK_BUDGET_EXHAUSTED", "DRAWDOWN_HALT", "MAX_CONCURRENT_POSITIONS", "PORTFOLIO_RISK_BUDGET_EXHAUSTED", "CORRELATED_EXPOSURE_LIMIT"]);
const WAIT_DATA_CODES = new Set(["SPEC_UNAVAILABLE", "FEES_UNAVAILABLE", "PORTFOLIO_STATE_UNAVAILABLE", "MARKET_DATA_UNAVAILABLE"]);
const UNVERIFIED_CODES = new Set(["SPEC_UNVERIFIED", "FEES_UNVERIFIED", "REGIME_FIXTURE_BACKED"]);
const mid = (c: DecisionCandidate): number | null => (c.entryLow !== null && c.entryHigh !== null ? (c.entryLow + c.entryHigh) / 2 : c.entryLow ?? c.entryHigh);
const R = (code: string, category: ReasonCategory, detail: string): DecisionReason => ({ code, category, detail });

/** The mandatory stop-loss rule applied to the candidate's own levels. Always runs; its result is stored with the decision. */
export function validateCandidateStop(c: DecisionCandidate): StopLossValidation {
  const isOption = c.strike !== null && c.optionType !== null;
  return validateStopLoss({ instrumentType: isOption ? "option" : "equity", side: c.side === "BUY" ? "buy" : "sell", optionType: c.optionType, stopLoss: c.stopLoss, entryPrice: mid(c), levelBasis: isOption ? "premium" : "price" });
}

export function decide(i: DecisionInput): DecisionResult {
  const P = i.policy ?? DEFAULT_DECISION_POLICY, c = i.candidate, now = i.now;
  const stop = validateCandidateStop(c); // ALWAYS evaluated, whatever else happens
  const codes = new Set<string>(i.risk?.reasons.map((r) => r.code) ?? []);
  const reasons: DecisionReason[] = [], restrictions: DecisionReason[] = [], change: string[] = [];
  const supporting: string[] = [], missing: string[] = [], contradictory: string[] = [];
  let outcome: DecisionOutcome = "QUALIFIED";
  const settle = (o: DecisionOutcome): void => { const order: DecisionOutcome[] = ["NO_TRADE", "REJECT", "EVALUATION_ONLY", "WAIT", "QUALIFIED"]; if (order.indexOf(o) < order.indexOf(outcome)) outcome = o; };

  // 1. the situation forbids trading now
  const active = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION"].includes(c.state);
  if (!active) { settle("NO_TRADE"); reasons.push(R("CANDIDATE_NOT_ACTIVE", "VALIDITY", `the candidate is ${c.state}`)); change.push("a new candidate for this instrument would have to be generated"); }
  if (c.expiresAt.getTime() <= now.getTime()) { settle("NO_TRADE"); reasons.push(R("CANDIDATE_EXPIRED", "VALIDITY", "the candidate's validity has passed")); change.push("the setup must be re-detected and re-researched"); }
  if (i.risk) for (const r of i.risk.reasons) {
    if (r.code.startsWith("CONTROL_")) { settle("NO_TRADE"); reasons.push(R(r.code, "RISK", r.detail)); if (r.correctiveAction) change.push(r.correctiveAction); }
    else if (r.severity === "BLOCK" && NO_TRADE_CODES.has(r.code)) { settle("NO_TRADE"); reasons.push(R(r.code, "RISK", r.detail)); if (r.correctiveAction) change.push(r.correctiveAction); }
  }

  // 2. hard rules: the mandatory stop-loss validation, the risk verdict, the research verdict
  if (stop.result !== "VALID") { settle("REJECT"); reasons.push(R(`STOP_LOSS_${stop.reasonCode ?? stop.result}`, "STOP_LOSS", `mandatory stop-loss validation: ${stop.result}${stop.detail ? ` (${stop.detail})` : ""}`)); change.push("supply a valid stop-loss on the correct side of the entry in the right basis"); }
  else supporting.push(`the stop-loss passed the mandatory validation (${STOP_LOSS_RULE_VERSION}), risk ${stop.riskPct ?? "?"}% of the reference`);
  if (i.risk?.verdict === "BLOCKED") for (const r of i.risk.reasons.filter((x) => x.severity === "BLOCK")) {
    if (r.code.startsWith("CONTROL_") || NO_TRADE_CODES.has(r.code)) continue;
    if (WAIT_DATA_CODES.has(r.code)) { settle("WAIT"); missing.push(`${r.code}: ${r.detail}`); reasons.push(R(r.code, "MISSING", r.detail)); if (r.correctiveAction) change.push(r.correctiveAction); }
    else { settle("REJECT"); reasons.push(R(r.code, "RISK", r.detail)); if (r.correctiveAction) change.push(r.correctiveAction); }
  }
  const rp = i.research;
  if (rp) {
    if (rp.halt || rp.assessment === "RESEARCH_BLOCKED" || rp.assessment === "RESEARCH_ADVERSE") { settle("REJECT"); reasons.push(R(rp.halt ? "RESEARCH_HALTED" : rp.assessment, "CONTRADICTORY", `research ${rp.halt ? `halted (${rp.haltReason ?? "unspecified"})` : rp.assessment}`)); contradictory.push(`research assessment ${rp.assessment}`); change.push("the adverse research finding must resolve"); }
    else if (!P.acceptableResearch.includes(rp.assessment) || rp.missingRequired.length > 0) { settle("WAIT"); reasons.push(R("RESEARCH_NOT_CONCLUSIVE", "MISSING", `research is ${rp.assessment}${rp.missingRequired.length ? `; required agents missing: ${rp.missingRequired.join(", ")}` : ""}`)); missing.push(...rp.missingRequired.map((m) => `required agent ${m}`)); change.push("complete the missing research evidence"); }
    else supporting.push(`research assessment ${rp.assessment} from ${rp.reports.length} reports`);
    if (rp.contradictions.length) { settle("WAIT"); for (const x of rp.contradictions) { contradictory.push(`${x.supportive.join(", ")} support but ${x.opposing.join(", ")} ${x.opposingVerdict}`); } reasons.push(R("AGENTS_CONTRADICT", "CONTRADICTORY", "completed agents disagree")); change.push("resolve the disagreement between agents"); }
  } else { settle("WAIT"); reasons.push(R("NO_RESEARCH_PACKAGE", "MISSING", "no research package exists")); missing.push("research package"); change.push("run research for this candidate"); }

  // 3. fitness of the inputs
  if (c.dataSource === "FIXTURE") { settle("EVALUATION_ONLY"); reasons.push(R("FIXTURE_CANDIDATE", "PROVENANCE", "the candidate was built from fixture data")); change.push("the candidate must come from real market data"); }
  for (const code of codes) if (UNVERIFIED_CODES.has(code)) { settle("EVALUATION_ONLY"); reasons.push(R(code, "PROVENANCE", i.risk?.reasons.find((r) => r.code === code)?.detail ?? code)); change.push(i.risk?.reasons.find((r) => r.code === code)?.correctiveAction ?? "use verified inputs"); }
  if (!i.paperEnabled) { settle("EVALUATION_ONLY"); reasons.push(R("PAPER_NOT_ENABLED", "PERMISSION", "the user has not enabled PAPER execution for this account")); change.push("the account owner enables PAPER execution"); }

  // 4. unresolved
  if (!i.risk || !i.sizing) { settle("WAIT"); reasons.push(R("NO_RISK_ASSESSMENT", "MISSING", "no risk assessment / sizing exists for this account")); missing.push("risk assessment"); change.push("run the capital and risk evaluation"); }
  const cf = i.confidence;
  if (!cf) { settle("WAIT"); reasons.push(R("NO_CONFIDENCE_ASSESSMENT", "MISSING", "no confidence assessment exists")); missing.push("confidence assessment"); change.push("run the confidence assessment for this candidate"); }
  else {
    if (cf.score < P.minConfidenceScore) { settle("WAIT"); reasons.push(R("STRENGTH_BELOW_MINIMUM", "MISSING", `evidence strength ${cf.score} is below the minimum ${P.minConfidenceScore} (a strength score, not a probability)`)); change.push("stronger or more complete evidence"); }
    else supporting.push(`evidence strength ${cf.score}/100 (${cf.calibrationStatus}; not a probability)`);
    if (cf.completeness !== null && cf.completeness < P.minEvidenceCompleteness) { settle("WAIT"); reasons.push(R("EVIDENCE_INCOMPLETE", "MISSING", `evidence completeness ${Math.round(cf.completeness * 100)}% is below ${Math.round(P.minEvidenceCompleteness * 100)}%`)); missing.push(...cf.missing); change.push("provide the missing evidence"); }
  }
  for (const r of i.risk?.reasons.filter((x) => x.severity === "RESTRICT") ?? []) restrictions.push(R(r.code, "RISK", r.detail));
  if (i.sizing && i.sizing.status === "NOT_SIZED") { settle("REJECT"); reasons.push(R(`NOT_SIZED_${i.sizing.reason ?? "UNKNOWN"}`, "SIZE", i.sizing.detail)); }

  // 5. size and validity window
  const permittedSize = outcome === "QUALIFIED" && i.sizing && i.sizing.status === "SIZED" ? { lots: i.sizing.lots, quantity: i.sizing.quantity, maxLossAtStop: i.sizing.maxLossAtStop, riskPerLot: i.sizing.riskPerLot, grossExposure: i.sizing.grossExposure, sizeMultiplier: i.risk?.sizeMultiplier ?? 1, binding: i.sizing.riskBudget.binding } : null;
  if (outcome === "QUALIFIED" && !permittedSize) { outcome = "REJECT"; reasons.push(R("NO_PERMITTED_SIZE", "SIZE", "no size could be permitted")); }
  const ttlEnd = new Date(now.getTime() + P.decisionTtlMinutes * 60_000);
  const validUntil = new Date(Math.min(ttlEnd.getTime(), c.expiresAt.getTime() > now.getTime() ? c.expiresAt.getTime() : ttlEnd.getTime()));
  const validityReason = validUntil.getTime() === ttlEnd.getTime() ? `decisions are valid for ${P.decisionTtlMinutes} minutes` : "the candidate expires first";
  if (outcome === "QUALIFIED" && validUntil.getTime() <= now.getTime()) { outcome = "NO_TRADE"; reasons.push(R("NO_VALIDITY_WINDOW", "VALIDITY", "no validity window remains")); }
  if (permittedSize && i.sizing && i.sizing.riskBudget.binding !== "risk_percent") restrictions.push(R("SIZE_RESTRICTED", "SIZE", `the size is limited by the ${i.sizing.riskBudget.binding} budget`));
  if (permittedSize && (i.risk?.sizeMultiplier ?? 1) < 1) restrictions.push(R("SIZE_REDUCED", "SIZE", `risk conditions reduced the size to ${Math.round((i.risk?.sizeMultiplier ?? 1) * 100)}% of the policy size`));

  // 6. THE FINAL GUARD (after the last place an outcome is decided): an execution-eligible outcome needs a VALID mandatory stop-loss validation
  assertStopLossAllowsEligibility(outcome, stop);
  const finalPermitted = outcome === "QUALIFIED" ? permittedSize : null;
  const headline = outcome === "QUALIFIED" ? `Qualified for approval at ${finalPermitted?.lots} lot(s), maximum loss ${finalPermitted?.maxLossAtStop} at the stop` : `${outcome}: ${reasons[0]?.detail ?? "no qualifying evidence"}`;
  return {
    engineVersion: DECISION_ENGINE_VERSION, outcome, reasons, restrictions, whatWouldChange: [...new Set(change)], permittedSize: finalPermitted,
    stopLoss: { validation: stop, level: c.stopLoss, targets: [...c.targets] }, validFrom: now, validUntil, validityReason,
    evidenceRefs: [...new Set([...(i.risk?.evidence ?? []), ...(rp?.evidenceIndex ?? []), `candidate:${c.id}`, ...(i.researchPackageId ? [`research_package:${i.researchPackageId}`] : []), ...(cf ? [`confidence:${cf.id}`] : []), ...(i.riskAssessmentId ? [`risk_assessment:${i.riskAssessmentId}`] : []), ...(i.simulationId ? [`simulation:${i.simulationId}`] : [])])].sort(),
    versions: { decisionEngine: DECISION_ENGINE_VERSION, stopLossRule: stop.ruleVersion, riskEngine: i.risk?.engineVersion ?? "none", sizingModel: i.sizing?.modelVersion ?? "none", researchPackage: rp?.packageVersion ?? "none", riskPolicyVersion: String(i.risk?.policyVersion ?? "none") },
    explanation: { headline, supporting, missing: [...new Set(missing)], contradictory, riskRestrictions: restrictions.filter((r) => r.category === "RISK").map((r) => `${r.code}: ${r.detail}`), sizeRestriction: restrictions.find((r) => r.category === "SIZE")?.detail ?? null, expiry: `valid until ${validUntil.toISOString()}: ${validityReason}`, reassess: [...new Set(change)], invalidatedBy: [c.stopLoss !== null ? `price reaching the stop-loss ${c.stopLoss}` : "a missing stop-loss", `the candidate expiring at ${c.expiresAt.toISOString()}`, "a failed revalidation: risk limits, the mandatory stop-loss rule, a control or the kill switch, or the loss of PAPER permission"] },
    provenance: { candidateId: c.id, candidateSource: c.source, dataSource: c.dataSource, researchPackageId: i.researchPackageId, researchPackageSha256: rp?.packageSha256 ?? null, confidenceAssessmentId: cf?.id ?? null, riskAssessmentId: i.riskAssessmentId, simulationId: i.simulationId },
    grantsApproval: false,
  };
}
