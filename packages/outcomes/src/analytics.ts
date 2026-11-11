import type { AttributionRow, DecisionRow } from "@twins/database";
import { analyzeAgents, type AgentAnalytics, type PackageReports } from "./agents";
import type { CalibrationOutcome } from "./calibration";
import { assessDecisionQuality, type DecisionQuality, type HypotheticalResult } from "./decisionQuality";
import { distributionShift, monitorPerformanceDrift, windowTallies, type DriftFinding, type Shift } from "./drift";
import { independentFunnel, telegramFunnel, type IndependentFunnel, type TelegramFunnel } from "./funnel";
import { computeMetrics, DIMENSIONS, isEligible, sliceBy, type PerformanceMetrics, type Slice } from "./metrics";

/**
 * The analytics report (the single pure assembly the API contracts and the insight generator both read). Paper and live are separate datasets; only PAPER exists. Fixture-backed outcomes are always reported apart from non-fixture
 * ones and nothing here is labelled validated unless it rests on non-fixture data and a sufficient sample.
 */
export const ANALYTICS_REPORT_VERSION = "analytics-report-v1";
export interface AnalyticsInputs {
  now: Date; minSample: number; minDriftWindow: number; records: readonly AttributionRow[]; decisions: readonly DecisionRow[]; packages: readonly PackageReports[];
  claimChannels: Parameters<typeof telegramFunnel>[0]; telegramCandidates: number; independentStage: Parameters<typeof independentFunnel>[0]; hypothetical: ReadonlyMap<string, HypotheticalResult>; calibration: CalibrationOutcome | null;
}
/** A requested view that cannot be produced from recorded data: stated, with the reason and what it depends on, never approximated. */
export interface Unavailable { status: "NOT_AVAILABLE"; reason: string; dependsOn: string }
export interface DataQualityReport { version: string; records: number; final: number; partial: number; correctedVersions: number; fixtureBacked: number; fixtureShare: number | null; codes: Record<string, number>; missingFields: Record<string, number>; warnings: string[]; validatedDataset: { eligible: number; note: string } }
export interface AnalyticsReport {
  version: string; generatedAt: string; modes: { PAPER: ModeReport; LIVE: { status: "UNAVAILABLE"; reason: string } };
  dataQuality: DataQualityReport; drift: { findings: DriftFinding[]; warnings: DriftFinding[]; insufficient: number; shifts: { decisionOutcomes: Shift; agentVerdicts: Shift; dataQuality: Shift } };
  calibration: { status: string; reasons: string[]; fitSize: number | null; holdoutSize: number | null; excluded: Record<string, number>; note: string };
}
export interface ModeReport {
  overview: PerformanceMetrics; validatedOnly: PerformanceMetrics; fixtureOnly: PerformanceMetrics;
  strategy: { byStrategy: Slice[]; byVersion: Slice[]; byInstrument: Slice[]; byTimeframe: Slice[]; byRegime: Slice[]; bySignalType: Slice[]; byExitReason: Slice[]; byStopBehaviour: Slice[]; byTargetBehaviour: Slice[]; byStopMoved: Slice[]; byConfidenceBand: Slice[]; byRiskVerdict: Slice[]; byPlannedRewardToRisk: Slice[]; byDecisionOutcome: Slice[]; bySignalPattern: Unavailable };
  telegram: TelegramFunnel; independent: IndependentFunnel; agents: AgentAnalytics; decisionQuality: DecisionQuality;
}
const share = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);
export function assessDataQuality(records: readonly AttributionRow[]): DataQualityReport {
  const codes: Record<string, number> = {}, miss: Record<string, number> = {};
  for (const r of records) { for (const c of r.dataQuality) codes[c] = (codes[c] ?? 0) + 1; for (const m of r.missing) miss[m] = (miss[m] ?? 0) + 1; }
  const fixture = records.filter((r) => r.dataSource === "FIXTURE").length, validated = records.filter((r) => isEligible(r) && r.dataSource !== "FIXTURE").length, warn: string[] = [];
  if (records.length && fixture === records.length) warn.push("every outcome rests on fixture data: no figure here is validated performance");
  else if (fixture > 0) warn.push(`${fixture} of ${records.length} outcomes are fixture-backed and are reported apart from the rest`);
  if (codes["OUTCOME_PNL_MISMATCH"]) warn.push(`${codes["OUTCOME_PNL_MISMATCH"]} outcome(s) disagree with the recorded trade outcome`);
  if (codes["CONFIDENCE_RECORDED_AFTER_OPEN"]) warn.push(`${codes["CONFIDENCE_RECORDED_AFTER_OPEN"]} outcome(s) have a confidence score recorded after the position opened (excluded from calibration)`);
  return { version: ANALYTICS_REPORT_VERSION, records: records.length, final: records.filter((r) => r.finality === "FINAL").length, partial: records.filter((r) => r.finality === "PARTIAL").length, correctedVersions: records.filter((r) => r.version > 1 && r.finality === "FINAL" && (r.correctionReason ?? "").startsWith("correction")).length, fixtureBacked: fixture, fixtureShare: share(fixture, records.length), codes, missingFields: miss, warnings: warn, validatedDataset: { eligible: validated, note: "FINAL, non-fixture outcomes: the only dataset that could support a validated claim, and only above the minimum sample" } };
}
export function buildAnalyticsReport(i: AnalyticsInputs): AnalyticsReport {
  const paper = i.records.filter((r) => r.mode === "PAPER"), m = i.minSample;
  const slices = (k: string): Slice[] => sliceBy(paper, DIMENSIONS[k] as never, m);
  const fixture = paper.filter((r) => r.dataSource === "FIXTURE"), real = paper.filter((r) => r.dataSource !== "FIXTURE");
  const decisions = i.decisions.filter((d) => true && d);
  const outcomeOfDecision = new Map(decisions.map((d) => [d.id, d.outcome] as const));
  const modeReport: ModeReport = {
    overview: computeMetrics(paper, m), validatedOnly: computeMetrics(real, m), fixtureOnly: computeMetrics(fixture, m),
    strategy: { byStrategy: slices("strategy"), byVersion: slices("strategyVersion"), byInstrument: slices("instrument"), byTimeframe: slices("timeframe"), byRegime: slices("regime"), bySignalType: slices("strategy"), byExitReason: slices("exitReason"), byStopBehaviour: slices("stopBehaviour"), byTargetBehaviour: slices("targetBehaviour"), byStopMoved: slices("stopMoved"),
      byConfidenceBand: slices("confidenceBand"), byRiskVerdict: slices("riskVerdict"), byPlannedRewardToRisk: slices("plannedRewardToRisk"),
      byDecisionOutcome: sliceBy(paper, (r) => outcomeOfDecision.get(r.decisionId) ?? null, m),
      bySignalPattern: { status: "NOT_AVAILABLE", reason: "a signal-pattern view needs the historical pattern of each signal at decision time, which no pattern provider supplies yet (bySignalType is the setup class, the same cut as byStrategy)", dependsOn: "G-23 historical pattern provider" } },
    telegram: telegramFunnel(i.claimChannels, i.telegramCandidates, decisions, paper, m), independent: independentFunnel(i.independentStage, decisions, paper, m),
    agents: analyzeAgents(i.packages, paper, m), decisionQuality: assessDecisionQuality(decisions, paper, i.hypothetical, m),
  };
  const findings = monitorPerformanceDrift(paper, i.minDriftWindow), rc = i.minDriftWindow;
  const ordered = [...paper].filter(isEligible).sort((a, b) => (a.closedAt as Date).getTime() - (b.closedAt as Date).getTime());
  const dq = windowTallies(ordered, rc, (r) => (r.dataQuality.length ? "FLAGGED" : "CLEAN"));
  const dec = windowTallies([...decisions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()), rc, (d) => d.outcome);
  const ag = windowTallies(i.packages.flatMap((p) => p.reports.map((r) => r.verdict)), rc, (v) => v);
  const cal = i.calibration;
  return {
    version: ANALYTICS_REPORT_VERSION, generatedAt: i.now.toISOString(), modes: { PAPER: modeReport, LIVE: { status: "UNAVAILABLE", reason: "no live execution exists, so there are no live outcomes; paper and live are never combined" } },
    dataQuality: assessDataQuality(i.records),
    drift: { findings, warnings: findings.filter((f) => f.warn), insufficient: findings.filter((f) => f.report.status === "INSUFFICIENT_DATA").length, shifts: { decisionOutcomes: distributionShift(dec.baseline, dec.recent, rc), agentVerdicts: distributionShift(ag.baseline, ag.recent, rc), dataQuality: distributionShift(dq.baseline, dq.recent, rc) } },
    calibration: cal ? { status: cal.status, reasons: cal.reasons, fitSize: cal.fitSize, holdoutSize: cal.holdoutSize, excluded: cal.excluded, note: "confidence is a strength score; it is NOT a probability and stays UNCALIBRATED until at least 200 valid out-of-sample outcomes exist and the win rate rises with the score" } : { status: "UNAVAILABLE", reasons: ["calibration was not evaluated"], fitSize: null, holdoutSize: null, excluded: {}, note: "confidence is a strength score; it is NOT a probability" },
  };
}
