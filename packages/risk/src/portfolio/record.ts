import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { getRiskDecision, refuseUnlessSafe, RiskDecisionError, supersedeRiskDecision, type CreateOutcome, type RiskDecisionRecord } from "../riskDecisions";
import { SIZING_ACTOR } from "../sizing/record";
import { loadPortfolioConfig, type PortfolioConfig } from "./config";
import { evaluatePortfolio, hashPortfolioInput, PORTFOLIO_ENGINE_VERSION, type ExposureInput, type PortfolioResult } from "./engine";

/**
 * Records a portfolio evaluation on a sized risk decision (Stage 3 / Task 3). Append-only: the evaluation is a NEW version that supersedes the sized one
 * (APPROVED_FOR_REVIEW if every limit passes, otherwise REJECTED with the machine-readable reason), carrying the evaluated limits, current / proposed /
 * resulting exposure and the pass/fail reason. Nothing here places an order, calls a broker, sends an approval card or creates executable state.
 * Evaluations are serialized by a transaction-scoped advisory lock so two candidates cannot both pass against the same headroom.
 */
export const PORTFOLIO_ACTOR = "service:portfolio-risk";
const LOCK_KEY = 1953721;

/** Interface for the future open-position records (no position store exists yet). */
export interface OpenPositionSource {
  listOpenExposures(): Promise<ExposureInput[]>;
}
export const noOpenPositions: OpenPositionSource = { listOpenExposures: async () => [] };

export interface PortfolioOptions {
  config?: PortfolioConfig;
  /** Overrides the capital the candidate was sized with. */
  capital?: number | null;
  openPositions?: OpenPositionSource;
}

export interface PortfolioRecordOutcome extends CreateOutcome {
  portfolioOutcome: "APPROVED_FOR_REVIEW" | "REJECTED";
  reasonCode: string | null;
}

const asNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const isPortfolioRevision = (d: RiskDecisionRecord): boolean => d.createdBy === PORTFOLIO_ACTOR;
type Snap = { sizing?: { input?: { capital?: unknown } }; base?: Snap; portfolio?: { inputHash?: string; capital?: unknown } } | null;

function sizedOk(d: RiskDecisionRecord): boolean {
  const out = d.outputSnapshot as { sizing?: { status?: string } } | null;
  return out?.sizing?.status === "SIZED" && (asNum(d.plannedMaxLossAmount) ?? 0) > 0 && (asNum(d.plannedQuantity) ?? 0) > 0;
}
function capitalOf(d: RiskDecisionRecord): number | null {
  const out = d.outputSnapshot as Snap;
  const inp = d.inputSnapshot as Snap;
  return asNum(inp?.sizing?.input?.capital) ?? asNum(inp?.base?.sizing?.input?.capital) ?? asNum(out?.portfolio?.capital);
}

async function activeExposures(db: Db, candidate: RiskDecisionRecord): Promise<ExposureInput[]> {
  const subject = candidate.signalId ? sql`signal_id is distinct from ${candidate.signalId}` : sql`options_claim_id is distinct from ${candidate.optionsClaimId}`;
  const r = await db.execute(sql`select id, planned_max_loss_amount, market, instrument_type, symbol, side, expiry from risk_decisions_effective
    where superseded_by_id is null and status in ('PENDING', 'APPROVED_FOR_REVIEW') and planned_max_loss_amount > 0 and ${subject} order by chain_index`);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row["id"]), source: "risk_decision" as const, maxLossAmount: Number(row["planned_max_loss_amount"]), market: row["market"] === null ? null : String(row["market"]),
    instrumentType: String(row["instrument_type"]), underlying: String(row["symbol"]), side: row["side"] === null ? null : String(row["side"]),
    expiry: row["expiry"] ? new Date(row["expiry"] as string).toISOString().slice(0, 10) : null,
  }));
}

const candidateOf = (d: RiskDecisionRecord): ExposureInput => ({
  id: d.id, source: "risk_decision", maxLossAmount: asNum(d.plannedMaxLossAmount) ?? 0, market: d.market, instrumentType: d.instrumentType, underlying: d.symbol, side: d.side, expiry: d.expiry,
});

