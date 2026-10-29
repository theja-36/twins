import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { getLatestRiskDecisionForOptionsClaim, getLatestRiskDecisionForSignal, getRiskDecision, refuseUnlessSafe, RiskDecisionError, supersedeRiskDecision, type CreateOutcome, type RiskDecisionRecord } from "../riskDecisions";
import { loadSizingConfig, type SizingConfig } from "./config";
import { computePositionSize, SIZING_ENGINE_VERSION, type SizingInput, type SizingResult } from "./engine";

/**
 * Records a position size on a risk decision (Stage 3 / Task 2). Risk decisions are append-only: sizing appends a NEW version that supersedes the
 * current one, citing it and the stop-loss evidence, with the complete sizing input/output snapshot. Nothing here places an order, calls a broker or
 * creates executable state; a SIZED decision stays PENDING (portfolio limits, circuit breakers and market gates are later stages), and the database
 * refuses APPROVED_FOR_REVIEW for any decision that does not carry a SIZED size.
 */
export const SIZING_ACTOR = "service:position-sizing";

export interface SizeOptions {
  config?: SizingConfig;
  /** Overrides config.availableCapital (tests, operator tools). */
  capital?: number | null;
}

export interface SizingOutcome extends CreateOutcome {
  sizingStatus: SizingResult["status"];
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

  const subjectWhere = prev.signalId ? eq(schema.stopLossValidations.signalId, prev.signalId) : eq(schema.stopLossValidations.optionsClaimId, prev.optionsClaimId as string);
  const [evidence] = await db.select().from(schema.stopLossValidations).where(subjectWhere).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  const { lotSize, lotSizeSource } = await lotSizeFor(db, prev);
  const valid = evidence?.result === "VALID";
  const targets = [prev.target1, prev.target2, prev.target3].map(asNum);
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
    confidenceScore: confidenceOf(prev),
    sourceTrustTier: prev.sourceTrustTier,
    context: { riskDecisionId: prev.id, decisionVersion: prev.decisionVersion, status: prev.status, stopLossValidationId: evidence?.id ?? null, lotSizeSource },
  };
  const result = computePositionSize(input, config);

  // unchanged inputs: the current version (or, for a retry against the version it superseded, its successor) already carries this sizing
  const carries = (d: RiskDecisionRecord): boolean => isSizingRevision(d) && (d.outputSnapshot as { sizing?: { inputHash?: string } } | null)?.sizing?.inputHash === result.inputHash;
  const outcomeOf = (d: RiskDecisionRecord): SizingOutcome => ({ id: d.id, created: false, decisionVersion: d.decisionVersion, status: d.status as CreateOutcome["status"], sizingStatus: result.status, reasonCode: result.reasonCode, quantity: result.quantity, maxLossAmount: result.maxLossAmount });
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
    throw new RiskDecisionError("not_latest_version", "only the latest version of a decision can be sized", prev.supersededById);
  }
  if (carries(prev)) return outcomeOf(prev);
  if (!evidence) throw new RiskDecisionError("stop_loss_evidence_missing", "the stop-loss evidence for this decision no longer exists");

  const sized = result.status === "SIZED";
  const out = await supersedeRiskDecision(db, prev.id, {
    stopLossValidationId: evidence.id,
    status: sized ? "PENDING" : "REJECTED",
    idempotencyKey: `risk-sizing:${prev.id}:${result.inputHash.slice(0, 32)}`,
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
    sourceTrustTier: prev.sourceTrustTier,
    decisionReasonCode: sized ? "sized_awaiting_limits" : `sizing_${result.reasonCode}`.slice(0, 60),
    decisionReason: sized ? `${result.explanation} Awaiting the remaining risk gates (portfolio limits, circuit breakers, market checks), which are not part of this stage.` : result.explanation,
    inputSnapshot: { sizing: result.snapshot, previousDecisionId: prev.id, previousVersion: prev.decisionVersion, base: prev.inputSnapshot },
    outputSnapshot: {
      stage: "position_sizing",
      sized,
      limitsApplied: false,
      sizing: { engineVersion: SIZING_ENGINE_VERSION, status: result.status, reasonCode: result.reasonCode, inputHash: result.inputHash, quantity: result.quantity, notional: result.notional, maxLossAmount: result.maxLossAmount, maxLossPercent: result.maxLossPercent, riskPerUnit: result.riskPerUnit, riskRewardRatio: result.riskRewardRatio, appliedTier: result.appliedTier },
    },
    evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id, sizingInputHash: result.inputHash },
  });
  return { ...out, sizingStatus: result.status, reasonCode: result.reasonCode, quantity: result.quantity, maxLossAmount: result.maxLossAmount };
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
