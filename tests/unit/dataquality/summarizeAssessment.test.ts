import { describe, expect, it } from "vitest";
import { summarizeAssessment, type DimensionOutcome } from "../../../packages/dataquality/src/types";

const input = { entityType: "market_observations", entityId: "abc", source: "test-provider" };

describe("summarizeAssessment", () => {
  it("is trusted when every applicable dimension passes", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "validity", ruleId: "r1", passed: true, applicable: true },
      { dimension: "freshness", ruleId: "r2", passed: true, applicable: true },
      { dimension: "anomaly", ruleId: "r3", passed: true, applicable: false },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.overallStatus).toBe("trusted");
    expect(result.qualityScore).toBe(1);
    expect(result.reasons).toEqual([]);
  });

  it("is rejected when validity fails, regardless of other dimensions", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "validity", ruleId: "r1", passed: false, applicable: true, detail: "bad data" },
      { dimension: "freshness", ruleId: "r2", passed: true, applicable: true },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.overallStatus).toBe("rejected");
    expect(result.reasons).toContain("bad data");
  });

  it("is rejected when lineage fails", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "validity", ruleId: "r1", passed: true, applicable: true },
      { dimension: "lineage", ruleId: "r2", passed: false, applicable: true },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.overallStatus).toBe("rejected");
  });

  it("is flagged (not rejected) when a non-hard dimension fails", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "validity", ruleId: "r1", passed: true, applicable: true },
      { dimension: "anomaly", ruleId: "r2", passed: false, applicable: true, detail: "big jump" },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.overallStatus).toBe("flagged");
    expect(result.qualityScore).toBe(0.5);
  });

  it("excludes non-applicable dimensions from the score", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "validity", ruleId: "r1", passed: true, applicable: true },
      { dimension: "anomaly", ruleId: "r2", passed: false, applicable: false },
      { dimension: "cross_source_conflict", ruleId: "r3", passed: false, applicable: false },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.qualityScore).toBe(1);
    expect(result.overallStatus).toBe("trusted");
  });

  it("scores 1 when there are no applicable dimensions at all", () => {
    const outcomes: DimensionOutcome[] = [
      { dimension: "anomaly", ruleId: "r1", passed: false, applicable: false },
    ];
    const result = summarizeAssessment(input, outcomes);
    expect(result.qualityScore).toBe(1);
    expect(result.overallStatus).toBe("trusted");
  });

  it("carries through entityType/entityId/source unchanged", () => {
    const result = summarizeAssessment(input, []);
    expect(result.entityType).toBe(input.entityType);
    expect(result.entityId).toBe(input.entityId);
    expect(result.source).toBe(input.source);
  });
});
