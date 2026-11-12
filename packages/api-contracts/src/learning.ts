/**
 * Stage 09.3B.1: Stage 08 analytics payloads, verified against REAL output (real pipeline -> real paper trade -> real ingestion -> real snapshot -> real routes, Postgres).
 * Verified: the key sets below for every section, the Metric wrapper (`value`, `n`, `definition`), money as exact decimal STRINGS, ratios/intervals as JSON numbers, and the snapshot metadata.
 * NOT verified (explicitly unknown): the inner rows of sections that were EMPTY in the test data (channels list, byOpportunityType, notExecuted) and the numeric content of any figure.
 * Every figure here is paper/fixture evidence. Nothing in this file calculates, and nothing here can change a strategy, weight, limit, size, capital, approval or execution.
 */
import type { IsoTimestamp } from "./wire";

export const PERFORMANCE_METRICS_KEYS = ["version", "eligible", "reliability", "status", "wins", "losses", "breakeven", "winRate", "lossRate", "grossPnl", "costs", "netPnl", "avgWin", "avgLoss", "payoffRatio", "rMultiple", "expectancyR", "expectancyMoney", "profitFactor", "maxDrawdown", "maxDrawdownPct", "holdingSeconds", "costImpact", "slippage", "dataSources", "modes", "periodStart", "periodEnd"] as const;
/** `{ value, n, definition, note? }`: the backend states how each figure is defined. Show `definition` and `note` verbatim; `value` null means "not computed" and is NOT zero. */
export interface MetricView<T> { value: T | null; n: number; definition: string; note?: string }
export interface IntervalView { lower: number; upper: number }
export interface PerformanceMetricsView {
  version: string; eligible: number; reliability: string; status: "SUFFICIENT" | "INSUFFICIENT_DATA"; wins: number; losses: number; breakeven: number;
  winRate: MetricView<number> & { interval: IntervalView | null }; lossRate: MetricView<number> & { interval: IntervalView | null };
  /** Money fields are exact decimal strings: never convert them to numbers. */
  grossPnl: string; costs: string; netPnl: string; avgWin: MetricView<string>; avgLoss: MetricView<string>; payoffRatio: MetricView<number> & { exact: string | null };
  rMultiple: { n: number; mean: number | null; total: number | null; definition: string };
  expectancyR: MetricView<number> & { exact: string | null; interval95: IntervalView | null; intervalMethod: string; degreesOfFreedom: number | null };
  expectancyMoney: MetricView<string>; profitFactor: MetricView<number> & { exact: string | null; interval: null; intervalNote: string };
  maxDrawdown: MetricView<string> & { basis: string };
  /** Always NOT_AVAILABLE: a percentage drawdown needs an account equity curve, which is not recorded. */
  maxDrawdownPct: { value: null; status: "NOT_AVAILABLE"; reason: string; definition: string };
  holdingSeconds: { n: number; mean: number | null; min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null };
  costImpact: MetricView<number>; slippage: MetricView<string>; dataSources: Record<string, number>; modes: Record<string, number>; periodStart: IsoTimestamp | null; periodEnd: IsoTimestamp | null;
}
export interface SliceView { key: string; metrics: PerformanceMetricsView }
/** A section that the backend reports as not computable, with the reason and its dependency. */
export interface NotAvailableView { status: "NOT_AVAILABLE"; reason: string; dependsOn: string }

export const OVERVIEW_DATA_KEYS = ["all", "validatedOnly", "fixtureOnly"] as const;
export const STRATEGY_DATA_KEYS = ["byStrategy", "byVersion", "byInstrument", "byTimeframe", "byRegime", "bySignalType", "bySignalPattern", "byExitReason", "byStopBehaviour", "byTargetBehaviour", "byStopMoved", "byConfidenceBand", "byRiskVerdict", "byPlannedRewardToRisk", "byDecisionOutcome"] as const;
export const CHANNELS_DATA_KEYS = ["source", "note", "channels", "decisions", "candidates", "unavailable"] as const;
export const INDEPENDENT_DATA_KEYS = ["source", "note", "scans", "generated", "researched", "rates", "reasons", "outcomes", "decisions"] as const;
export const AGENTS_DATA_KEYS = ["version", "packages", "assessments", "agents", "agreement", "evidenceGaps"] as const;
export const DECISIONS_DATA_KEYS = ["version", "decisions", "executed", "notExecuted", "limitations"] as const;
export const DRIFT_DATA_KEYS = ["findings", "warnings", "insufficient", "shifts"] as const;
export const DATA_QUALITY_DATA_KEYS = ["version", "records", "final", "partial", "correctedVersions", "fixtureBacked", "fixtureShare", "codes", "missingFields", "warnings", "validatedDataset"] as const;
export const CALIBRATION_DATA_KEYS = ["status", "reasons", "fitSize", "holdoutSize", "excluded", "note"] as const;
export const DECISION_COUNTS_KEYS = ["total", "approved", "byOutcome", "qualified", "invalidated", "withPosition", "expiredOrCancelled"] as const;
export const AGENT_ANALYTICS_ROW_KEYS = ["agentId", "packages", "participation", "completed", "unavailable", "availabilityRate", "riskFlagRate", "verdicts", "versions", "outcomeAssociation", "associationNote"] as const;
export const DRIFT_FINDING_KEYS = ["subjectKind", "subject", "n", "warn", "reliability", "report"] as const;
export const DRIFT_SHIFT_KEYS = ["status", "recentN", "baselineN", "totalVariationDistance"] as const;

export const SNAPSHOT_META_KEYS = ["id", "asOf", "createdAt", "verifiedAt", "evidenceHash", "inputHash", "configHash", "algorithmVersions", "createdBy", "freshness", "staleReason", "complete", "maxAgeSeconds"] as const;
export const OUTCOME_ROW_KEYS = ["id", "paperPositionId", "decisionId", "version", "finality", "mode", "dataSource", "candidateSource", "setup", "instrument", "side", "grossPnl", "costs", "netPnl", "rMultiple", "holdingSeconds", "exitReason", "closedAt", "dataQuality", "missing", "correctionReason"] as const;
/** The only recommendation an insight may carry: a human REVIEW. There is no other value and no action. */
export const INSIGHT_RECOMMENDATION_REVIEW = "REVIEW" as const;
/** One stored insight (learning_insights row), as GET /analytics/insights returns it. `provenance`, `evidenceRefs` and `metrics` are typed unknown: their inner shapes vary by insight kind and are not verified. */
export const INSIGHT_ROW_KEYS = ["id", "insightKey", "kind", "scope", "subject", "outcomeCount", "periodStart", "periodEnd", "provenance", "method", "algorithmVersion", "evidenceRefs", "reliability", "severity", "statement", "metrics", "limitations", "recommendation", "createdAt"] as const;

/** The insight kinds the DATABASE accepts (check constraint `learning_insights_kind_check`, mirrored from INSIGHT_KINDS; proven equal by a unit parity test). Real runs produce only some of them: absence of a kind is not an error. */
export const INSIGHT_KINDS = ["PERFORMANCE", "STRATEGY", "CHANNEL", "PATTERN", "REGIME", "AGENT", "DECISION_QUALITY", "RISK_EXECUTION", "DRIFT", "DATA_QUALITY", "CALIBRATION", "RESEARCH_AREA"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
