import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { createRiskDecision, type CreateOutcome, type RiskDecisionInput } from "./riskDecisions";

/**
 * Hooks used by the worker after validation (Stage 3 / Task 1): create the first, PENDING risk decision for a validated signal or a recorded options
 * claim. PENDING only: no position size, no portfolio limits, no approval, no card. A subject without stop-loss evidence gets NO decision (the evidence
 * is never invented); the caller logs the skip. Re-running is safe (the idempotency key is per subject).
 */
const CREATED_BY = "service:risk-decision";

export type PendingResult = ({ skipped?: undefined } & CreateOutcome) | { skipped: "no_stop_loss_evidence" | "not_a_complete_claim" | "subject_not_found" };

function reason(stopResult: string, stopReason: string | null, extra?: string): { code: string; text: string } {
  if (stopResult !== "VALID") return { code: `stop_loss_${stopResult.toLowerCase()}`, text: `The stop-loss validation is ${stopResult}${stopReason ? ` (${stopReason})` : ""}; the decision cannot be approved for review.` };
  if (extra) return { code: extra, text: "Awaiting the risk gates (sizing, limits, market checks) that are not part of this stage." };
  return { code: "awaiting_risk_gates", text: "Stop-loss validated; awaiting the risk gates (sizing, limits, market checks) that are not part of this stage." };
}

const asNum = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export async function createPendingRiskDecisionForSignal(db: Db, signalId: string): Promise<PendingResult> {
  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) return { skipped: "subject_not_found" };
  const [stop] = await db.select().from(schema.stopLossValidations).where(eq(schema.stopLossValidations.signalId, signalId)).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  if (!stop) return { skipped: "no_stop_loss_evidence" };
  const [instrument] = await db.select().from(schema.instruments).where(eq(schema.instruments.id, signal.instrumentId));
  const [validation] = await db.select().from(schema.signalValidations).where(eq(schema.signalValidations.signalId, signalId)).orderBy(desc(schema.signalValidations.createdAt)).limit(1);
  const targets = Array.isArray(signal.targets) ? (signal.targets as unknown[]).map(asNum) : [];
  const why = reason(stop.result, stop.reasonCode);
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId },
    stopLossValidationId: stop.id,
    status: "PENDING",
    idempotencyKey: `risk-pending:signal:${signalId}`,
    createdBy: CREATED_BY,
    instrumentType: instrument?.instrumentType ?? "equity",
    market: instrument?.exchange ?? null,
    symbol: instrument?.symbol ?? "UNKNOWN",
    side: signal.direction.toUpperCase(),
    entryPrice: asNum(stop.entryPrice) ?? asNum(signal.entryPrice),
    stopLoss: stop.result === "VALID" ? asNum(stop.normalizedStopLoss) : asNum(signal.stopLoss),
    stopLossBasis: stop.levelBasis ?? null,
    target1: targets[0] ?? null,
    target2: targets[1] ?? null,
    target3: targets[2] ?? null,
    confidenceScore: validation ? asNum(validation.decisionConfidence) : null,
    sourceTrustTier: validation?.sourceReliability ?? "UNKNOWN",
    decisionReasonCode: why.code,
    decisionReason: why.text,
    inputSnapshot: {
      subject: "signal",
      signal: { id: signal.id, parserVersion: signal.parserVersion, direction: signal.direction, entryPrice: signal.entryPrice, stopLoss: signal.stopLoss, targets: signal.targets ?? null, timeframe: signal.timeframe, extractedConfidence: signal.extractedConfidence, signalTimestamp: signal.signalTimestamp.toISOString() },
      instrument: instrument ? { symbol: instrument.symbol, exchange: instrument.exchange, instrumentType: instrument.instrumentType } : null,
      stopLossValidation: { id: stop.id, ruleVersion: stop.ruleVersion, result: stop.result, reasonCode: stop.reasonCode, normalizedStopLoss: stop.normalizedStopLoss, entryPrice: stop.entryPrice, riskDistance: stop.riskDistance, riskPct: stop.riskPct, maxRiskPct: stop.maxRiskPct, levelBasis: stop.levelBasis },
      signalValidation: validation ? { id: validation.id, outcome: validation.outcome, decisionConfidence: validation.decisionConfidence, confidenceLabel: validation.confidenceLabel, sourceReliability: validation.sourceReliability } : null,
    },
    outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false },
    evidenceReferences: { signalId, telegramMessageId: signal.telegramMessageId ?? null, signalValidationId: validation?.id ?? null },
  };
  return createRiskDecision(db, input);
}

const MARKET_OF: Record<string, string> = { SENSEX: "BSE" };

export async function createPendingRiskDecisionForOptionsClaim(db: Db, optionsClaimId: string): Promise<PendingResult> {
  const [row] = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.id, optionsClaimId));
  if (!row) return { skipped: "subject_not_found" };
  if (row.resultKind !== "claim" || !row.claim) return { skipped: "not_a_complete_claim" };
  const claim = row.claim as { action: string | null; underlying: string; strike: number | null; optionType: string | null; expiry: { status: string; day?: number; month?: number; year?: number }; entry: { type: string; price?: number }; stopLoss: number | null; targets: number[]; levelBasis: string };
  const [stop] = await db.select().from(schema.stopLossValidations).where(eq(schema.stopLossValidations.optionsClaimId, optionsClaimId)).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  if (!stop) return { skipped: "no_stop_loss_evidence" };
  const why = reason(stop.result, stop.reasonCode);
  const e = claim.expiry;
  const expiry = e.status === "full" && e.year && e.month && e.day ? `${String(e.year).padStart(4, "0")}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}` : null;
  const input: RiskDecisionInput = {
    subject: { kind: "options_claim", optionsClaimId },
    stopLossValidationId: stop.id,
    status: "PENDING",
    idempotencyKey: `risk-pending:options-claim:${optionsClaimId}`,
    createdBy: CREATED_BY,
    instrumentType: "option",
    market: MARKET_OF[claim.underlying] ?? "NSE",
    symbol: claim.underlying,
    expiry,
    strike: claim.strike,
    optionType: claim.optionType,
    side: claim.action ? claim.action.toUpperCase() : null,
    entryPrice: asNum(stop.entryPrice) ?? (claim.entry.type !== "range" && claim.entry.type !== "market" && claim.entry.type !== "unspecified" ? (claim.entry.price ?? null) : null),
    stopLoss: stop.result === "VALID" ? asNum(stop.normalizedStopLoss) : claim.stopLoss,
    stopLossBasis: stop.levelBasis ?? claim.levelBasis,
    target1: claim.targets[0] ?? null,
    target2: claim.targets[1] ?? null,
    target3: claim.targets[2] ?? null,
    confidenceScore: null,
    sourceTrustTier: "UNKNOWN",
    decisionReasonCode: why.code,
    decisionReason: why.text,
    inputSnapshot: {
      subject: "options_claim",
      optionsClaim: { id: row.id, parserVersion: row.parserVersion, claim: row.claim, assessmentOutcome: row.assessmentOutcome, approvalPossible: row.approvalPossible },
      stopLossValidation: { id: stop.id, ruleVersion: stop.ruleVersion, result: stop.result, reasonCode: stop.reasonCode, normalizedStopLoss: stop.normalizedStopLoss, entryPrice: stop.entryPrice, riskDistance: stop.riskDistance, riskPct: stop.riskPct, maxRiskPct: stop.maxRiskPct, levelBasis: stop.levelBasis },
    },
    outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false },
    evidenceReferences: { optionsClaimId, telegramMessageId: row.telegramMessageId },
  };
  return createRiskDecision(db, input);
}
