import { toSpecVerdict, type SpecVerdict } from "@twins/types";
import type { AgentRunResult } from "../contract";
import { sanitizeText } from "../sanitize";

/**
 * Specification mapping (Stage 04). The Master Specification names TWELVE specialist research responsibilities. This table binds each one to the implemented component(s), so none
 * can be silently merged or dropped. `market-context-v1` is the specified Market Context role; `options-risk-v1` is an ADDITIONAL production specialist preserved from the baseline
 * (it is mapped as an extra, never as a replacement for a role). Research Synthesis is the deterministic `synthesize` function, not an agent.
 */
export const SPEC_ROLES = [
  "SIGNAL_INTEGRITY", "INSTRUMENT_VALIDATION", "MARKET_CONTEXT", "TECHNICAL_STRUCTURE", "PRICE_ACTION", "NEWS_SENTIMENT",
  "LIQUIDITY", "HISTORICAL_PATTERN", "CALENDAR_MACRO", "INDEX_CONSTITUENTS", "INDEPENDENT_CHALLENGER", "RESEARCH_SYNTHESIS",
] as const;
export type SpecRole = (typeof SPEC_ROLES)[number];

export interface RoleBinding { role: SpecRole; specName: string; kind: "AGENTS" | "SYNTHESIS"; components: readonly string[] }
export const SPEC_ROLE_MAP: Readonly<Record<SpecRole, RoleBinding>> = {
  SIGNAL_INTEGRITY: { role: "SIGNAL_INTEGRITY", specName: "Signal Integrity", kind: "AGENTS", components: ["signal-integrity-v1"] },
  INSTRUMENT_VALIDATION: { role: "INSTRUMENT_VALIDATION", specName: "Instrument Validation", kind: "AGENTS", components: ["instrument-verification-v1"] },
  MARKET_CONTEXT: { role: "MARKET_CONTEXT", specName: "Market Context", kind: "AGENTS", components: ["market-context-v1"] },
  TECHNICAL_STRUCTURE: { role: "TECHNICAL_STRUCTURE", specName: "Technical Structure", kind: "AGENTS", components: ["technical-structure-v1"] },
  PRICE_ACTION: { role: "PRICE_ACTION", specName: "Price Action", kind: "AGENTS", components: ["price-action-v1"] },
  NEWS_SENTIMENT: { role: "NEWS_SENTIMENT", specName: "News & Sentiment", kind: "AGENTS", components: ["news-sentiment-v1"] },
  LIQUIDITY: { role: "LIQUIDITY", specName: "Liquidity", kind: "AGENTS", components: ["liquidity-v1"] },
  HISTORICAL_PATTERN: { role: "HISTORICAL_PATTERN", specName: "Historical Pattern", kind: "AGENTS", components: ["historical-pattern-v1"] },
  CALENDAR_MACRO: { role: "CALENDAR_MACRO", specName: "Calendar & Macro", kind: "AGENTS", components: ["market-calendar-v1", "macro-global-v1"] },
  INDEX_CONSTITUENTS: { role: "INDEX_CONSTITUENTS", specName: "Index Constituents", kind: "AGENTS", components: ["index-constituent-impact-v1"] },
  INDEPENDENT_CHALLENGER: { role: "INDEPENDENT_CHALLENGER", specName: "Independent Challenger", kind: "AGENTS", components: ["independent-challenger-v1"] },
  RESEARCH_SYNTHESIS: { role: "RESEARCH_SYNTHESIS", specName: "Research Synthesis", kind: "SYNTHESIS", components: ["research-synthesis-v2"] },
};
/** Production specialists that are not one of the twelve roles. They stay registered and scored. */
export const EXTRA_SPECIALISTS: readonly string[] = ["options-risk-v1"];

