import type { AttributionRow } from "@twins/database";
import { classOf, isEligible, reliabilityOf, type Reliability } from "./metrics";

/**
 * Agent analytics (Module 15E). Participation, availability, verdict distribution, agreement and evidence-gap rates come from the stored research packages. The relation to outcomes is reported ONLY as an association between the
 * agent's verdict and what later happened, per verdict group, and only for groups with enough eligible outcomes; it is never presented as predictive accuracy, and agreement is never equated with correctness.
 */
export const AGENT_ANALYTICS_VERSION = "agent-analytics-v1";
export interface PackageReports { candidateId: string; packageId: string; version: number; reports: Array<{ agentId: string; agentVersion: string; verdict: string; executionStatus: string; riskFlags: string[] }>; contradictions: number; missingRequired: string[]; assessment: string }
export interface AgentStats {
  agentId: string; packages: number; participation: number; completed: number; unavailable: number; availabilityRate: number | null; verdicts: Record<string, number>; versions: Record<string, number>; riskFlagRate: number | null;
  outcomeAssociation: Array<{ verdict: string; eligibleOutcomes: number; wins: number; winRate: number | null; reliability: Reliability }>; associationNote: string;
}
export interface AgentAnalytics { version: string; packages: number; agents: AgentStats[]; agreement: { packagesWithTwoOrMoreVerdicts: number; unanimous: number; disagreement: number; withContradictions: number; rate: { unanimous: number | null; contradictions: number | null } }; evidenceGaps: { packagesMissingRequiredAgents: number; missingRate: number | null; byAgent: Record<string, number> }; assessments: Record<string, number> }
export function analyzeAgents(pkgs: readonly PackageReports[], records: readonly AttributionRow[], minSample: number): AgentAnalytics {
  const byCand = new Map<string, AttributionRow[]>(); for (const r of records.filter(isEligible)) byCand.set(r.candidateId, [...(byCand.get(r.candidateId) ?? []), r]);
  const ids = [...new Set(pkgs.flatMap((p) => p.reports.map((r) => r.agentId)))].sort();
  const agents: AgentStats[] = ids.map((id) => {
    const rows = pkgs.flatMap((p) => p.reports.filter((r) => r.agentId === id).map((r) => ({ p, r })));
    const completed = rows.filter((x) => x.r.executionStatus === "COMPLETED").length, verdicts: Record<string, number> = {}, versions: Record<string, number> = {};
    for (const x of rows) { verdicts[x.r.verdict] = (verdicts[x.r.verdict] ?? 0) + 1; versions[x.r.agentVersion] = (versions[x.r.agentVersion] ?? 0) + 1; }
    const assoc = new Map<string, AttributionRow[]>(); for (const x of rows) if (x.r.executionStatus === "COMPLETED") for (const o of byCand.get(x.p.candidateId) ?? []) assoc.set(x.r.verdict, [...(assoc.get(x.r.verdict) ?? []), o]);
    return {
      agentId: id, packages: pkgs.length, participation: rows.length, completed, unavailable: rows.length - completed, availabilityRate: rows.length ? Math.round((completed / rows.length) * 10_000) / 10_000 : null, verdicts, versions,
      riskFlagRate: rows.length ? Math.round((rows.filter((x) => x.r.riskFlags.length > 0).length / rows.length) * 10_000) / 10_000 : null,
      outcomeAssociation: [...assoc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([verdict, os]) => ({ verdict, eligibleOutcomes: os.length, wins: os.filter((o) => classOf(o) === "WIN").length, winRate: os.length >= minSample ? Math.round((os.filter((o) => classOf(o) === "WIN").length / os.length) * 10_000) / 10_000 : null, reliability: reliabilityOf(os, minSample) })),
      associationNote: "an association between this agent's verdict and later outcomes of the decisions it informed; not predictive accuracy; groups below the minimum sample report no rate",
    };
  });
  let multi = 0, unanimous = 0, withC = 0, missingPk = 0; const byAgent: Record<string, number> = {};
  for (const p of pkgs) {
    const done = p.reports.filter((r) => r.executionStatus === "COMPLETED").map((r) => r.verdict);
    if (done.length >= 2) { multi++; if (new Set(done).size === 1) unanimous++; }
    if (p.contradictions > 0) withC++;
    if (p.missingRequired.length) { missingPk++; for (const m of p.missingRequired) byAgent[m] = (byAgent[m] ?? 0) + 1; }
  }
  const assessments: Record<string, number> = {}; for (const p of pkgs) assessments[p.assessment] = (assessments[p.assessment] ?? 0) + 1;
  const r4 = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);
  return { version: AGENT_ANALYTICS_VERSION, packages: pkgs.length, agents, agreement: { packagesWithTwoOrMoreVerdicts: multi, unanimous, disagreement: multi - unanimous, withContradictions: withC, rate: { unanimous: r4(unanimous, multi), contradictions: r4(withC, pkgs.length) } }, evidenceGaps: { packagesMissingRequiredAgents: missingPk, missingRate: r4(missingPk, pkgs.length), byAgent }, assessments };
}
