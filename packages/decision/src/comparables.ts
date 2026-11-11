/**
 * Comparable historical patterns of a decision (Stage 07, M12-28). A read-only view over the research package the decision was made on: what the historical-pattern agent found, taken from its stored report. Nothing is
 * computed here and nothing is invented; with no pattern provider wired (G-23) or an incomplete agent the view says so and lists no pattern.
 */
export const COMPARABLES_VERSION = "comparables-v1";
export interface ComparableReport { agentId: string; agentVersion?: string; verdict?: string; executionStatus?: string; evidenceRefs?: string[]; reasoningSummary?: string; errorCode?: string | null }
export type ComparablePatterns =
  | { state: "AVAILABLE"; version: string; verdict: string; patterns: string[]; summary: string; note: string }
  | { state: "NOT_AVAILABLE"; version: string; reason: "NO_RESEARCH_PACKAGE" | "NO_PATTERN_REPORT" | "PATTERN_AGENT_INCOMPLETE" | "NO_PATTERN_REFERENCE"; detail: string; patterns: [] };

export function comparablePatterns(pkg: unknown): ComparablePatterns {
  const no = (reason: Extract<ComparablePatterns, { state: "NOT_AVAILABLE" }>["reason"], detail: string): ComparablePatterns => ({ state: "NOT_AVAILABLE", version: COMPARABLES_VERSION, reason, detail, patterns: [] });
  if (!pkg || typeof pkg !== "object") return no("NO_RESEARCH_PACKAGE", "the decision has no stored research package");
  const reports = (pkg as { reports?: unknown }).reports;
  const r = Array.isArray(reports) ? (reports as ComparableReport[]).find((x) => x && x.agentId === "historical-pattern-v1") : undefined;
  if (!r) return no("NO_PATTERN_REPORT", "the research package has no historical-pattern report");
  if (r.executionStatus !== "COMPLETED") return no("PATTERN_AGENT_INCOMPLETE", `the historical-pattern agent did not complete${r.errorCode ? ` (${String(r.errorCode).slice(0, 60)})` : ""}; no comparable pattern is listed`);
  const patterns = (Array.isArray(r.evidenceRefs) ? r.evidenceRefs : []).filter((e) => typeof e === "string" && e.startsWith("historical_pattern")).slice(0, 20);
  if (patterns.length === 0) return no("NO_PATTERN_REFERENCE", "the agent completed but cited no historical pattern");
  return { state: "AVAILABLE", version: COMPARABLES_VERSION, verdict: String(r.verdict ?? "UNKNOWN"), patterns, summary: String(r.reasoningSummary ?? "").slice(0, 500), note: "Historical comparison is descriptive; it is not a forecast and does not change the decision." };
}
