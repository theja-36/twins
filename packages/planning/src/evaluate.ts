import { getLatestResearchPackage, getEffectiveCapitalProfile, getEffectiveRiskPolicy, listActiveControls, storeConfidenceAssessment, persistEvaluation, hasRecentRiskAssessment, latestCalibrationRun, type Db, type StoredCandidate } from "@twins/database";
import type { RegimeProvider, ResearchPackage } from "@twins/agents";
import { scoreConfidence, CONFIDENCE_MODEL_VERSION, type RegimeEvidence, type StrategyEvidence } from "@twins/confidence";
import { assessLiquidity, type LiquidityQuote } from "@twins/risk";
import { assessRisk, preflightRisk, DEFAULT_RISK_EXTRAS, type PortfolioState, type RiskExtras, type RiskDecision, type RiskPolicyLimits } from "./risk";
import { sizePosition, type SizingResultV2 } from "./sizing";
import { simulate, SIMULATOR_VERSION, type SimulationReport } from "./simulator";
import { COST_MODEL_VERSION } from "./costs";
import type { SpecProvider } from "./specs";

/**
 * The common evaluation path for ONE candidate and ONE account: strength score (shared) -> capital + risk policy -> preflight risk -> position size -> risk decision -> what-if simulation -> persisted.
 * Both pipelines' candidates (TELEGRAM and INDEPENDENT) enter here identically. It records evidence for the decision engine; it places nothing, approves nothing and cannot enable trading.
 * Everything it does not have (specifications, regime, portfolio, quote, strategy performance) is passed as an injectable provider; an absent provider makes the corresponding input missing, and missing inputs block or restrict.
 */
export interface PortfolioProvider { readonly name: string; portfolioFor(q: { userId: string; accountId: string; now: Date }): Promise<PortfolioState | null> }
export interface QuoteProvider { readonly name: string; quoteFor(q: { underlying: string; now: Date }): Promise<LiquidityQuote | null> }
export interface StrategyProvider { readonly name: string; strategyFor(q: { setup: string | null; now: Date }): Promise<StrategyEvidence | null> }
export interface EvaluationDeps {
  db: Db; specs: SpecProvider | null; regime: RegimeProvider | null; portfolio: PortfolioProvider | null; quotes: QuoteProvider | null; strategy: StrategyProvider | null;
  extras?: RiskExtras; slippageBps?: { entry: number; exit: number }; now?: () => Date; reevaluateMinutes?: number; log?: (event: string, fields: Record<string, unknown>) => void;
}
export const DEFAULT_SLIPPAGE_BPS = { entry: 5, exit: 5 } as const; // an ASSUMPTION, recorded in every plan; not a measured value
export type EvaluationOutcome =
  | { status: "NOT_CONFIGURED"; reason: "NO_CAPITAL_PROFILE" | "NO_RISK_POLICY" }
  | { status: "RECENT"; reason: "ALREADY_EVALUATED" }
  | { status: "EVALUATED"; verdict: RiskDecision["verdict"]; riskAssessmentId: string; simulationId: string; confidenceAssessmentId: string; sizing: SizingResultV2; risk: RiskDecision; confidenceScore: number };

export interface Computed {
  now: Date; cap: NonNullable<Awaited<ReturnType<typeof getEffectiveCapitalProfile>>>; pol: NonNullable<Awaited<ReturnType<typeof getEffectiveRiskPolicy>>>; stored: Awaited<ReturnType<typeof getLatestResearchPackage>>;
  conf: ReturnType<typeof scoreConfidence>; calib: Awaited<ReturnType<typeof latestCalibrationRun>>; sizing: SizingResultV2; risk: RiskDecision; report: SimulationReport; regimeObj: Awaited<ReturnType<RegimeProvider["regimeFor"]>>;
}
export type ComputeOutcome = { status: "NOT_CONFIGURED"; reason: "NO_CAPITAL_PROFILE" | "NO_RISK_POLICY" } | { status: "COMPUTED"; computed: Computed };
/**
 * Everything the evaluation derives, WITHOUT writing anything: the decision engine's approval / execution revalidation calls this to get a fresh, current answer from the same code that produced the stored assessment.
 */
