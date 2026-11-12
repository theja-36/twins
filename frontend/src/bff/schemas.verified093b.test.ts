import { describe, expect, it } from "vitest";
import { AGENT_REPORT_KEYS, DECISION_EXPLANATION_KEYS, EXPLANATION_PROVENANCE_KEYS, INSIGHT_ROW_KEYS, PERFORMANCE_METRICS_KEYS, RESEARCH_PACKAGE_BODY_KEYS, RESEARCH_PACKAGE_BODY_OPTIONAL_KEYS, SNAPSHOT_META_KEYS } from "@twins/api-contracts";
import { AgentReport, DecisionExplanation, InsightRow, PerformanceMetrics, ResearchPackageBody, SnapshotMeta } from "./schemas.verified093b";

const sorted = (a: readonly string[]): string[] => [...a].sort();
const H = "a".repeat(64), T = "2031-01-06T05:00:00.000Z";
describe("Stage 09.3B.1 strict schemas declare exactly the verified contract keys", () => {
  it("research package, agent report, explanation, provenance, metrics, snapshot and insight", () => {
    expect(sorted(Object.keys(ResearchPackageBody.shape))).toEqual(sorted([...RESEARCH_PACKAGE_BODY_KEYS, ...RESEARCH_PACKAGE_BODY_OPTIONAL_KEYS]));
    expect(sorted(Object.keys(AgentReport.shape))).toEqual(sorted([...AGENT_REPORT_KEYS, "supplementsRoles"]));
    expect(sorted(Object.keys(DecisionExplanation.shape))).toEqual(sorted(DECISION_EXPLANATION_KEYS));
    expect(sorted(Object.keys(DecisionExplanation.shape.provenance.shape))).toEqual(sorted(EXPLANATION_PROVENANCE_KEYS));
    expect(sorted(Object.keys(PerformanceMetrics.shape))).toEqual(sorted(PERFORMANCE_METRICS_KEYS));
    expect(sorted(Object.keys(SnapshotMeta.shape))).toEqual(sorted(SNAPSHOT_META_KEYS));
    expect(sorted(Object.keys(InsightRow.shape))).toEqual(sorted(INSIGHT_ROW_KEYS));
  });
  it("refuses what the backend never sends: an approval-granting package, a numeric money field, a bad hash, an insight recommending anything but REVIEW", () => {
    const rep = { agentId: "a", agentVersion: "1", role: null, verdict: "SUPPORTIVE", executionStatus: "COMPLETED", confidence: 70, evidenceRefs: [], riskFlags: [], reasoningSummary: "s", inputSnapshotRef: "r", errorCode: null, secretField: "x" };
    expect(JSON.stringify(AgentReport.parse(rep))).not.toContain("secretField"); expect(AgentReport.safeParse({ ...rep, verdict: "APPROVED" }).success).toBe(false);
    const pkg = { packageVersion: "v", candidateId: "c", candidateSource: "INDEPENDENT", dataSource: "FIXTURE", version: 1, assessment: "X", halt: false, haltReason: null, score: null, synthesisAlgorithmVersion: "s", reports: [rep], contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: {}, evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: H, packageSha256: H };
    expect(ResearchPackageBody.safeParse(pkg).success).toBe(true); expect(ResearchPackageBody.safeParse({ ...pkg, grantsApproval: true }).success).toBe(false); expect(ResearchPackageBody.safeParse({ ...pkg, packageSha256: "zz" }).success).toBe(false);
    const snap = { id: "s", asOf: T, createdAt: T, verifiedAt: T, evidenceHash: H, inputHash: H, configHash: H, algorithmVersions: { a: "1" }, createdBy: "API", freshness: "STALE", staleReason: "x", complete: true, maxAgeSeconds: 60 };
    expect(SnapshotMeta.safeParse(snap).success).toBe(true); expect(SnapshotMeta.safeParse({ ...snap, freshness: "FRESH" }).success).toBe(false);
    const ins = { id: "i", insightKey: "k", kind: "PERFORMANCE", scope: "s", subject: "x", outcomeCount: 1, periodStart: null, periodEnd: null, provenance: {}, method: "m", algorithmVersion: "1", evidenceRefs: [], reliability: "INSUFFICIENT_DATA", severity: "INFO", statement: "s", metrics: {}, limitations: [], recommendation: "REVIEW", createdAt: T };
    expect(InsightRow.safeParse(ins).success).toBe(true); expect(InsightRow.safeParse({ ...ins, recommendation: "REDUCE_SIZE" }).success).toBe(false); expect(InsightRow.safeParse({ ...ins, recommendation: null }).success).toBe(true);
    const m = PerformanceMetrics.shape; expect(m.netPnl.safeParse(12.5).success).toBe(false); expect(m.netPnl.safeParse("12.50").success).toBe(true); // money is an exact string, never a number
  });
});
