import type { OrchestrationOutcome } from "../orchestrator";
import type { ResearchAssessment } from "../config";
import { hashOf } from "../sanitize";
import { findContradictions, roleCoverage, toSpecAgentReport, type Contradiction, type RoleCoverage, type SpecAgentReport } from "./specMapping";
import type { ResearchCandidate } from "./candidateInput";
import type { AgentRunRecord } from "./runRecords";
import { mapOptionsFindings, type OptionsRiskContext, type OptionsRiskMapping } from "./optionsRiskMapping";

export const RESEARCH_PACKAGE_VERSION = "research-package-v1";

/**
 * The research package (Stage 04): the single, traceable hand-off from research to the decision engine. It is EVIDENCE, never a decision: `grantsApproval` is the literal false, it cannot
 * set a size, a limit, a permission or an order, and the decision engine still applies its own deterministic gates. Every verdict names the agent version and evidence references that
 * produced it, and the whole package carries a hash so a later change is detectable.
 */
export interface ResearchPackage {
  packageVersion: string; candidateId: string; candidateSource: ResearchCandidate["source"]; dataSource: ResearchCandidate["dataSource"];
  /** The research run's as-of instant (the orchestrator's clock when it started). Absent on packages stored before it existed; those must not be read as having a known as-of. */
  asOf?: string;
  version: number; assessment: ResearchAssessment; halt: boolean; haltReason: string | null; score: number | null;
  synthesisAlgorithmVersion: string; reports: SpecAgentReport[]; contradictions: Contradiction[]; roleCoverage: RoleCoverage;
  /** Present only for an option candidate (A13): how it maps onto its contract, underlying and risk context. Evidence, never a decision. */
  optionsRisk?: { mapping: OptionsRiskMapping; context: OptionsRiskContext | null };
  agentVersions: Record<string, string>; evidenceIndex: string[]; missingRequired: string[]; grantsApproval: false; synthesisInputSha256: string; packageSha256: string;
}

export function buildResearchPackage(candidate: Pick<ResearchCandidate, "id" | "source" | "dataSource">, version: number, outcome: OrchestrationOutcome, extras: { optionsRiskMapping?: OptionsRiskMapping | null } = {}): ResearchPackage {
  if (!Number.isInteger(version) || version < 1) throw new RangeError("the research package version must be a positive integer");
  const reports = outcome.results.map(toSpecAgentReport).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const s = outcome.synthesis;
  const base = {
    packageVersion: RESEARCH_PACKAGE_VERSION, candidateId: candidate.id, candidateSource: candidate.source, dataSource: candidate.dataSource, asOf: outcome.startedAt.toISOString(), version,
    assessment: s.assessment, halt: s.halt.halt, haltReason: s.halt.halt ? s.halt.reasonCode : null, score: s.score, synthesisAlgorithmVersion: s.algorithmVersion,
    reports, contradictions: findContradictions(reports), roleCoverage: roleCoverage(outcome.results.map((r) => r.agentId)),
    agentVersions: Object.fromEntries(reports.map((r) => [r.agentId, r.agentVersion])),
    evidenceIndex: [...new Set(reports.flatMap((r) => r.evidenceRefs))].sort(), missingRequired: s.missingRequired.map((m) => m.agentId).sort(),
    grantsApproval: false as const, synthesisInputSha256: s.inputSha256,
    ...(extras.optionsRiskMapping && extras.optionsRiskMapping.status !== "NOT_APPLICABLE" ? { optionsRisk: { mapping: extras.optionsRiskMapping, context: (() => { const r = outcome.results.find((x) => x.agentId === "options-risk-v1"); return r ? mapOptionsFindings(r) : null; })() } } : {}),
  };
  return { ...base, packageSha256: hashOf(base) };
}
/** The `research_packages` row for a package (the database stores it append-only; a new evaluation is a new version). `runKey` and `agentRuns` (G-43, G-44) travel with it so the store writes them in the same transaction. */
export function toResearchPackageRow(p: ResearchPackage, extras: { runKey?: string; agentRuns?: AgentRunRecord[] } = {}): { candidateId: string; version: number; agentResults: ResearchPackage; assessment: ResearchAssessment; haltReason: string | null; runKey?: string; agentRuns?: AgentRunRecord[] } {
  return { candidateId: p.candidateId, version: p.version, agentResults: p, assessment: p.assessment, haltReason: p.haltReason, ...(extras.runKey ? { runKey: extras.runKey } : {}), ...(extras.agentRuns ? { agentRuns: extras.agentRuns } : {}) };
}
