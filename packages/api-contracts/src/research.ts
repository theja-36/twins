/**
 * Stage 09.3B.1: the REAL research package, as served by GET /research/candidates/:id/package (`package`) and /research/packages/:id.
 * Verified by tests/integration/api-contracts/realOutputShapes.test.ts, which runs the real research orchestrator (`runCandidateResearch`), stores the package through the real store and reads it back through the real route.
 * Verified: the exact top-level key set, the agent-report key set, the contradiction and role-coverage key sets, `grantsApproval:false`, and the verdict vocabulary (mirrors SPEC_VERDICTS, proven equal by a unit parity test).
 * NOT verified (kept `string` / `unknown`): the assessment and role vocabularies, `optionsRisk` (only present for an option candidate, not exercised), and agent-specific content inside `reasoningSummary` (free text).
 */
import type { IsoTimestamp, Uuid } from "./wire";

/** Research verdicts. Evidence vocabulary only: none of these is an approval, and the package carries `grantsApproval: false`. */
export const SPEC_VERDICTS = ["SUPPORTIVE", "CAUTION", "NEUTRAL", "ADVERSE", "INCOMPLETE", "BLOCKING"] as const;
export type SpecVerdict = (typeof SPEC_VERDICTS)[number];

export const AGENT_REPORT_KEYS = ["agentId", "agentVersion", "role", "verdict", "executionStatus", "confidence", "evidenceRefs", "riskFlags", "reasoningSummary", "inputSnapshotRef", "errorCode"] as const;
export const AGENT_REPORT_OPTIONAL_KEYS = ["supplementsRoles"] as const;
export interface AgentReportView {
  agentId: string; agentVersion: string; role: string | null; supplementsRoles?: string[]; verdict: SpecVerdict; executionStatus: string;
  /** A number, or null when the agent did not complete. Displayed as given; never averaged or re-weighted in the browser. */
  confidence: number | null; evidenceRefs: string[]; riskFlags: string[]; reasoningSummary: string; inputSnapshotRef: string; errorCode: string | null;
}
export const CONTRADICTION_KEYS = ["supportive", "opposing", "opposingVerdict"] as const;
export interface ContradictionView { supportive: string[]; opposing: string[]; opposingVerdict: "ADVERSE" | "BLOCKING" }
export const ROLE_COVERAGE_KEYS = ["coveredRoles", "missingRoles", "unmappedAgents"] as const;
export interface RoleCoverageView { coveredRoles: string[]; missingRoles: string[]; unmappedAgents: string[] }

export const RESEARCH_PACKAGE_BODY_KEYS = ["packageVersion", "candidateId", "candidateSource", "dataSource", "version", "assessment", "halt", "haltReason", "score", "synthesisAlgorithmVersion", "reports", "contradictions", "roleCoverage", "agentVersions", "evidenceIndex", "missingRequired", "grantsApproval", "synthesisInputSha256", "packageSha256"] as const;
/** Present only on some packages: `asOf` is absent on packages stored before it existed (such a package has NO known as-of); `optionsRisk` only for an option candidate. */
export const RESEARCH_PACKAGE_BODY_OPTIONAL_KEYS = ["asOf", "optionsRisk"] as const;
export interface ResearchPackageBody {
  packageVersion: string; candidateId: Uuid; candidateSource: "TELEGRAM" | "INDEPENDENT"; dataSource: string; asOf?: IsoTimestamp; version: number; assessment: string; halt: boolean; haltReason: string | null;
  /** The research synthesis score as given (a number or null). Not a probability. */
  score: number | null; synthesisAlgorithmVersion: string; reports: AgentReportView[]; contradictions: ContradictionView[]; roleCoverage: RoleCoverageView;
  optionsRisk?: unknown; agentVersions: Record<string, string>; evidenceIndex: string[]; missingRequired: string[]; grantsApproval: false; synthesisInputSha256: string; packageSha256: string;
}
