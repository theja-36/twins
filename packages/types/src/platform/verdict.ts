/**
 * Verdict vocabulary of the spec (Module 04). The existing agent contract uses `UNAVAILABLE`; the spec calls that state `INCOMPLETE`.
 * Rule: missing or unavailable evidence is never supportive.
 */
export const SPEC_VERDICTS = ["SUPPORTIVE", "CAUTION", "NEUTRAL", "ADVERSE", "INCOMPLETE", "BLOCKING"] as const;
export type SpecVerdict = (typeof SPEC_VERDICTS)[number];
export type LegacyAgentVerdict = "SUPPORTIVE" | "NEUTRAL" | "CAUTION" | "ADVERSE" | "BLOCKING" | "UNAVAILABLE";
export type AgentRunStatus = "COMPLETED" | "FAILED" | "TIMEOUT" | "SKIPPED" | "UNAVAILABLE";

/** Maps an agent result to the spec vocabulary. Anything that did not complete is INCOMPLETE, whatever verdict it carried. */
export function toSpecVerdict(verdict: LegacyAgentVerdict, status: AgentRunStatus): SpecVerdict {
  if (status !== "COMPLETED" || verdict === "UNAVAILABLE") return "INCOMPLETE";
  return verdict;
}
/** Used by scoring: only a completed SUPPORTIVE verdict counts for a candidate; INCOMPLETE counts for nothing. */
export const countsAsSupport = (v: SpecVerdict): boolean => v === "SUPPORTIVE";
export const isHardStop = (v: SpecVerdict): boolean => v === "BLOCKING";
