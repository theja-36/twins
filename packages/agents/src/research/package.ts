import type { OrchestrationOutcome } from "../orchestrator";
import type { ResearchAssessment } from "../config";
import { hashOf } from "../sanitize";
import { findContradictions, roleCoverage, toSpecAgentReport, type Contradiction, type RoleCoverage, type SpecAgentReport } from "./specMapping";
import type { ResearchCandidate } from "./candidateInput";

export const RESEARCH_PACKAGE_VERSION = "research-package-v1";

/**
 * The research package (Stage 04): the single, traceable hand-off from research to the decision engine. It is EVIDENCE, never a decision: `grantsApproval` is the literal false, it cannot
 * set a size, a limit, a permission or an order, and the decision engine still applies its own deterministic gates. Every verdict names the agent version and evidence references that
 * produced it, and the whole package carries a hash so a later change is detectable.
 */
export interface ResearchPackage {
  packageVersion: string; candidateId: string; candidateSource: ResearchCandidate["source"]; dataSource: ResearchCandidate["dataSource"];
  version: number; assessment: ResearchAssessment; halt: boolean; haltReason: string | null; score: number | null;
  synthesisAlgorithmVersion: string; reports: SpecAgentReport[]; contradictions: Contradiction[]; roleCoverage: RoleCoverage;
  agentVersions: Record<string, string>; evidenceIndex: string[]; missingRequired: string[]; grantsApproval: false; synthesisInputSha256: string; packageSha256: string;
}

export function buildResearchPackage(candidate: Pick<ResearchCandidate, "id" | "source" | "dataSource">, version: number, outcome: OrchestrationOutcome): ResearchPackage {
  if (!Number.isInteger(version) || version < 1) throw new RangeError("the research package version must be a positive integer");
  const reports = outcome.results.map(toSpecAgentReport).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const s = outcome.synthesis;
  const base = {
    packageVersion: RESEARCH_PACKAGE_VERSION, candidateId: candidate.id, candidateSource: candidate.source, dataSource: candidate.dataSource, version,
    assessment: s.assessment, halt: s.halt.halt, haltReason: s.halt.halt ? s.halt.reasonCode : null, score: s.score, synthesisAlgorithmVersion: s.algorithmVersion,
    reports, contradictions: findContradictions(reports), roleCoverage: roleCoverage(outcome.results.map((r) => r.agentId)),
    agentVersions: Object.fromEntries(reports.map((r) => [r.agentId, r.agentVersion])),
    evidenceIndex: [...new Set(reports.flatMap((r) => r.evidenceRefs))].sort(), missingRequired: s.missingRequired.map((m) => m.agentId).sort(),
    grantsApproval: false as const, synthesisInputSha256: s.inputSha256,
  };
  return { ...base, packageSha256: hashOf(base) };
}
/** The `research_packages` row for a package (the database stores it append-only; a new evaluation is a new version). */
export function toResearchPackageRow(p: ResearchPackage): { candidateId: string; version: number; agentResults: ResearchPackage; assessment: ResearchAssessment; haltReason: string | null } {
  return { candidateId: p.candidateId, version: p.version, agentResults: p, assessment: p.assessment, haltReason: p.haltReason };
}
