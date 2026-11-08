import { createHash } from "node:crypto";
import type { AttributionRow, NewInsight } from "@twins/database";
import { OUTCOME_LEARNING_VERSION } from "./config";
import type { AnalyticsReport, ModeReport } from "./analytics";
import { isEligible, reliabilityOf, type PerformanceMetrics, type Reliability } from "./metrics";

/**
 * The learning engine's insights (Stage 08 §6). Each insight states its scope, subject, supporting outcome count, period, provenance, method, evidence references, reliability, limitations and algorithm version, and has a
 * deterministic key over the exact input set, so the same stored outcomes always give the same insight (re-running adds nothing). An insight can recommend a human REVIEW and nothing else: this module has no way to change a risk
 * limit, size, stop-loss rule, confidence weight, strategy, playbook, permission, approval or the kill switch, and nothing reads an insight to do so.
 */
export const INSIGHT_ENGINE_VERSION = `insight-engine-v1/${OUTCOME_LEARNING_VERSION}`;
type Draft = Omit<NewInsight, "insightKey" | "outcomeCount" | "periodStart" | "periodEnd" | "provenance" | "evidenceRefs" | "algorithmVersion">;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
function evidenceOf(rs: readonly AttributionRow[]): { ids: string[]; total: number; sha256: string } { const ids = rs.map((r) => `${r.id}@v${r.version}`).sort(); return { ids: ids.slice(0, 200), total: ids.length, sha256: sha(ids.join(",")) }; }
function make(draft: Draft, rs: readonly AttributionRow[], extraInput = ""): NewInsight {
  const el = rs.filter(isEligible), ev = evidenceOf(rs), times = el.map((r) => (r.closedAt as Date).getTime());
  const prov = { modes: [...new Set(rs.map((r) => r.mode))].sort(), dataSources: [...new Set(rs.map((r) => r.dataSource))].sort(), candidateSources: [...new Set(rs.map((r) => r.candidateSource))].sort(), fixtureBacked: rs.some((r) => r.dataSource === "FIXTURE") };
  return { ...draft, insightKey: sha([draft.kind, draft.scope, draft.subject, draft.method, INSIGHT_ENGINE_VERSION, ev.sha256, extraInput].join("|")), outcomeCount: el.length, periodStart: times.length ? new Date(Math.min(...times)) : null, periodEnd: times.length ? new Date(Math.max(...times)) : null, provenance: prov, evidenceRefs: ev, algorithmVersion: INSIGHT_ENGINE_VERSION };
}
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const FIXTURE_LIM = "built on fixture-backed data: this describes the simulation, not the market";
function lim(rs: readonly AttributionRow[], extra: string[] = []): string[] { return [...extra, ...(rs.some((r) => r.dataSource === "FIXTURE") ? [FIXTURE_LIM] : []), "paper (simulated) results only; no live trading performance exists", "association in a small history, not a forecast"]; }
function perfStatement(label: string, m: PerformanceMetrics): string {
  if (m.status === "INSUFFICIENT_DATA") return `${label}: ${m.eligible} eligible outcome(s), fewer than the ${m.winRate.note ?? "minimum"}; no performance figure is reported (INSUFFICIENT_DATA).`;
  return `${label}: ${m.eligible} eligible outcomes, win rate ${pct(m.winRate.value)} (95% interval ${pct(m.winRate.interval?.lower)} to ${pct(m.winRate.interval?.upper)}), net P&L ${m.netPnl}, mean R ${m.expectancyR.value ?? "n/a"}, profit factor ${m.profitFactor.value ?? "n/a"}.`;
}
export function generateInsights(report: AnalyticsReport, records: readonly AttributionRow[], minSample: number): NewInsight[] {
  const out: NewInsight[] = [], paper = records.filter((r) => r.mode === "PAPER" && r.finality === "FINAL");
  const P: ModeReport = report.modes.PAPER;
  const rel = (rs: readonly AttributionRow[]): Reliability => reliabilityOf(rs.filter(isEligible), minSample);
  // overall, validated and fixture datasets are separate insights
  for (const [name, rs, m] of [["all paper outcomes", paper, P.overview], ["non-fixture paper outcomes (the only validated dataset)", paper.filter((r) => r.dataSource !== "FIXTURE"), P.validatedOnly], ["fixture-backed paper outcomes", paper.filter((r) => r.dataSource === "FIXTURE"), P.fixtureOnly]] as const) {
    if (rs.length === 0 && name !== "non-fixture paper outcomes (the only validated dataset)") continue;
    out.push(make({ kind: "PERFORMANCE", scope: "PLATFORM_USER", subject: name, method: "performance-metrics-v1: win rate (Wilson), net P&L, mean R with 95% interval, profit factor, drawdown of cumulative P&L", reliability: rel(rs), severity: "INFO", statement: perfStatement(name, m), metrics: m, limitations: lim(rs, ["the drawdown is of cumulative net P&L, not an account equity curve"]), recommendation: null }, rs));
  }
  const sliceInsights = (kind: "STRATEGY" | "REGIME", scope: string, slices: typeof P.strategy.byVersion): void => {
    for (const s of slices.slice(0, 20)) {
      const rs = paper.filter((r) => (scope === "STRATEGY_VERSION" ? (r.setup ? `${r.setup}@${r.detectorVersion ?? "unversioned"}` : "UNKNOWN") : scope === "CHANNEL" ? (r.channelId ?? "UNKNOWN") : ((r.regime as { atDecision?: { regime?: string } } | null)?.atDecision?.regime ?? "UNKNOWN")) === s.key);
      out.push(make({ kind, scope, subject: s.key, method: "sliced performance-metrics-v1 (like-for-like: a version is never merged with another)", reliability: rel(rs), severity: "INFO", statement: perfStatement(`${scope.toLowerCase().replace("_", " ")} ${s.key}`, s.metrics), metrics: s.metrics, limitations: lim(rs, scope === "CHANNEL" ? ["TWINS' paper outcomes measure TWINS' decisions on this channel's signals, not the accuracy of the channel's calls"] : scope === "REGIME" ? ["regime evidence is sparse: records without one are in UNKNOWN"] : []), recommendation: null }, rs));
    }
  };
  sliceInsights("STRATEGY", "STRATEGY_VERSION", P.strategy.byVersion);
  // only channels this user's own decisions or outcomes involve (the platform-wide channel list is pipeline data, not this user's findings), at most 20
  for (const c of P.telegram.channels.filter((x) => x.decisions.total > 0 || x.outcomes !== null).slice(0, 20)) { const rs = paper.filter((r) => r.channelId === c.channelId); out.push(make({ kind: "CHANNEL", scope: "CHANNEL", subject: c.channelLabel, method: "pipeline funnel plus sliced performance (channel conversions and outcomes of TWINS decisions)", reliability: c.outcomes ? c.outcomes.reliability : "INSUFFICIENT_DATA", severity: "INFO", statement: `Channel ${c.channelLabel}: ${c.messages} messages, ${c.claims} claims, ${c.decisions.total} decisions, ${c.decisions.withPosition} paper trades; ${c.outcomes ? perfStatement("outcomes", c.outcomes) : "no eligible outcomes (INSUFFICIENT_DATA)"}`, metrics: c, limitations: lim(rs, ["channel accuracy cannot be established from this data"]), recommendation: null }, rs, c.channelId)); }
  sliceInsights("REGIME", "REGIME", P.strategy.byRegime);
  // agents
  for (const a of P.agents.agents) out.push(make({ kind: "AGENT", scope: "AGENT", subject: a.agentId, method: "agent-analytics-v1: participation, verdict distribution, availability, outcome association per verdict", reliability: a.outcomeAssociation.length ? reliabilityOf(paper.filter(isEligible).slice(0, a.outcomeAssociation.reduce((s, x) => s + x.eligibleOutcomes, 0)), minSample) : "INSUFFICIENT_DATA", severity: "INFO",
    statement: `Agent ${a.agentId}: in ${a.participation} research packages, completed ${a.completed} (availability ${pct(a.availabilityRate)}); verdicts ${Object.entries(a.verdicts).map(([k, v]) => `${k}=${v}`).join(", ")}. ${a.outcomeAssociation.some((x) => x.winRate !== null) ? "Outcome association is reported for groups above the minimum sample (an association, not predictive accuracy)." : "No verdict group has enough outcomes for an outcome association."}`, metrics: a, limitations: [a.associationNote, "agreement between agents is not correctness"], recommendation: null }, paper, a.agentId));
  // decision quality
  out.push(make({ kind: "DECISION_QUALITY", scope: "DECISIONS", subject: "decision outcomes", method: "decision-quality-v1: outcome distribution; realised results only for executed decisions; unexecuted decisions get clearly labelled price-path estimates, never P&L", reliability: P.decisionQuality.executed.qualifiedExecuted >= minSample ? rel(paper) : "INSUFFICIENT_DATA", severity: "INFO",
    statement: `Decisions: ${P.decisionQuality.decisions.total} (${Object.entries(P.decisionQuality.decisions.byOutcome).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}); ${P.decisionQuality.executed.qualifiedExecuted} executed with a final outcome. Unexecuted decisions have no realised result.`, metrics: P.decisionQuality, limitations: P.decisionQuality.limitations, recommendation: null }, paper));
  // risk and execution quality
  out.push(make({ kind: "RISK_EXECUTION", scope: "EXECUTION", subject: "costs, stops and exits", method: "cost impact, stop behaviour and exit-reason distribution over eligible outcomes", reliability: rel(paper), severity: "INFO",
    statement: `Costs are ${P.overview.costImpact.value ?? "n/a"}% of absolute gross P&L; exits: ${P.strategy.byExitReason.map((s) => `${s.key}=${s.metrics.eligible}`).join(", ") || "none"}; stop tightened in ${P.strategy.byStopMoved.find((s) => s.key === "STOP_TIGHTENED")?.metrics.eligible ?? 0} outcomes. Slippage cannot be measured (no reference price is recorded).`, metrics: { costImpact: P.overview.costImpact, slippage: P.overview.slippage, exits: P.strategy.byExitReason.map((s) => ({ key: s.key, n: s.metrics.eligible })), stopBehaviour: P.strategy.byStopBehaviour.map((s) => ({ key: s.key, n: s.metrics.eligible })) }, limitations: lim(paper), recommendation: null }, paper));
  // drift
  for (const f of report.drift.warnings) {
    const rs = paper.filter((r) => (f.subjectKind === "STRATEGY_VERSION" ? `${r.setup}@${r.detectorVersion ?? "unversioned"}` : f.subjectKind === "CHANNEL" ? r.channelId : f.subjectKind === "SOURCE" ? r.candidateSource : `${r.setup}@${r.detectorVersion ?? "unversioned"}|${(r.regime as { atDecision?: { regime?: string } } | null)?.atDecision?.regime ?? ""}`) === f.subject);
    out.push(make({ kind: "DRIFT", scope: f.subjectKind, subject: f.subject, method: "strategy-learning-v1 detectDrift (Stage 03): baseline versus most recent window, two-proportion z test; DEGRADATION = lower win rate and lower mean R", reliability: f.reliability, severity: "WARNING",
      statement: `${f.report.status} for ${f.subjectKind.toLowerCase().replace("_", " ")} ${f.subject}: ${f.report.note}. Recent win rate ${pct(f.report.recent?.winRate)} versus baseline ${pct(f.report.baseline?.winRate)} (z ${f.report.z}).`, metrics: f.report, limitations: lim(rs, ["a statistical flag over a limited history; it is a request for review, not a verdict"]), recommendation: f.reliability === "INSUFFICIENT_DATA" ? null : "REVIEW" }, rs));
  }
  if (report.drift.findings.length) out.push(make({ kind: "DRIFT", scope: "SUMMARY", subject: "drift monitoring coverage", method: "strategy-learning-v1 detectDrift over every like-for-like subject", reliability: "INSUFFICIENT_DATA", severity: "INFO", statement: `${report.drift.findings.length} subject(s) monitored; ${report.drift.warnings.length} warning(s); ${report.drift.insufficient} have too little evidence to say anything (INSUFFICIENT_DATA is not 'no drift').`, metrics: { subjects: report.drift.findings.map((f) => ({ kind: f.subjectKind, subject: f.subject, n: f.n, status: f.report.status })), shifts: report.drift.shifts }, limitations: ["each subject needs the minimum sample in both the baseline and the recent window"], recommendation: null }, paper));
  // data quality
  const dq = report.dataQuality;
  out.push(make({ kind: "DATA_QUALITY", scope: "OUTCOMES", subject: "outcome data quality", method: "counts of provenance, quality codes and missing fields across attribution records", reliability: dq.records === 0 ? "INSUFFICIENT_DATA" : dq.fixtureBacked === dq.records ? "NOT_VALIDATED_FIXTURE" : "MODERATE", severity: dq.warnings.length ? "WARNING" : "INFO",
    statement: `${dq.records} attribution records (${dq.final} final, ${dq.partial} partial, ${dq.correctedVersions} corrected); fixture-backed ${dq.fixtureBacked}. ${dq.warnings.join("; ") || "no data-quality warnings"}.`, metrics: dq, limitations: ["missing fields stay missing: they are counted, never filled in"], recommendation: dq.warnings.length ? "REVIEW" : null }, records.filter((r) => r.mode === "PAPER")));
  // calibration
  const c = report.calibration;
  out.push(make({ kind: "CALIBRATION", scope: "CONFIDENCE", subject: "confidence-strength-v1", method: "Stage 06 calibration procedure on chronologically held-out, non-fixture, look-ahead-free outcomes (minimum 200 out-of-sample; win rate must rise with score)", reliability: c.status === "CALIBRATED" ? "ADEQUATE" : c.status === "UNAVAILABLE" ? "UNAVAILABLE" : "NOT_CALIBRATED", severity: "INFO",
    statement: `Confidence calibration: ${c.status}. ${c.reasons.join("; ")}. Held-out outcomes: ${c.holdoutSize ?? "n/a"}; excluded: ${Object.entries(c.excluded).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}. The strength score is not a probability.`, metrics: c, limitations: [c.note, "the 200 out-of-sample minimum is the Stage 06 requirement and is not lowered"], recommendation: null }, paper, c.status));
  // research areas
  const gaps: string[] = [];
  if (P.validatedOnly.eligible < minSample) gaps.push(`only ${P.validatedOnly.eligible} non-fixture eligible outcomes exist (minimum ${minSample}): validated performance cannot be assessed until real-price paper trading accumulates more`);
  if ((dq.missingFields["regime_at_decision"] ?? 0) > 0) gaps.push("regime at decision time is missing for some outcomes (no live regime source, G-16)");
  if ((dq.missingFields["mae_mfe"] ?? 0) > 0) gaps.push("excursions (MAE / MFE) are not recorded, so entry timing and stop placement quality cannot be assessed beyond exit reasons");
  if (P.telegram.channels.length && P.telegram.decisions.total === 0) gaps.push("no Telegram-originated decision exists (claims are not converted to candidates, G-19)");
  if (gaps.length) out.push(make({ kind: "RESEARCH_AREA", scope: "PLATFORM_USER", subject: "evidence gaps", method: "listing of evidence the analytics could not use", reliability: "UNAVAILABLE", severity: "INFO", statement: `Areas needing more evidence before any conclusion: ${gaps.join("; ")}.`, metrics: { gaps }, limitations: ["a list of gaps, not a finding"], recommendation: null }, paper));
  return out;
}
