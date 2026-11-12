/**
 * Stage 09.3B.2: relay response schemas for the 11 analytics routes the Learning & Insights page uses. Built on the strict schemas proven in 09.3B.1 (schemas.verified093b.ts).
 * Rules: undeclared fields are stripped; money stays an exact decimal STRING; null stays null (never 0); inner shapes that no test proved are `unknown` and rendered as safe text only.
 * Every schema is validated against a REAL sample of backend output (src/test + e2e/fixtures/analytics.sample.json, produced by the real engines in Postgres) in schemas.insights.test.ts.
 * Narrowed responses (`dataset`, `dimension`) are accepted: those members are optional.
 */
import { z } from "zod";
import { AnalyticsEnvelope, InsightRow, PerformanceMetrics } from "./schemas.verified093b";

const txt = (n = 400) => z.string().max(n), ts = z.string().max(40), count = z.number(), counts = z.record(z.string(), z.number());
const Slice = z.object({ key: txt(120), metrics: PerformanceMetrics });
const NotAvailable = z.object({ status: z.literal("NOT_AVAILABLE"), reason: txt(600), dependsOn: txt(120) });
/** A strategy dimension is a list of slices, or an explicit NOT_AVAILABLE object (the signal-pattern view today). */
const SliceList = z.union([z.array(Slice).max(500), NotAvailable]);
export const DecisionCounts = z.object({ total: count, approved: count, byOutcome: counts, qualified: count, invalidated: count, withPosition: count, expiredOrCancelled: count });
const Rate = z.object({ value: z.number().nullable(), numerator: count, denominator: count });

