import { describe, expect, it } from "vitest";
import { assessSourceReliability } from "../../../packages/decision-intelligence/src/sourceReliability";

describe("assessSourceReliability", () => {
  it("always returns UNKNOWN with a documented, non-fabricated reason", () => {
    const result = assessSourceReliability();
    expect(result.level).toBe("UNKNOWN");
    expect(result.reason).toMatch(/no historical/i);
  });

  it("is deterministic and takes no arguments that could be used to fabricate a score", () => {
    expect(assessSourceReliability.length).toBe(0);
  });
});
