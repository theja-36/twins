import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { getLatestRiskDecisionForOptionsClaim, getLatestRiskDecisionForSignal, getRiskDecision, refuseUnlessSafe, RiskDecisionError, supersedeRiskDecision, type CreateOutcome, type RiskDecisionRecord } from "../riskDecisions";
import { breakerBlockId, breakerGate, type BreakerOptions, type CircuitBreakerStatus } from "../breakers/record";
import { databaseNow, isStale } from "../expiry/record";
import { loadExpiryConfig } from "../expiry/config";
import { intelligenceOf, isIntelligenceValid } from "../intelligence/record";
import { loadSizingConfig, type SizingConfig } from "./config";
import { computePositionSize, SIZING_ENGINE_VERSION, type SizingInput, type SizingResult } from "./engine";

/**
 * Records a position size on a risk decision (Stage 3 / Task 2). Risk decisions are append-only: sizing appends a NEW version that supersedes the
 * current one, citing it and the stop-loss evidence, with the complete sizing input/output snapshot. Nothing here places an order, calls a broker or
 * creates executable state; a SIZED decision stays PENDING (portfolio limits, circuit breakers and market gates are later stages), and the database
 * refuses APPROVED_FOR_REVIEW for any decision that does not carry a SIZED size.
 */
export const SIZING_ACTOR = "service:position-sizing";

export interface SizeOptions extends BreakerOptions {
  config?: SizingConfig;
  /** Overrides config.availableCapital (tests, operator tools). */
  capital?: number | null;
  /**
   * Stage 4 / Task 5. true (the worker): a decision that does not carry recorded source intelligence is REJECTED (`source_intelligence_missing`), never sized from the legacy
   * self-reported confidence. false (default, legacy callers): such a decision keeps the pre-Task-5 behaviour. A decision that DOES carry intelligence always uses it.
   */
  requireIntelligence?: boolean;
}

export interface SizingOutcome extends CreateOutcome {
  sizingStatus: SizingResult["status"] | "CIRCUIT_BREAKER_OPEN";
  reasonCode: string;
  quantity: number;
  maxLossAmount: number;
}

const asNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const isSizingRevision = (d: RiskDecisionRecord): boolean => d.createdBy === SIZING_ACTOR;

async function lotSizeFor(db: Db, d: RiskDecisionRecord): Promise<{ lotSize: number | null; lotSizeSource: string }> {
  if (d.signalId) {
    const [row] = await db.select({ lot: schema.instruments.lotSize }).from(schema.signals).innerJoin(schema.instruments, eq(schema.signals.instrumentId, schema.instruments.id)).where(eq(schema.signals.id, d.signalId));
    return { lotSize: asNum(row?.lot), lotSizeSource: "instruments.lot_size" };
  }
  const [claim] = await db.select({ verification: schema.optionsClaims.verification }).from(schema.optionsClaims).where(eq(schema.optionsClaims.id, d.optionsClaimId as string));
  const v = claim?.verification as { status?: string; contract?: { lotSize?: number } } | null;
  return { lotSize: v?.status === "verified" ? asNum(v.contract?.lotSize) : null, lotSizeSource: "options_claims.verification.contract" };
}

/**
 * The 0-100 confidence the sizing tiers use. The first (pending) version keeps the validation's confidence in its snapshot as 0-1 (decision
 * intelligence; 0 = "not a measurement"); a sizing version stores the normalized 0-100 value in `confidence_score`, so re-sizing reads that.
 */
function confidenceOf(d: RiskDecisionRecord): number | null {
  if (isSizingRevision(d)) return asNum(d.confidenceScore);
  const snap = d.inputSnapshot as { signalValidation?: { decisionConfidence?: unknown } | null } | null;
  const raw = asNum(snap?.signalValidation?.decisionConfidence);
  if (raw === null) return null;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100 * 1e6) / 1e6;
}

