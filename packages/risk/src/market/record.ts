import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { breakerGate, type BreakerOptions } from "../breakers/record";
import { loadExpiryConfig } from "../expiry/config";
import { databaseNow, isStale } from "../expiry/record";
import { PORTFOLIO_ACTOR } from "../portfolio/record";
import { getRiskDecision, refuseUnlessSafe, RiskDecisionError, supersedeRiskDecision, type CreateOutcome, type RiskDecisionRecord } from "../riskDecisions";
import { loadMarketRiskConfig, type MarketRiskConfig } from "./config";
import { evaluateMarketGates, kindOf, MARKET_ENGINE_VERSION, type EventWindowSource, type MarketDataProvider, type MarketGateResult, type MarketReason, type MarketSnapshot } from "./engine";
import { emptyHolidayCalendar, type HolidayCalendar } from "./sessions";
import { databaseEventWindows } from "./windows";

/**
 * Records the market-risk evaluation on a sized, portfolio-passed risk decision (Stage 3 / Task 5). Append-only: the result is a NEW version that supersedes the
 * portfolio-passed one - APPROVED_FOR_REVIEW only if every market gate passes, REJECTED with the machine-readable reason otherwise, PENDING when only a WARNING event
 * window makes it conditional. It carries every gate result, the observed values, the thresholds and the input snapshot. Nothing here places an order, calls a
 * broker or sends an approval card. Required inputs (market data, event windows, breaker state, runtime state) that cannot be read FAIL CLOSED and write nothing.
 */
export const MARKET_ACTOR = "service:market-risk";

export interface MarketAlert { event: string; severity: "WARNING" | "CRITICAL"; code: string; summary: string; details: { reason: string; kind: string } }
export interface MarketOptions extends BreakerOptions {
  provider?: MarketDataProvider | undefined;
  windows?: EventWindowSource;
  holidays?: HolidayCalendar;
  config?: MarketRiskConfig;
  /** Evaluation time (session, expiry, staleness, blackout); default: the database clock. */
  now?: Date;
  capital?: number | null;
  /** Called for alert-worthy outcomes of the evaluation THIS call recorded (and for provider failures). */
  onMarketAlert?: (a: MarketAlert) => void;
}
export interface MarketRecordOutcome extends CreateOutcome { marketOutcome: "PASSED" | "REJECTED" | "CONDITIONAL"; reasonCode: string | null }

const asNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const isMarketRevision = (d: RiskDecisionRecord): boolean => d.createdBy === MARKET_ACTOR;
type Snap = { sizing?: { status?: string; input?: { capital?: unknown } }; portfolio?: { outcome?: string; capital?: unknown }; market?: { inputHash?: string }; base?: Snap } | null;

const portfolioPassed = (d: RiskDecisionRecord): boolean => (d.outputSnapshot as Snap)?.portfolio?.outcome === "APPROVED_FOR_REVIEW";
const sizedOk = (d: RiskDecisionRecord): boolean => (d.outputSnapshot as Snap)?.sizing?.status === "SIZED" && (asNum(d.plannedMaxLossAmount) ?? 0) > 0 && (asNum(d.plannedQuantity) ?? 0) > 0;
function capitalOf(d: RiskDecisionRecord): number | null {
  const out = d.outputSnapshot as Snap, inp = d.inputSnapshot as Snap;
  return asNum(out?.portfolio?.capital) ?? asNum(inp?.sizing?.input?.capital) ?? asNum(inp?.base?.sizing?.input?.capital);
}

const WARN_REASONS: Partial<Record<MarketReason, string>> = {
  STALE_MARKET_DATA: "Market data for a candidate decision is stale.",
  SPREAD_TOO_WIDE: "The bid/ask spread of a candidate decision is wider than allowed.",
  INSUFFICIENT_LIQUIDITY: "Displayed liquidity of a candidate decision is below the minimum.",
  EXPIRY_TOO_SOON: "A candidate decision is too close to contract expiry.",
  EXPIRY_DAY_RESTRICTION: "A candidate decision failed the stricter expiry-day rules.",
};
/** Fixed-template alerts. Normal rejections (closed market, holiday, blackout, breaker) are NOT alerted; no symbol, price, message or identity is included. */
export function marketAlerts(result: MarketGateResult, kind: string): MarketAlert[] {
  const seen = new Set<string>();
  const out: MarketAlert[] = [];
  for (const f of result.failures) {
    const summary = WARN_REASONS[f.reason];
    if (!summary || seen.has(f.reason)) continue;
    seen.add(f.reason);
    out.push({ event: "risk.market_gate.warning", severity: "WARNING", code: f.reason.toLowerCase(), summary, details: { reason: f.reason, kind } });
  }
  return out;
}
export const marketDataFailureAlert = (kind: string, severity: "WARNING" | "CRITICAL", reason: string): MarketAlert => ({
  event: "risk.market_gate.data_unavailable", severity, code: "market_data_unavailable",
  summary: severity === "CRITICAL" ? "The market-data provider failed; candidate decisions cannot be approved." : "The market-data provider returned no data; a candidate decision cannot be approved.", details: { reason, kind },
});

