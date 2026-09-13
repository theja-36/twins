import { describe, expect, it } from "vitest";
import { buildCounterThesis } from "../../../packages/decision-intelligence/src/counterThesis";
import type { Thesis } from "../../../packages/decision-intelligence/src/types";

const emptyThesis = (stance: Thesis["stance"]): Thesis => ({ stance, factors: [], evidenceIds: [], strength: "weak" });

describe("buildCounterThesis", () => {
  it("derives from the bear thesis when the signal direction is buy", () => {
    const bull = emptyThesis("supporting");
    const bear: Thesis = {
      stance: "contradicting",
      factors: [{ ruleId: "bear.negative_convention_event", description: "bankruptcy filed", evidenceId: "evt-1" }],
      evidenceIds: ["evt-1"],
      strength: "weak",
    };
    const counter = buildCounterThesis("buy", bull, bear);
    expect(counter.opposingDirection).toBe("sell");
    expect(counter.strongestFactor?.ruleId).toBe("bear.negative_convention_event");
    expect(counter.severity).toBe("high");
  });

  it("derives from the bull thesis when the signal direction is sell", () => {
    const bull: Thesis = {
      stance: "supporting",
      factors: [{ ruleId: "bull.positive_convention_event", description: "dividend declared", evidenceId: "evt-2" }],
      evidenceIds: ["evt-2"],
      strength: "weak",
    };
    const bear = emptyThesis("contradicting");
    const counter = buildCounterThesis("sell", bull, bear);
    expect(counter.opposingDirection).toBe("buy");
    expect(counter.strongestFactor?.ruleId).toBe("bull.positive_convention_event");
  });

  it("picks the highest-severity factor among several", () => {
    const bear: Thesis = {
      stance: "contradicting",
      factors: [
        { ruleId: "bear.unresolved_entity", description: "low severity" },
        { ruleId: "bear.negative_convention_event", description: "high severity", evidenceId: "evt-1" },
        { ruleId: "bear.stale_market_data", description: "medium severity" },
      ],
      evidenceIds: ["evt-1"],
      strength: "moderate",
    };
    const counter = buildCounterThesis("buy", emptyThesis("supporting"), bear);
    expect(counter.severity).toBe("high");
    expect(counter.strongestFactor?.ruleId).toBe("bear.negative_convention_event");
  });

  it("has zero confidence and low severity with no opposing factors", () => {
    const counter = buildCounterThesis("buy", emptyThesis("supporting"), emptyThesis("contradicting"));
    expect(counter.confidence).toBe(0);
    expect(counter.severity).toBe("low");
    expect(counter.strongestFactor).toBeNull();
  });

  it("confidence increases with more opposing factors but never exceeds 1", () => {
    const manyFactors: Thesis = {
      stance: "contradicting",
      factors: Array.from({ length: 10 }, (_, i) => ({ ruleId: "bear.unresolved_entity", description: `factor ${i}` })),
      evidenceIds: [],
      strength: "strong",
    };
    const counter = buildCounterThesis("buy", emptyThesis("supporting"), manyFactors);
    expect(counter.confidence).toBeLessThanOrEqual(1);
    expect(counter.confidence).toBeGreaterThan(0);
  });
});
