import { describe, expect, it } from "vitest";
import { MIN_ACTIVATION_RESOLVED, activationRefusals, buildChannelProfile, buildPlaybookContent, isLegalPlaybookTransition, type ChannelSignal, type PlaybookEvaluation, type PlaybookState } from "../../../packages/historical/src/strategy/index";

const owner = { kind: "OWNER" as const, id: "owner" }, system = { kind: "SYSTEM" as const, id: "learning-job" };
const good: PlaybookEvaluation = { outOfSample: true, resolved: 40, driftFlag: false, evaluatedAt: "2026-11-09T00:00:00Z", metrics: { winRate: 0.5 } };

describe("playbook lifecycle rules", () => {
  it("allows only the documented ordinary transitions; final states are final", () => {
    const states: PlaybookState[] = ["DRAFT", "EVALUATING", "ACTIVE", "RETIRED", "ROLLED_BACK"];
    const ok = new Set(["DRAFT>EVALUATING", "DRAFT>RETIRED", "EVALUATING>ACTIVE", "EVALUATING>DRAFT", "EVALUATING>RETIRED", "ACTIVE>RETIRED", "ACTIVE>ROLLED_BACK"]);
    for (const a of states) for (const b of states) expect(isLegalPlaybookTransition(a, b), `${a}>${b}`).toBe(ok.has(`${a}>${b}`));
    expect(isLegalPlaybookTransition("DRAFT", "ACTIVE")).toBe(false); // never straight to live
    expect(isLegalPlaybookTransition("RETIRED", "ACTIVE")).toBe(false); // only a rollback may restore
  });
  it("activation needs the owner AND a sufficient out-of-sample evaluation without drift", () => {
    expect(activationRefusals(owner, good)).toEqual([]);
    expect(activationRefusals(system, good)).toEqual(["only_the_owner_can_activate"]); // automation can never activate
    expect(activationRefusals(owner, null)).toEqual(["not_evaluated"]);
    expect(activationRefusals(owner, { ...good, outOfSample: false })).toEqual(["evaluation_not_out_of_sample"]);
    expect(activationRefusals(owner, { ...good, resolved: MIN_ACTIVATION_RESOLVED - 1 })).toEqual(["evaluation_sample_too_small"]);
    expect(activationRefusals(owner, { ...good, driftFlag: true })).toEqual(["drift_detected"]);
    expect(activationRefusals(system, null)).toEqual(["only_the_owner_can_activate", "not_evaluated"]);
  });
  it("activation does not ask for profitability: it asks for honest, sufficient evidence", () => { expect(activationRefusals(owner, { ...good, metrics: { winRate: 0.1, expectancyR: -2 } })).toEqual([]); });
});

describe("playbook content from a profile", () => {
  const sigs: ChannelSignal[] = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, at: new Date(Date.UTC(2026, 10, 1 + (i % 20), 4, 30)), underlying: "NIFTY", optionType: "CE", action: "buy", entryKind: "above", setup: "BREAKOUT", horizon: "INTRADAY", sessionBucket: "MORNING", riskProfile: "MODERATE", stopPresent: true, stopDistancePct: 20, firstTargetDistancePct: 30, rewardToRisk: [1.5], targetCount: 2, levelBasisStated: false }));
  it("states what was observed, carries the sample size and limits, and makes no performance claim", () => {
    const c = buildPlaybookContent(buildChannelProfile(sigs));
    expect(c.historicalPerformance).toBeNull(); expect(c.sampleSize).toBe(30); expect(c.preferredInstruments).toEqual(["NIFTY"]); expect(c.entryRules).toMatchObject({ entryStyle: "ABOVE", optionSide: "CE" });
    expect(c.limitations.join(" ")).toMatch(/not performance/); expect(c.description).toMatch(/Descriptive only/); expect(c.preferredRegimes).toEqual([]); // no regime was supplied, so none is claimed
  });
  it("is deterministic", () => { const p = buildChannelProfile(sigs); expect(buildPlaybookContent(p)).toEqual(buildPlaybookContent(p)); });
});
