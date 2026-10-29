import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { getSignalIntelligence, sizingTrustVocabulary, type IntelligenceRequest, type SignalForConfidence, type SignalIntelligence } from "@twins/historical";
import { getLatestRiskDecisionForOptionsClaim, getLatestRiskDecisionForSignal, getRiskDecision, refuseUnlessSafe, RiskDecisionError, supersedeRiskDecision, type CreateOutcome, type RiskDecisionRecord } from "../riskDecisions";

/**
 * Source intelligence in the risk-decision flow (Stage 4 / Task 5). After a live signal is parsed and its stop-loss validated (the PENDING decision exists), this appends a NEW
 * versioned risk-decision (never an UPDATE) that records, point in time as of the SIGNAL: the source identity, trust tier, calibrated confidence, matching pattern references,
 * evidence quality, data sufficiency, explanation and the complete intelligence snapshot. Sizing then reads the confidence and trust tiers from it; approval eligibility requires
 * it to be VALID. Missing intelligence is an explicit UNAVAILABLE result (the decision stays PENDING with a reason code) - never a default, never HIGH, never a guessed tier. A
 * database or runtime-state error is NOT swallowed: it propagates and the caller fails closed. This module creates no order, fill, position, approval card or broker call.
 */
export const INTELLIGENCE_ACTOR = "service:source-intelligence";

export interface RecordedIntelligence extends SignalIntelligence {
  /** What the sizing engine and the approval gate read. */
  sizingTrustTier: string;
}
export type IntelligenceResolver = (req: IntelligenceRequest) => Promise<SignalIntelligence>;
export interface IntelligenceOptions {
  /** Test seam / alternative intelligence source. Default: the stored scorecards and pattern library. */
  resolve?: IntelligenceResolver;
  config?: IntelligenceRequest["config"];
}
export interface IntelligenceOutcome extends CreateOutcome {
  intelligenceStatus: SignalIntelligence["status"];
  reasonCode: SignalIntelligence["reasonCode"];
  trustTier: string;
  confidenceTier: string;
}

const asNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** The recorded intelligence of a decision version (carried forward by every later stage), or null. */
export function intelligenceOf(d: Pick<RiskDecisionRecord, "outputSnapshot">): RecordedIntelligence | null {
  const i = (d.outputSnapshot as { intelligence?: RecordedIntelligence } | null)?.intelligence;
  return i && typeof i === "object" ? i : null;
}
/** Valid = verified status AND a real (non-UNKNOWN) confidence AND a trusted-enough (A / B / C) source. The status alone is never trusted. */
export function isIntelligenceValid(i: Pick<SignalIntelligence, "status" | "trust" | "confidence"> | null | undefined): boolean {
  return !!i && i.status === "VALID" && ["A", "B", "C"].includes(i.trust?.tier) && ["HIGH", "MEDIUM", "LOW"].includes(i.confidence?.tier);
}

interface LiveContext { sourceLabel: string; signal: SignalForConfidence; asOf: Date }

async function liveContext(db: Db, d: RiskDecisionRecord): Promise<LiveContext> {
  let messageId: string | null = null;
  let timestamp: Date | null = null;
  let entry: SignalForConfidence["entry"] = d.entryPrice === null ? null : { type: "at", price: Number(d.entryPrice) }; // a live signal carries one entry price: it is treated as a level entry
  if (d.signalId) {
    const [s] = await db.select({ messageId: schema.signals.telegramMessageId, ts: schema.signals.signalTimestamp }).from(schema.signals).where(eq(schema.signals.id, d.signalId));
    messageId = s?.messageId ?? null;
    timestamp = s?.ts ?? null;
  } else {
    const [c] = await db.select({ messageId: schema.optionsClaims.telegramMessageId, claim: schema.optionsClaims.claim }).from(schema.optionsClaims).where(eq(schema.optionsClaims.id, d.optionsClaimId as string));
    messageId = c?.messageId ?? null;
    const ce = (c?.claim as { entry?: { type?: string; price?: number; low?: number; high?: number } } | null)?.entry;
    if (ce) entry = ce;
  }
  let sourceLabel = "";
  if (messageId) {
    const [m] = await db.select({ ts: schema.telegramMessages.messageTimestamp, channel: schema.telegramSources.channelIdentifier }).from(schema.telegramMessages).innerJoin(schema.telegramSources, eq(schema.telegramSources.id, schema.telegramMessages.telegramSourceId)).where(eq(schema.telegramMessages.id, messageId));
    sourceLabel = m?.channel ?? "";
    timestamp ??= m?.ts ?? null;
  }
  const [stop] = await db.select({ result: schema.stopLossValidations.result }).from(schema.stopLossValidations).where(d.signalId ? eq(schema.stopLossValidations.signalId, d.signalId) : eq(schema.stopLossValidations.optionsClaimId, d.optionsClaimId as string)).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  const stopLossValid = stop?.result === "VALID";
  const asOf = timestamp ?? d.createdAt; // a signal with no recorded time is evaluated as of the decision's creation (never later)
  return {
    sourceLabel, asOf,
    signal: {
      market: d.market, instrumentType: d.instrumentType, underlying: d.symbol, optionType: d.optionType, side: d.side, entry, stopLoss: asNum(d.stopLoss),
      targets: [d.target1, d.target2, d.target3].map(asNum).filter((x): x is number => x !== null), expiryDate: d.expiry, timestamp: asOf,
      stopLossValid, dataQuality: stopLossValid && entry !== null ? "GOOD" : "INSUFFICIENT",
    },
  };
}