/** Computes and appends the sizing version for the CURRENT risk decision `decisionId`. Idempotent: identical inputs return the existing version. */
export async function sizeRiskDecision(db: Db, decisionId: string, opts: SizeOptions = {}): Promise<SizingOutcome> {
  await refuseUnlessSafe("risk_decision.size"); // fail closed before anything is read or written
  const config = opts.config ?? loadSizingConfig();
  const capital = opts.capital === undefined ? config.availableCapital : opts.capital;
  if (capital === null) throw new RiskDecisionError("capital_not_configured", "no available capital is configured (TWINS_SIZING_AVAILABLE_CAPITAL); nothing is sized");

  const prev = await getRiskDecision(db, decisionId);
  if (!prev) throw new RiskDecisionError("not_found", "the risk decision does not exist");
  if (!(prev.status === "PENDING" || (prev.status === "REJECTED" && isSizingRevision(prev)))) throw new RiskDecisionError("not_sizable", `a ${prev.status} decision is not sized`);
  const expiry = opts.expiry ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  if (!prev.supersededById && isStale(prev, asOf, expiry)) throw new RiskDecisionError("decision_expired", "the decision is past its validity window; it is expired, not sized");

  const subjectWhere = prev.signalId ? eq(schema.stopLossValidations.signalId, prev.signalId) : eq(schema.stopLossValidations.optionsClaimId, prev.optionsClaimId as string);
  const [evidence] = await db.select().from(schema.stopLossValidations).where(subjectWhere).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  const { lotSize, lotSizeSource } = await lotSizeFor(db, prev);
  const valid = evidence?.result === "VALID";
  const targets = [prev.target1, prev.target2, prev.target3].map(asNum);
  const intel = intelligenceOf(prev);
  const intelValid = isIntelligenceValid(intel);
  const intelRequired = opts.requireIntelligence === true || intel !== null;
  // Source intelligence decides the tiers when it exists (or is required): invalid, missing or UNKNOWN intelligence can only produce UNKNOWN tiers, i.e. no size.
  const resolvedConfidenceTier = !intelRequired ? undefined : intelValid && intel ? intel.confidence.tier : ("UNKNOWN" as const);
  const resolvedTrust = !intelRequired ? prev.sourceTrustTier : intelValid && intel ? intel.sizingTrustTier : "UNKNOWN";
  const input: SizingInput = {
    capital,
    instrumentType: prev.instrumentType,
    market: prev.market,
    side: prev.side,
    entryPrice: valid ? asNum(evidence?.entryPrice) : asNum(prev.entryPrice),
    stopLoss: valid ? asNum(evidence?.normalizedStopLoss) : asNum(prev.stopLoss),
    stopLossBasis: evidence?.levelBasis ?? prev.stopLossBasis,
    stopLossResult: evidence?.result ?? null,
    targets,
    lotSize,
    confidenceScore: !intelRequired ? confidenceOf(prev) : intelValid && intel ? intel.confidence.score : null,
    ...(resolvedConfidenceTier ? { confidenceTier: resolvedConfidenceTier } : {}),
    sourceTrustTier: resolvedTrust,
    context: { ...(intelRequired ? { sourceIntelligence: { status: intel?.status ?? "MISSING", reasonCode: intel?.reasonCode ?? "SOURCE_INTELLIGENCE_UNAVAILABLE", inputHash: intel?.inputHash ?? null, trustTier: intel?.trust.tier ?? null, confidenceTier: intel?.confidence.tier ?? null } } : {}), riskDecisionId: prev.id, decisionVersion: prev.decisionVersion, status: prev.status, stopLossValidationId: evidence?.id ?? null, lotSizeSource },
  };
  const result = computePositionSize(input, config);
  // Circuit breakers (Stage 3 / Task 4): a new SIZED decision is not created while a loss breaker is open (the rejection is recorded instead). Unreadable state fails closed.
  let blocked: CircuitBreakerStatus | null = null;
  if (result.status === "SIZED" && capital > 0) {
    const gate = await breakerGate(db, capital, { ...opts, asOf, expiry });
    if (gate.blocked) blocked = gate;
  }
  const hash = blocked ? createHash("sha256").update(`${result.inputHash}:${breakerBlockId(blocked)}`).digest("hex") : result.inputHash;

  // unchanged inputs: the current version (or, for a retry against the version it superseded, its successor) already carries this sizing
  const carries = (d: RiskDecisionRecord): boolean => isSizingRevision(d) && (d.outputSnapshot as { sizing?: { inputHash?: string } } | null)?.sizing?.inputHash === hash;
  const outcomeOf = (d: RiskDecisionRecord): SizingOutcome => ({ id: d.id, created: false, decisionVersion: d.decisionVersion, status: d.status as CreateOutcome["status"], sizingStatus: blocked ? "CIRCUIT_BREAKER_OPEN" : result.status, reasonCode: blocked ? "circuit_breaker_open" : result.reasonCode, quantity: blocked ? 0 : result.quantity, maxLossAmount: blocked ? 0 : result.maxLossAmount });
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
    throw new RiskDecisionError("not_latest_version", "only the latest version of a decision can be sized", prev.supersededById);
  }
  if (carries(prev)) return outcomeOf(prev);
  if (!evidence) throw new RiskDecisionError("stop_loss_evidence_missing", "the stop-loss evidence for this decision no longer exists");

  const sized = result.status === "SIZED" && !blocked;
  const append = () => supersedeRiskDecision(db, prev.id, {
    stopLossValidationId: evidence.id,
    status: sized ? "PENDING" : "REJECTED",
    idempotencyKey: `risk-sizing:${prev.id}:${hash.slice(0, 32)}`,
    createdBy: SIZING_ACTOR,
    instrumentType: prev.instrumentType,
    market: prev.market,
    symbol: prev.symbol,
    expiry: prev.expiry,
    strike: asNum(prev.strike),
    optionType: prev.optionType,
    side: prev.side,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    stopLossBasis: input.stopLossBasis ?? null,
    target1: targets[0] ?? null,
    target2: targets[1] ?? null,
    target3: targets[2] ?? null,
    plannedQuantity: sized ? result.quantity : null,
    plannedNotional: sized ? result.notional : null,
    plannedMaxLossAmount: sized ? result.maxLossAmount : null,
    plannedMaxLossPercent: sized ? result.maxLossPercent : null,
    confidenceScore: input.confidenceScore,
    sourceTrustTier: input.sourceTrustTier ?? prev.sourceTrustTier,
    decisionReasonCode: sized ? "sized_awaiting_limits" : blocked ? "sizing_circuit_breaker_open" : intelRequired && !intelValid ? (intel ? intel.reasonCode.toLowerCase() : "source_intelligence_missing") : `sizing_${result.reasonCode}`.slice(0, 60),
    decisionReason: sized ? `${result.explanation} Awaiting the remaining risk gates (portfolio limits, circuit breakers, market checks), which are not part of this stage.` : blocked ? `A loss circuit breaker is open (${blocked.blockedBy.join(", ")}); no new sized decision is created until it resets.` : result.explanation,
    inputSnapshot: { sizing: result.snapshot, ...(blocked ? { circuitBreaker: { blockedBy: blocked.blockedBy, openBreachIds: blocked.openBreachIds, asOf: blocked.asOf.toISOString() } } : {}), previousDecisionId: prev.id, previousVersion: prev.decisionVersion, base: prev.inputSnapshot },
    outputSnapshot: {
      ...(intel ? { intelligence: intel } : {}), // the recorded intelligence is carried through every later version
      stage: "position_sizing",
      sized,
      limitsApplied: false,
      sizing: { engineVersion: SIZING_ENGINE_VERSION, status: blocked ? "CIRCUIT_BREAKER_OPEN" : result.status, reasonCode: blocked ? "circuit_breaker_open" : result.reasonCode, inputHash: hash, quantity: blocked ? 0 : result.quantity, notional: blocked ? 0 : result.notional, maxLossAmount: blocked ? 0 : result.maxLossAmount, maxLossPercent: blocked ? 0 : result.maxLossPercent, riskPerUnit: result.riskPerUnit, riskRewardRatio: result.riskRewardRatio, appliedTier: result.appliedTier },
    },
    evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id, sizingInputHash: hash },
  });
  let out: CreateOutcome;
  try {
    out = await append();
  } catch (error) {
    // a concurrent sizer may append the successor between our read and our write: if it carries this same sizing, that IS the idempotent result
    if (error instanceof RiskDecisionError && error.code === "not_latest_version") {
      const again = await getRiskDecision(db, prev.id);
      const successor = again?.supersededById ? await getRiskDecision(db, again.supersededById) : undefined;
      if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
    }
    throw error;
  }
  return { ...out, sizingStatus: blocked ? "CIRCUIT_BREAKER_OPEN" : result.status, reasonCode: blocked ? "circuit_breaker_open" : result.reasonCode, quantity: blocked ? 0 : result.quantity, maxLossAmount: blocked ? 0 : result.maxLossAmount };
}

