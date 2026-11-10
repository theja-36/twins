import { describe, expect, it } from "vitest";
import { deriveResearchStatus, RESEARCH_STATUSES } from "../../../packages/agents/src/index";

describe("research status (derived from stored state; nothing new is persisted)", () => {
  it("defines exactly the eight specified statuses", () => { expect([...RESEARCH_STATUSES]).toEqual(["PENDING", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "EXPIRED", "SUPERSEDED", "CANCELLED"]); });
  it("maps every candidate state", () => {
    expect(deriveResearchStatus({ candidateState: "NEW", hasPackage: false })).toBe("PENDING");
    expect(deriveResearchStatus({ candidateState: "IN_RESEARCH", hasPackage: false })).toBe("RUNNING");
    expect(deriveResearchStatus({ candidateState: "EXPIRED", hasPackage: true })).toBe("EXPIRED");
    expect(deriveResearchStatus({ candidateState: "SUPERSEDED", hasPackage: true })).toBe("SUPERSEDED");
    expect(deriveResearchStatus({ candidateState: "WITHDRAWN", hasPackage: false })).toBe("CANCELLED");
    expect(deriveResearchStatus({ candidateState: "INVALIDATED", hasPackage: true })).toBe("CANCELLED");
  });
  it("a package is COMPLETED, unless it is RESEARCH_INCOMPLETE, which is PARTIAL (a partial package is never a pass)", () => {
    for (const a of ["RESEARCH_SUPPORTIVE", "RESEARCH_NEUTRAL", "RESEARCH_CAUTION", "RESEARCH_ADVERSE", "RESEARCH_BLOCKED"] as const) expect(deriveResearchStatus({ candidateState: "READY_FOR_DECISION", hasPackage: true, assessment: a }), a).toBe("COMPLETED");
    expect(deriveResearchStatus({ candidateState: "READY_FOR_DECISION", hasPackage: true, assessment: "RESEARCH_INCOMPLETE" })).toBe("PARTIAL");
  });
  it("FAILED is a candidate the dispatcher withdrew after exhausting its research attempts with no package; any other withdrawal is CANCELLED", () => {
    expect(deriveResearchStatus({ candidateState: "WITHDRAWN", hasPackage: false, attempts: 3, maxAttempts: 3 })).toBe("FAILED");
    expect(deriveResearchStatus({ candidateState: "WITHDRAWN", hasPackage: false, attempts: 1, maxAttempts: 3 })).toBe("CANCELLED");
    expect(deriveResearchStatus({ candidateState: "WITHDRAWN", hasPackage: true, assessment: "RESEARCH_SUPPORTIVE", attempts: 3, maxAttempts: 3 })).toBe("CANCELLED");
    expect(deriveResearchStatus({ candidateState: "WITHDRAWN", hasPackage: false })).toBe("CANCELLED");
    expect(deriveResearchStatus({ candidateState: "NEW", hasPackage: true, assessment: "RESEARCH_SUPPORTIVE" })).toBe("COMPLETED");
  });
  it("an inconsistent or unknown state is null, never guessed (READY without a package; a state this model does not know)", () => {
    expect(deriveResearchStatus({ candidateState: "READY_FOR_DECISION", hasPackage: false })).toBeNull();
    expect(deriveResearchStatus({ candidateState: "MYSTERY", hasPackage: true })).toBeNull();
  });
});