export async function evaluateMarketRisk(db: Db, decisionId: string, opts: MarketOptions = {}): Promise<MarketRecordOutcome> {
  await refuseUnlessSafe("risk_decision.market"); // fail closed before anything is read or written
  if (!opts.provider) throw new RiskDecisionError("market_data_unavailable", "no market-data provider is configured; nothing can be approved");
  const config = opts.config ?? loadMarketRiskConfig();
  const expiry = opts.expiry ?? loadExpiryConfig();
  const prev = await getRiskDecision(db, decisionId);
  if (!prev) throw new RiskDecisionError("not_found", "the risk decision does not exist");
  const evaluable = (prev.status === "PENDING" && prev.createdBy === PORTFOLIO_ACTOR && portfolioPassed(prev)) || (isMarketRevision(prev) && (prev.status === "PENDING" || prev.status === "REJECTED" || prev.status === "APPROVED_FOR_REVIEW"));
  if (!evaluable) {
    if (prev.status === "PENDING" && !sizedOk(prev)) throw new RiskDecisionError("sizing_missing", "the decision has not been sized; the market gates are not evaluated");
    if (prev.status === "PENDING") throw new RiskDecisionError("portfolio_missing", "the decision has not passed the portfolio limits; the market gates are not evaluated");
    throw new RiskDecisionError("not_evaluable", `a ${prev.status} decision is not evaluated`);
  }
  if (!sizedOk(prev)) throw new RiskDecisionError("sizing_missing", "the decision carries no valid SIZED position size; the market gates are not evaluated");
  const subjectWhere = prev.signalId ? eq(schema.stopLossValidations.signalId, prev.signalId) : eq(schema.stopLossValidations.optionsClaimId, prev.optionsClaimId as string);
  const [evidence] = await db.select().from(schema.stopLossValidations).where(subjectWhere).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  if (!evidence) throw new RiskDecisionError("stop_loss_evidence_missing", "the stop-loss evidence for this decision no longer exists");
  if (evidence.result !== "VALID") throw new RiskDecisionError("stop_loss_not_valid", `the latest stop-loss validation is ${evidence.result}; the market gates are not evaluated`);

  const now = opts.now ?? (await databaseNow(db));
  if (!prev.supersededById && isStale(prev, now, expiry)) throw new RiskDecisionError("decision_expired", "the decision is past its validity window; it is expired, not evaluated");
  const capital = opts.capital === undefined ? capitalOf(prev) : opts.capital;
  if (capital === null || !Number.isFinite(capital) || !(capital > 0)) throw new RiskDecisionError("invalid_input", "the capital the decision was sized with is unknown");
  const kind = kindOf(prev.instrumentType) ?? "unsupported";
  const market = (prev.market ?? "").toUpperCase();

  const gate = await breakerGate(db, capital, { ...opts, asOf: now, expiry });
  let windows;
  try {
    windows = await (opts.windows ?? databaseEventWindows(db)).listWindows({ market, symbol: prev.symbol, at: now });
  } catch (cause) {
    throw new RiskDecisionError("event_windows_unavailable", "the event blackout windows could not be read; the decision is not approved", undefined, cause);
  }
  let snapshot: MarketSnapshot | null;
  try {
    snapshot = await opts.provider.getSnapshot({ symbol: prev.symbol, market, instrumentType: prev.instrumentType, expiry: prev.expiry, strike: asNum(prev.strike), optionType: prev.optionType });
  } catch (cause) {
    opts.onMarketAlert?.(marketDataFailureAlert(kind, "CRITICAL", "MARKET_DATA_UNAVAILABLE"));
    throw new RiskDecisionError("market_data_unavailable", "the market-data provider failed; the decision is not approved", undefined, cause);
  }
  if (!snapshot) {
    opts.onMarketAlert?.(marketDataFailureAlert(kind, "WARNING", "MARKET_DATA_UNAVAILABLE"));
    throw new RiskDecisionError("market_data_unavailable", "no market data is available for the instrument; the decision is not approved");
  }

  const result = evaluateMarketGates({ now, market, instrumentType: prev.instrumentType, symbol: prev.symbol, expiry: prev.expiry, entryPrice: asNum(prev.entryPrice), snapshot, windows, circuitBreaker: { blocked: gate.blocked, blockedBy: gate.blockedBy } }, config, opts.holidays ?? emptyHolidayCalendar);
  const hash = result.inputHash;
  const outcomeOf = (d: RiskDecisionRecord): MarketRecordOutcome => ({ id: d.id, created: false, decisionVersion: d.decisionVersion, status: d.status as CreateOutcome["status"], marketOutcome: result.outcome, reasonCode: result.reasonCode });
  const carries = (d: RiskDecisionRecord): boolean => isMarketRevision(d) && (d.outputSnapshot as Snap)?.market?.inputHash === hash;
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
    throw new RiskDecisionError("not_latest_version", "only the latest version of a decision can be evaluated", prev.supersededById);
  }
  if (carries(prev)) return outcomeOf(prev);

  const status = result.outcome === "PASSED" ? "APPROVED_FOR_REVIEW" : result.outcome === "REJECTED" ? "REJECTED" : "PENDING";
  const base = isMarketRevision(prev) ? ((prev.inputSnapshot as Snap)?.base ?? prev.inputSnapshot) : prev.inputSnapshot;
  const append = () => supersedeRiskDecision(db, prev.id, {
    stopLossValidationId: evidence.id,
    status,
    idempotencyKey: `risk-market:${prev.id}:${hash.slice(0, 32)}`,
    createdBy: MARKET_ACTOR,
    instrumentType: prev.instrumentType, market: prev.market, symbol: prev.symbol, expiry: prev.expiry, strike: asNum(prev.strike), optionType: prev.optionType, side: prev.side,
    entryPrice: asNum(prev.entryPrice), stopLoss: asNum(prev.stopLoss), stopLossBasis: prev.stopLossBasis ?? evidence.levelBasis, target1: asNum(prev.target1), target2: asNum(prev.target2), target3: asNum(prev.target3),
    plannedQuantity: asNum(prev.plannedQuantity), plannedNotional: asNum(prev.plannedNotional), plannedMaxLossAmount: asNum(prev.plannedMaxLossAmount), plannedMaxLossPercent: asNum(prev.plannedMaxLossPercent),
    confidenceScore: asNum(prev.confidenceScore), sourceTrustTier: prev.sourceTrustTier,
    decisionReasonCode: result.outcome === "PASSED" ? "market_gates_passed" : result.outcome === "CONDITIONAL" ? "market_conditional_event_blackout_warning" : `market_${String(result.reasonCode).toLowerCase()}`,
    decisionReason: result.outcome === "PASSED" ? `${result.explanation} Approved for review only; this stage creates nothing executable.` : result.explanation,
    inputSnapshot: { market: result.snapshot, previousDecisionId: prev.id, previousVersion: prev.decisionVersion, base },
    outputSnapshot: { ...((prev.outputSnapshot as Record<string, unknown> | null) ?? {}), stage: "market_risk", market: { ...result.snapshot, engineVersion: MARKET_ENGINE_VERSION } },
    evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id, marketInputHash: hash, eventWindowIds: windows.map((w) => w.id) },
  });
  let out: CreateOutcome;
  try {
    out = await append();
  } catch (error) {
    // a concurrent evaluator appended the same successor first: that IS the idempotent result
    if (error instanceof RiskDecisionError && error.code === "not_latest_version") {
      const again = await getRiskDecision(db, prev.id);
      const successor = again?.supersededById ? await getRiskDecision(db, again.supersededById) : undefined;
      if (successor && !successor.supersededById && carries(successor)) return outcomeOf(successor);
    }
    throw error;
  }
  if (out.created) for (const a of marketAlerts(result, kind)) opts.onMarketAlert?.(a);
  return { ...out, marketOutcome: result.outcome, reasonCode: result.reasonCode };
}