export const OverviewDataRelay = z.object({ all: PerformanceMetrics.optional(), validatedOnly: PerformanceMetrics.optional(), fixtureOnly: PerformanceMetrics.optional() });
export const STRATEGY_DIMENSION_FIELDS = ["byStrategy", "byVersion", "byInstrument", "byTimeframe", "byRegime", "bySignalType", "bySignalPattern", "byExitReason", "byStopBehaviour", "byTargetBehaviour", "byStopMoved", "byConfidenceBand", "byRiskVerdict", "byPlannedRewardToRisk", "byDecisionOutcome"] as const;
export const StrategiesData = z.object(Object.fromEntries(STRATEGY_DIMENSION_FIELDS.map((k) => [k, SliceList.optional()])) as Record<(typeof STRATEGY_DIMENSION_FIELDS)[number], z.ZodOptional<typeof SliceList>>);
/** `channels` rows are unverified (empty in every test dataset): passed as data, displayed as safe text only. */
export const ChannelsData = z.object({ source: txt(20), note: txt(800), channels: z.array(z.unknown()).max(200), decisions: DecisionCounts, candidates: count, unavailable: z.array(txt(500)).max(30) });
export const IndependentData = z.object({
  source: txt(20), note: txt(800), scans: count, generated: count, researched: count, rates: z.record(z.string(), Rate), reasons: counts, decisions: DecisionCounts,
  outcomes: z.object({ total: PerformanceMetrics, byOpportunityType: z.array(Slice).max(200) }).nullable(),
});
export const AgentsData = z.object({
  version: txt(40), packages: count, assessments: counts,
  agents: z.array(z.object({ agentId: txt(80), packages: count, participation: count, completed: count, unavailable: count, availabilityRate: z.number().nullable(), riskFlagRate: z.number().nullable(), verdicts: counts, versions: counts, outcomeAssociation: z.array(z.unknown()).max(50), associationNote: txt(800) })).max(100),
  agreement: z.object({ packagesWithTwoOrMoreVerdicts: count, unanimous: count, disagreement: count, withContradictions: count, rate: z.object({ unanimous: z.number().nullable(), contradictions: z.number().nullable() }) }),
  evidenceGaps: z.object({ packagesMissingRequiredAgents: count, missingRate: z.number().nullable(), byAgent: z.record(z.string(), z.unknown()) }),
});
/** `estimate` counts how often price reached a level first on later bars; an unexecuted decision has no P&L. Kept as a flat text/number record. */
const Estimate = z.record(z.string(), z.union([z.number(), z.string()]));
export const DecisionsData = z.object({
  version: txt(40), decisions: DecisionCounts, executed: z.object({ qualifiedExecuted: count, metrics: PerformanceMetrics.nullable() }),
  notExecuted: z.array(z.object({ outcome: txt(60), count, estimate: Estimate })).max(50), limitations: z.array(txt(500)).max(30),
});
const DriftReport = z.object({ status: txt(40), note: txt(600), version: txt(60), z: z.number().nullable(), avgRDelta: z.number().nullable(), winRateDelta: z.number().nullable(), recent: z.unknown(), baseline: z.unknown() });
const DriftFinding = z.object({ subjectKind: txt(40), subject: txt(200), n: count, warn: z.boolean(), reliability: txt(40), report: DriftReport });
const Shift = z.object({ status: txt(40), recentN: count, baselineN: count, totalVariationDistance: z.number().nullable() });
export const DriftData = z.object({ findings: z.array(DriftFinding).max(500), warnings: z.array(DriftFinding).max(500), insufficient: count, shifts: z.object({ dataQuality: Shift, agentVerdicts: Shift, decisionOutcomes: Shift }) });
export const DataQualityData = z.object({
  version: txt(40), records: count, final: count, partial: count, correctedVersions: count, fixtureBacked: count, fixtureShare: z.number().nullable(), codes: counts, missingFields: counts,
  warnings: z.array(txt(600)).max(50), validatedDataset: z.object({ note: txt(600), eligible: count }),
});
export const CalibrationData = z.object({ status: txt(40), reasons: z.array(txt(500)).max(30), fitSize: z.number().nullable(), holdoutSize: z.number().nullable(), excluded: counts, note: txt(800) });
/** One outcome row as the page shows it. Position and decision ids are not declared (not displayed), so they are stripped. `dataQuality` and `missing` are unknown and rendered only when they are lists of short strings. */
export const OutcomeRow = z.object({
  id: z.string().max(64), version: count, finality: z.enum(["PARTIAL", "FINAL"]), mode: txt(20), dataSource: txt(20), candidateSource: txt(20), setup: txt(80).nullable(), instrument: txt(80), side: txt(8),
  grossPnl: z.string().nullable(), costs: z.string().nullable(), netPnl: z.string().nullable(), rMultiple: z.string().nullable(), holdingSeconds: z.number().nullable(), exitReason: txt(60).nullable(), closedAt: ts.nullable(),
  dataQuality: z.unknown(), missing: z.unknown(), correctionReason: txt(300).nullable(),
});

export const ANALYTICS_RELAY_SCHEMAS = {
  "analytics.overview": AnalyticsEnvelope(OverviewDataRelay), "analytics.strategies": AnalyticsEnvelope(StrategiesData), "analytics.channels": AnalyticsEnvelope(ChannelsData),
  "analytics.independent": AnalyticsEnvelope(IndependentData), "analytics.agents": AnalyticsEnvelope(AgentsData), "analytics.decisions": AnalyticsEnvelope(DecisionsData),
  "analytics.drift": AnalyticsEnvelope(DriftData), "analytics.data-quality": AnalyticsEnvelope(DataQualityData), "analytics.calibration": AnalyticsEnvelope(CalibrationData),
  "analytics.outcomes": AnalyticsEnvelope(z.array(OutcomeRow).max(200)), "analytics.insights": AnalyticsEnvelope(z.array(InsightRow).max(200)),
} as const;
export type AnalyticsRouteId = keyof typeof ANALYTICS_RELAY_SCHEMAS;
export type OverviewPayload = z.infer<typeof OverviewDataRelay>;