export async function computeEvaluation(d: EvaluationDeps, o: { userId: string; accountId: string; candidate: StoredCandidate }): Promise<ComputeOutcome> {
  const now = (d.now ?? (() => new Date()))(), X = d.extras ?? DEFAULT_RISK_EXTRAS, c = o.candidate;
  const cap = await getEffectiveCapitalProfile(d.db, o.userId, o.accountId, now);
  if (!cap) return { status: "NOT_CONFIGURED", reason: "NO_CAPITAL_PROFILE" };
  const pol = await getEffectiveRiskPolicy(d.db, o.userId, o.accountId, now);
  if (!pol) return { status: "NOT_CONFIGURED", reason: "NO_RISK_POLICY" };
  const stored = await getLatestResearchPackage(d.db, c.id);
  // 1. strength (shared across users: it depends on the candidate and its research, not on a user)
  const research = (stored?.agentResults ?? null) as ResearchPackage | null;
  let regimeObj: Awaited<ReturnType<RegimeProvider["regimeFor"]>> = null;
  if (d.regime) { try { regimeObj = await d.regime.regimeFor(c.underlying, now); } catch { regimeObj = null; } }
  let strategy: StrategyEvidence | null = null;
  if (d.strategy) { try { strategy = await d.strategy.strategyFor({ setup: c.setup, now }); } catch { strategy = null; } }
  const regimeEv: RegimeEvidence | null = regimeObj ? { underlying: regimeObj.underlying, version: regimeObj.version, asOf: regimeObj.asOf, direction: regimeObj.direction, regime: regimeObj.regime, volatilityRegime: regimeObj.volatilityRegime, eventRisk: regimeObj.eventRisk, riskOff: regimeObj.riskOff, dataSource: regimeObj.dataSource, freshness: { stale: regimeObj.freshness.stale } } : null;
  const conf = scoreConfidence({ candidate: { id: c.id, side: c.side, dataSource: c.dataSource, rankScore: c.rankScore }, research, regime: regimeEv, strategy });
  const calib = await latestCalibrationRun(d.db, CONFIDENCE_MODEL_VERSION);

  // 2. inputs
  const isOption = c.strike !== null && c.optionType !== null;
  const instrumentType: "option" | "equity" = isOption ? "option" : "equity";
  const spec = d.specs ? await d.specs.instrument({ exchange: c.exchange, underlying: c.underlying, instrumentType, at: now }).catch(() => null) : null;
  const fees = spec && d.specs ? await d.specs.fees({ segment: spec.segment, at: now }).catch(() => null) : null;
  const portfolio = d.portfolio ? await d.portfolio.portfolioFor({ userId: o.userId, accountId: o.accountId, now }).catch(() => null) : null;
  const quote = d.quotes ? await d.quotes.quoteFor({ underlying: c.underlying, now }).catch(() => null) : null;
  const controls = (await listActiveControls(d.db, o.userId, now)).map((k) => ({ scope: k.scope, scopeKey: k.scopeKey, kind: k.kind, reason: k.reason, setAt: k.setAt, expiresAt: k.expiresAt, id: k.id }));
  const entry = c.entryLow !== null && c.entryHigh !== null ? (c.entryLow + c.entryHigh) / 2 : c.entryLow ?? c.entryHigh;
  const limits: RiskPolicyLimits = { policyVersion: pol.version, riskPercent: pol.riskPercent, maxRiskPerTrade: pol.maxRiskPerTrade, maxDailyLoss: pol.maxDailyLoss, maxConcurrentPositions: pol.maxConcurrentPositions, maxLots: pol.maxLots, minRewardToRisk: pol.minRewardToRisk, allowedUnderlyings: pol.allowedUnderlyings, maxDrawdownPct: pol.maxDrawdownPct, maxPortfolioExposurePct: pol.maxPortfolioExposurePct, maxCorrelatedRiskPct: pol.maxCorrelatedRiskPct, maxPositionNotionalPct: cap.maxPositionNotionalPct };
  const stopBasis = (c as StoredCandidate & { stopBasis?: string }).stopBasis ?? (isOption ? "premium" : "price");
  const ctx = { now, userId: o.userId, limits, extras: X, capital: { total: cap.totalCapital, available: cap.availableCapital }, spec, fees, portfolio, regime: regimeObj, liquidityQuoteAvailable: quote !== null, controls, evidence: [`research_package:${stored?.id ?? "none"}`, `capital_profile:v${cap.version}`, `risk_policy:v${pol.version}`],
    candidate: { id: c.id, source: c.source, underlying: c.underlying, exchange: c.exchange, side: c.side, instrumentType, entry, stop: c.stopLoss, stopBasis, targets: c.targets, expiry: c.expiry, setup: c.setup } };
  const pre = preflightRisk(ctx);
  const slip = d.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const sizingInput = { side: c.side, entry: entry ?? 0, stop: c.stopLoss, stopBasis, targets: c.targets, spec, fees, capital: { total: cap.totalCapital, available: cap.availableCapital }, caps: pre.caps, sizeMultiplier: pre.sizeMultiplier, slippageBps: slip };
  const policy = { riskPercent: pol.riskPercent, maxRiskPerTrade: pol.maxRiskPerTrade, maxLots: pol.maxLots, maxPositionNotionalPct: cap.maxPositionNotionalPct };
  const sizing = sizePosition({ ...sizingInput, entry: entry === null ? "0" : entry, policy });
  const liq = sizing.status === "SIZED" && quote ? assessLiquidity(sizing.quantity, quote) : null;
  const risk = assessRisk(ctx, pre, sizing, liq);

  // 3. what-if (informational)
  const report: SimulationReport = simulate({ base: { ...sizingInput, entry: entry === null ? "0" : entry }, policy, underlying: c.underlying, portfolio, groupOf: (u) => Object.entries(X.correlationGroups).find(([, m]) => m.includes(u))?.[0] ?? null, extras: X, scenarios: [{ id: "BASE", label: "As evaluated" }, { id: "HALF_RISK", label: "Half the policy risk", riskPercent: String(Number(pol.riskPercent) / 2) }, { id: "ONE_LOT", label: "A single lot", lots: 1 }] });

  return { status: "COMPUTED", computed: { now, cap, pol, stored, conf, calib, sizing, risk, report, regimeObj } };
}