/** Evaluates the portfolio limits for the CURRENT version `decisionId` and appends the resulting version. Idempotent for identical inputs. */
export async function evaluatePortfolioRisk(db: Db, decisionId: string, opts: PortfolioOptions = {}): Promise<PortfolioRecordOutcome> {
  await refuseUnlessSafe("risk_decision.portfolio"); // fail closed before anything is read or written
  const config = opts.config ?? loadPortfolioConfig();
  const positions = opts.openPositions ?? noOpenPositions;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY}, hashtext('risk_portfolio'))`);
    const prev = await getRiskDecision(tx, decisionId);
    if (!prev) throw new RiskDecisionError("not_found", "the risk decision does not exist");
    const evaluable = (prev.status === "PENDING" && prev.createdBy === SIZING_ACTOR) || (isPortfolioRevision(prev) && (prev.status === "REJECTED" || prev.status === "APPROVED_FOR_REVIEW"));
    if (!evaluable) {
      if (prev.status === "PENDING") throw new RiskDecisionError("sizing_missing", "the decision has not been sized; the portfolio is not evaluated");
      throw new RiskDecisionError("not_evaluable", `a ${prev.status} decision is not evaluated`);
    }
    if (!sizedOk(prev)) throw new RiskDecisionError("sizing_missing", "the decision carries no valid SIZED position size; the portfolio is not evaluated");
    const subjectWhere = prev.signalId ? eq(schema.stopLossValidations.signalId, prev.signalId) : eq(schema.stopLossValidations.optionsClaimId, prev.optionsClaimId as string);
    const [evidence] = await tx.select().from(schema.stopLossValidations).where(subjectWhere).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
    if (!evidence) throw new RiskDecisionError("stop_loss_evidence_missing", "the stop-loss evidence for this decision no longer exists");
    if (evidence.result !== "VALID") throw new RiskDecisionError("stop_loss_not_valid", `the latest stop-loss validation is ${evidence.result}; the portfolio is not evaluated`);

    const capital = opts.capital === undefined ? capitalOf(prev) : opts.capital;
    const candidate = candidateOf(prev);
    const active = [...(await activeExposures(tx, prev)), ...(await positions.listOpenExposures())];
    const result = evaluatePortfolio({ capital, candidate, active, config });
    if (result.outcome === "INVALID_INPUT") {
      throw new RiskDecisionError(result.reasonCode === "portfolio_sizing_missing" ? "sizing_missing" : "invalid_input", result.explanation);
    }
    const hash = hashPortfolioInput(capital, candidate, active, config);

    const outcomeOf = (d: RiskDecisionRecord): PortfolioRecordOutcome => ({ id: d.id, created: false, decisionVersion: d.decisionVersion, status: d.status as CreateOutcome["status"], portfolioOutcome: result.outcome as "APPROVED_FOR_REVIEW" | "REJECTED", reasonCode: result.reasonCode });
    const carries = (d: RiskDecisionRecord): boolean => isPortfolioRevision(d) && (d.outputSnapshot as Snap)?.portfolio?.inputHash === hash;
    if (prev.supersededById) {
      const successor = await getRiskDecision(tx, prev.supersededById);
      if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
      throw new RiskDecisionError("not_latest_version", "only the latest version of a decision can be evaluated", prev.supersededById);
    }
    if (carries(prev)) return outcomeOf(prev);

    return recordResult(tx, prev, evidence.id, evidence.levelBasis, result, capital as number, hash, active);
  });
}

async function recordResult(tx: Db, prev: RiskDecisionRecord, evidenceId: string, levelBasis: string | null, result: PortfolioResult, capital: number, hash: string, active: ExposureInput[]): Promise<PortfolioRecordOutcome> {
  const approved = result.outcome === "APPROVED_FOR_REVIEW";
  const base = isPortfolioRevision(prev) ? ((prev.inputSnapshot as Snap)?.base ?? prev.inputSnapshot) : prev.inputSnapshot;
  const out = await supersedeRiskDecision(tx, prev.id, {
    stopLossValidationId: evidenceId,
    status: approved ? "APPROVED_FOR_REVIEW" : "REJECTED",
    idempotencyKey: `risk-portfolio:${prev.id}:${hash.slice(0, 32)}`,
    createdBy: PORTFOLIO_ACTOR,
    instrumentType: prev.instrumentType,
    market: prev.market,
    symbol: prev.symbol,
    expiry: prev.expiry,
    strike: asNum(prev.strike),
    optionType: prev.optionType,
    side: prev.side,
    entryPrice: asNum(prev.entryPrice),
    stopLoss: asNum(prev.stopLoss),
    stopLossBasis: prev.stopLossBasis ?? levelBasis,
    target1: asNum(prev.target1),
    target2: asNum(prev.target2),
    target3: asNum(prev.target3),
    plannedQuantity: asNum(prev.plannedQuantity),
    plannedNotional: asNum(prev.plannedNotional),
    plannedMaxLossAmount: asNum(prev.plannedMaxLossAmount),
    plannedMaxLossPercent: asNum(prev.plannedMaxLossPercent),
    confidenceScore: asNum(prev.confidenceScore),
    sourceTrustTier: prev.sourceTrustTier,
    decisionReasonCode: approved ? "portfolio_within_limits" : `portfolio_${String(result.reasonCode).toLowerCase()}`.slice(0, 60),
    decisionReason: approved ? `${result.explanation} Approved for review only: further risk gates (circuit breakers, market checks) are not part of this stage.` : result.explanation,
    inputSnapshot: { portfolio: result.snapshot, previousDecisionId: prev.id, previousVersion: prev.decisionVersion, base },
    outputSnapshot: { ...((prev.outputSnapshot as Record<string, unknown> | null) ?? {}), stage: "portfolio_risk", limitsApplied: true, portfolio: { ...result.snapshot, engineVersion: PORTFOLIO_ENGINE_VERSION, capital } },
    evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id, portfolioInputHash: hash, activeExposureIds: active.map((a) => a.id) },
  });
  return { ...out, portfolioOutcome: result.outcome as "APPROVED_FOR_REVIEW" | "REJECTED", reasonCode: result.reasonCode };
}