/** Extra specialists SUPPLEMENT some of the twelve roles without replacing any: `options-risk-v1` adds option-specific market and liquidity risk beside Market Context and Liquidity (A13). `roleOfAgent` still answers "EXTRA". */
export const EXTRA_SPECIALIST_SUPPLEMENTS: Readonly<Record<string, readonly SpecRole[]>> = { "options-risk-v1": ["MARKET_CONTEXT", "LIQUIDITY"] };
export const supplementsOf = (agentId: string): SpecRole[] => [...(EXTRA_SPECIALIST_SUPPLEMENTS[agentId] ?? [])];
export function roleOfAgent(agentId: string): SpecRole | "EXTRA" | null {
  for (const b of Object.values(SPEC_ROLE_MAP)) if (b.kind === "AGENTS" && b.components.includes(agentId)) return b.role;
  return EXTRA_SPECIALISTS.includes(agentId) ? "EXTRA" : null;
}
export interface RoleCoverage { coveredRoles: SpecRole[]; missingRoles: SpecRole[]; unmappedAgents: string[] }
/** Which of the twelve roles have every component registered, and which registered agents map to nothing. Synthesis counts as covered (it is not registered as an agent). */
export function roleCoverage(registeredAgentIds: readonly string[]): RoleCoverage {
  const have = new Set(registeredAgentIds);
  const covered: SpecRole[] = [], missing: SpecRole[] = [];
  for (const r of SPEC_ROLES) {
    const b = SPEC_ROLE_MAP[r];
    (b.kind === "SYNTHESIS" || b.components.every((c) => have.has(c)) ? covered : missing).push(r);
  }
  return { coveredRoles: covered, missingRoles: missing, unmappedAgents: registeredAgentIds.filter((a) => roleOfAgent(a) === null).sort() };
}

/** The specification's per-agent report: verdict in the spec vocabulary (UNAVAILABLE and every non-COMPLETED status become INCOMPLETE), evidence references, risk flags and a short reasoning summary. */
export interface SpecAgentReport {
  agentId: string; agentVersion: string; role: SpecRole | "EXTRA" | null;
  /** Present only for an extra specialist: the roles it supplements. */
  supplementsRoles?: SpecRole[];
  verdict: SpecVerdict; executionStatus: AgentRunResult["status"]; confidence: number | null;
  evidenceRefs: string[]; riskFlags: string[]; reasoningSummary: string; inputSnapshotRef: string; errorCode: string | null;
}
const FLAG_SEVERITY = new Set(["MEDIUM", "HIGH", "CRITICAL"]);
export function toSpecAgentReport(r: AgentRunResult): SpecAgentReport {
  const flags = [...new Set(r.findings.filter((f) => FLAG_SEVERITY.has(f.severity)).map((f) => f.code))].sort().slice(0, 20);
  const summary = r.status !== "COMPLETED"
    ? `Did not complete (${r.status}${r.errorCode ? `: ${r.errorCode}` : ""}); reported INCOMPLETE, never a pass.`
    : r.findings.filter((f) => f.severity !== "INFO").slice(0, 3).map((f) => f.summary).join(" ") || "No cautionary findings.";
  return {
    agentId: r.agentId, agentVersion: r.agentVersion, role: roleOfAgent(r.agentId), ...(supplementsOf(r.agentId).length > 0 ? { supplementsRoles: supplementsOf(r.agentId) } : {}), verdict: toSpecVerdict(r.verdict, r.status), executionStatus: r.status, confidence: r.confidence,
    evidenceRefs: [...new Set(r.evidence.map((e) => `${e.kind}:${e.ref}`))].sort().slice(0, 40), riskFlags: flags, reasoningSummary: sanitizeText(summary, 400), inputSnapshotRef: r.inputSnapshotRef, errorCode: r.errorCode,
  };
}
export interface Contradiction { supportive: string[]; opposing: string[]; opposingVerdict: "ADVERSE" | "BLOCKING" }
/** A contradiction exists when completed agents disagree: at least one SUPPORTIVE and at least one ADVERSE / BLOCKING. It is reported, never averaged away. */
export function findContradictions(reports: readonly SpecAgentReport[]): Contradiction[] {
  const sup = reports.filter((r) => r.verdict === "SUPPORTIVE").map((r) => r.agentId).sort();
  const out: Contradiction[] = [];
  for (const v of ["BLOCKING", "ADVERSE"] as const) {
    const opp = reports.filter((r) => r.verdict === v).map((r) => r.agentId).sort();
    if (sup.length > 0 && opp.length > 0) out.push({ supportive: sup, opposing: opp, opposingVerdict: v });
  }
  return out;
}