/** Resolves intelligence for the decision's signal WITHOUT writing anything (operator / API use). */
export async function resolveIntelligenceForDecision(db: Db, decisionId: string, opts: IntelligenceOptions = {}): Promise<SignalIntelligence> {
  const d = await getRiskDecision(db, decisionId);
  if (!d) throw new RiskDecisionError("not_found", "the risk decision does not exist");
  const ctx = await liveContext(db, d);
  return (opts.resolve ?? ((r) => getSignalIntelligence(db, r)))({ sourceLabel: ctx.sourceLabel, signal: ctx.signal, marketContext: { available: false }, asOf: ctx.asOf, ...(opts.config ? { config: opts.config } : {}) });
}

/** Appends the intelligence version for the CURRENT, not yet sized, PENDING decision. Idempotent: identical inputs return the existing version. */
export async function recordSourceIntelligence(db: Db, decisionId: string, opts: IntelligenceOptions = {}): Promise<IntelligenceOutcome> {
  await refuseUnlessSafe("risk_decision.intelligence"); // fail closed before anything is read or written
  const prev = await getRiskDecision(db, decisionId);
  if (!prev) throw new RiskDecisionError("not_found", "the risk decision does not exist");
  const carried = intelligenceOf(prev);
  const outcomeOf = (d: RiskDecisionRecord, i: SignalIntelligence): IntelligenceOutcome => ({ id: d.id, created: false, decisionVersion: d.decisionVersion, status: d.status as CreateOutcome["status"], intelligenceStatus: i.status, reasonCode: i.reasonCode, trustTier: i.trust.tier, confidenceTier: i.confidence.tier });
  // a retry of the pipeline is a no-op, never a second version: (a) this version was already superseded by an intelligence version; (b) a later stage (sizing, limits, gates) already carries intelligence
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    const si = successor ? intelligenceOf(successor) : null;
    if (successor && si) return outcomeOf(successor, si);
  }
  if (carried && prev.createdBy !== INTELLIGENCE_ACTOR && !prev.supersededById) return outcomeOf(prev, carried);
  const outSnap = prev.outputSnapshot as { sizing?: unknown } | null;
  if (!carried && !(prev.status === "PENDING" && !prev.supersededById && !outSnap?.sizing)) throw new RiskDecisionError("not_evaluable", `a ${prev.status}${prev.supersededById ? " superseded" : ""} or already sized decision does not take source intelligence`);

  const ctx = await liveContext(db, prev);
  const intel = await (opts.resolve ?? ((r) => getSignalIntelligence(db, r)))({ sourceLabel: ctx.sourceLabel, signal: ctx.signal, marketContext: { available: false }, asOf: ctx.asOf, ...(opts.config ? { config: opts.config } : {}) });
  const recorded: RecordedIntelligence = { ...intel, sizingTrustTier: sizingTrustVocabulary(intel.trust.tier) };
  const same = (d: RiskDecisionRecord): boolean => d.createdBy === INTELLIGENCE_ACTOR && intelligenceOf(d)?.inputHash === intel.inputHash;
  if (same(prev) && !prev.supersededById) return outcomeOf(prev, intel);
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    if (successor && same(successor)) return outcomeOf(successor, intel);
    if (successor?.createdBy === INTELLIGENCE_ACTOR) return outcomeOf(successor, intelligenceOf(successor) ?? intel);
    throw new RiskDecisionError("not_latest_version", "only the latest version of a decision takes source intelligence", prev.supersededById);
  }

  const valid = isIntelligenceValid(intel);
  const append = () => supersedeRiskDecision(db, prev.id, {
    stopLossValidationId: prev.stopLossValidationId, status: "PENDING", idempotencyKey: `risk-intelligence:${prev.id}:${intel.inputHash.slice(0, 32)}`, createdBy: INTELLIGENCE_ACTOR,
    instrumentType: prev.instrumentType, market: prev.market, symbol: prev.symbol, expiry: prev.expiry, strike: asNum(prev.strike), optionType: prev.optionType, side: prev.side,
    entryPrice: asNum(prev.entryPrice), stopLoss: asNum(prev.stopLoss), stopLossBasis: prev.stopLossBasis, target1: asNum(prev.target1), target2: asNum(prev.target2), target3: asNum(prev.target3),
    confidenceScore: valid ? intel.confidence.score : null, sourceTrustTier: recorded.sizingTrustTier,
    decisionReasonCode: valid ? "source_intelligence_recorded" : intel.reasonCode.toLowerCase(),
    decisionReason: valid
      ? `Source intelligence recorded (trust ${intel.trust.tier}, confidence ${intel.confidence.tier}, ${intel.confidence.sampleSize} historical outcomes). Awaiting sizing and the remaining risk gates.`
      : `Source intelligence is not valid (${intel.reasonCode}); the decision cannot be sized or become approval-eligible until valid intelligence exists.`,
    inputSnapshot: { intelligence: { inputHash: intel.inputHash, engineVersion: intel.engineVersion, asOf: intel.asOf, sourceLabel: intel.sourceIdentity.label }, previousDecisionId: prev.id, previousVersion: prev.decisionVersion, base: prev.inputSnapshot },
    outputSnapshot: { ...((prev.outputSnapshot as Record<string, unknown> | null) ?? {}), stage: "source_intelligence", intelligence: recorded },
    evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id, scorecardRunId: intel.trust.scorecardRunId, patternRunId: intel.confidence.patternRunId, intelligenceInputHash: intel.inputHash },
  });
  let out: CreateOutcome;
  try {
    out = await append();
  } catch (error) {
    // a concurrent worker may append the successor between our read and our write: if it carries the same intelligence, that IS the idempotent result
    if (error instanceof RiskDecisionError && error.code === "not_latest_version") {
      const again = await getRiskDecision(db, prev.id);
      const successor = again?.supersededById ? await getRiskDecision(db, again.supersededById) : undefined;
      if (successor && successor.createdBy === INTELLIGENCE_ACTOR) return outcomeOf(successor, intelligenceOf(successor) ?? intel);
    }
    throw error;
  }
  return { ...out, intelligenceStatus: intel.status, reasonCode: intel.reasonCode, trustTier: intel.trust.tier, confidenceTier: intel.confidence.tier };
}

export type IntelligenceLatestResult = IntelligenceOutcome | { skipped: "no_risk_decision" | "not_eligible_for_intelligence" };

export async function recordIntelligenceForSignal(db: Db, signalId: string, opts: IntelligenceOptions = {}): Promise<IntelligenceLatestResult> {
  const latest = await getLatestRiskDecisionForSignal(db, signalId);
  if (!latest) return { skipped: "no_risk_decision" };
  if (!intelligenceOf(latest) && latest.status !== "PENDING") return { skipped: "not_eligible_for_intelligence" };
  return recordSourceIntelligence(db, latest.id, opts);
}
export async function recordIntelligenceForOptionsClaim(db: Db, optionsClaimId: string, opts: IntelligenceOptions = {}): Promise<IntelligenceLatestResult> {
  const latest = await getLatestRiskDecisionForOptionsClaim(db, optionsClaimId);
  if (!latest) return { skipped: "no_risk_decision" };
  if (!intelligenceOf(latest) && latest.status !== "PENDING") return { skipped: "not_eligible_for_intelligence" };
  return recordSourceIntelligence(db, latest.id, opts);
}
