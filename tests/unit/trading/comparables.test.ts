import { describe, expect, it } from "vitest";
import { comparablePatterns } from "../../../packages/decision/src";

const report = (o: Record<string, unknown> = {}) => ({ agentId: "historical-pattern-v1", agentVersion: "1", verdict: "SUPPORTIVE", executionStatus: "COMPLETED", evidenceRefs: ["risk_decision:abc", "historical_pattern:lib#breakout|NSE"], reasoningSummary: "n=40, win rate 0.55", errorCode: null, ...o });
describe("comparable historical patterns (M12-28)", () => {
  it("lists the pattern the historical agent cited, descriptively", () => {
    expect(comparablePatterns({ reports: [report()] })).toMatchObject({ state: "AVAILABLE", verdict: "SUPPORTIVE", patterns: ["historical_pattern:lib#breakout|NSE"] });
  });
  it("is NOT_AVAILABLE, listing nothing, without a package, a report, a completed agent or a cited pattern", () => {
    expect(comparablePatterns(null)).toMatchObject({ state: "NOT_AVAILABLE", reason: "NO_RESEARCH_PACKAGE", patterns: [] });
    expect(comparablePatterns({ reports: [] })).toMatchObject({ reason: "NO_PATTERN_REPORT" });
    expect(comparablePatterns({})).toMatchObject({ reason: "NO_PATTERN_REPORT" });
    expect(comparablePatterns({ reports: [report({ executionStatus: "UNAVAILABLE", errorCode: "NO_MATCHING_PATTERN" })] })).toMatchObject({ reason: "PATTERN_AGENT_INCOMPLETE", patterns: [] });
    expect(comparablePatterns({ reports: [report({ evidenceRefs: ["risk_decision:abc"] })] })).toMatchObject({ reason: "NO_PATTERN_REFERENCE" });
  });
  it("ignores other agents' reports and malformed entries", () => {
    expect(comparablePatterns({ reports: [{ agentId: "other" }, null, report()] })).toMatchObject({ state: "AVAILABLE" });
  });
});
