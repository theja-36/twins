/** SYNTHETIC, valid recorded source intelligence for risk-decision fixtures (trust A / confidence HIGH). No scorecard or pattern library is read. */
export function validIntelligence(over: { trustTier?: "A" | "B" | "C" | "D" | "UNKNOWN"; confidenceTier?: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"; score?: number; status?: "VALID" | "UNAVAILABLE"; reasonCode?: string } = {}): Record<string, unknown> {
  const trustTier = over.trustTier ?? "A", confidenceTier = over.confidenceTier ?? "HIGH";
  const sizing = { A: "HIGH", B: "MODERATE", C: "LOW", D: "UNTRUSTED", UNKNOWN: "UNKNOWN" }[trustTier];
  return {
    engineVersion: "source-intelligence-v1", status: over.status ?? "VALID", reasonCode: over.reasonCode ?? "OK", sizingTrustTier: sizing,
    sourceIdentity: { label: "itest-source", registryId: null, members: ["itest-source"], registered: true },
    trust: { status: "AVAILABLE", tier: trustTier, label: "SYNTHETIC", reason: "SCORECARD", scorecardRunId: null, asOf: "2024-01-01T00:00:00.000Z", algorithmVersion: "source-scorecard-v1+trust-tier-v1", configSha256: null, evaluable: 60, dataSufficiency: "SUFFICIENT" },
    confidence: { score: over.score ?? 90, tier: confidenceTier, evidenceQuality: "SUFFICIENT", sampleSize: 60, primaryPatternKey: "L1|synthetic", patternRunId: null, patternRunAsOf: "2024-01-01T00:00:00.000Z", patternRefs: [], algorithmVersion: "pattern-confidence-v1", featureVersion: "pattern-features-v1" },
    dataSufficiency: "SUFFICIENT", explanation: [{ rule: "SYNTHETIC_FIXTURE", detail: "test fixture" }], limitations: ["HISTORICAL_ASSOCIATION_ONLY"], asOf: "2024-01-01T00:00:00.000Z", inputHash: "f".repeat(64),
  };
}