export async function evaluateCandidateForAccount(d: EvaluationDeps, o: { userId: string; accountId: string; candidate: StoredCandidate }): Promise<EvaluationOutcome> {
  const c = o.candidate;
  const out = await computeEvaluation(d, o);
  if (out.status === "NOT_CONFIGURED") return out;
  const { cap, pol, stored, conf, calib, sizing, risk, report } = out.computed;
  if (await hasRecentRiskAssessment(d.db, o.userId, o.accountId, c.id, stored?.id ?? null, d.reevaluateMinutes ?? 15)) return { status: "RECENT", reason: "ALREADY_EVALUATED" };
  const confRow = await storeConfidenceAssessment(d.db, { candidateId: c.id, score: conf.score, components: { components: conf.components, caps: conf.caps, completeness: conf.completeness, uncappedScore: conf.uncappedScore, band: conf.band, provenance: conf.provenance, inputSha256: conf.inputSha256, calibrationRun: calib ? { id: calib.id, status: calib.status } : null, strengthOnly: true, winProbability: null }, supporting: conf.supporting, contradicting: conf.contradicting, missing: conf.missing, riskFlags: conf.riskFlags, historicalComparison: null, explanation: conf.explanation, calibrationStatus: "UNCALIBRATED", modelVersion: conf.modelVersion });
  // 4. persist (append-only)
  const persisted = await persistEvaluation(d.db, o.userId, { withinMinutes: d.reevaluateMinutes ?? 15, risk: { accountId: o.accountId, candidateId: c.id, policyVersion: pol.version, verdict: risk.verdict, blockers: risk.reasons.filter((r) => r.severity === "BLOCK").map((r) => ({ code: r.code, detail: r.detail })), result: { risk, sizing, capitalProfileVersion: cap.version, confidence: { id: confRow.id, score: conf.score, band: conf.band, calibrationStatus: "UNCALIBRATED", note: "strength only; not an input to any limit" } }, researchPackageId: stored?.id ?? null }, simulation: { params: { ...report.inputsEcho, assumptions: report.assumptions, limitations: report.limitations, versions: report.versions, simulatorVersion: SIMULATOR_VERSION }, scenarios: { scenarios: report.scenarios, riskScenarios: report.riskScenarios, portfolioImpact: report.portfolioImpact, simultaneous: report.simultaneous }, costModelVersion: COST_MODEL_VERSION } });
  if (!persisted.created) return { status: "RECENT", reason: "ALREADY_EVALUATED" };
  const assessmentId = persisted.riskAssessmentId, simId = persisted.simulationId;
  d.log?.("planning.evaluated", { candidateId: c.id, verdict: risk.verdict, sized: sizing.status });
  return { status: "EVALUATED", verdict: risk.verdict, riskAssessmentId: assessmentId, simulationId: simId, confidenceAssessmentId: confRow.id, sizing, risk, confidenceScore: conf.score };
}