export type SizeLatestResult = SizingOutcome | { skipped: "no_risk_decision" | "capital_not_configured" | "already_sized_or_final" };

async function sizeLatest(db: Db, latest: RiskDecisionRecord | undefined, opts: SizeOptions): Promise<SizeLatestResult> {
  if (!latest) return { skipped: "no_risk_decision" };
  const config = opts.config ?? loadSizingConfig();
  if ((opts.capital === undefined ? config.availableCapital : opts.capital) === null) return { skipped: "capital_not_configured" };
  if (!(latest.status === "PENDING" || (latest.status === "REJECTED" && isSizingRevision(latest)))) return { skipped: "already_sized_or_final" };
  return sizeRiskDecision(db, latest.id, { ...opts, config });
}

export async function sizeLatestRiskDecisionForSignal(db: Db, signalId: string, opts: SizeOptions = {}): Promise<SizeLatestResult> {
  return sizeLatest(db, await getLatestRiskDecisionForSignal(db, signalId), opts);
}
export async function sizeLatestRiskDecisionForOptionsClaim(db: Db, optionsClaimId: string, opts: SizeOptions = {}): Promise<SizeLatestResult> {
  return sizeLatest(db, await getLatestRiskDecisionForOptionsClaim(db, optionsClaimId), opts);
}
