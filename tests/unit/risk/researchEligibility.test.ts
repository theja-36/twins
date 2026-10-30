import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG } from "../../../packages/agents/src/index";
import { DEFAULT_RESEARCH_ELIGIBILITY, ELIGIBILITY_REASONS, latestResearchAssessment, loadResearchEligibilityConfig, researchEligibilityReasons, RESEARCH_REFUSAL_CODES, type ResearchEligibilityConfig } from "../../../packages/risk/src/index";
import type { Db } from "../../../packages/database/src/index";

/** A fake Db whose `execute` returns the given assessment row (or none), or throws. */
const dbWith = (assessment: string | null | "throw"): Db => ({
  execute: async () => { if (assessment === "throw") throw new Error("relation does not exist SECRET-DETAIL"); return { rows: assessment === null ? [] : [{ run_id: "r1", assessment, run_version: 2, created_at: "2025-01-06T04:00:00Z" }] }; },
}) as unknown as Db;
const d = { signalId: "11111111-1111-4111-8111-111111111111", optionsClaimId: null, decisionVersion: 5 };
const cfg = (over: Partial<ResearchEligibilityConfig> = {}): ResearchEligibilityConfig => ({ ...DEFAULT_RESEARCH_ELIGIBILITY, engineEnabled: true, ...over });

describe("research eligibility configuration (strict, conservative defaults)", () => {
  it("defaults: enforced, a missing assessment refuses, engine disabled is ignored, the three mandatory assessments refuse", () => {
    expect(loadResearchEligibilityConfig({})).toEqual({ enforced: true, onMissing: "REFUSE", whenEngineDisabled: "IGNORE", refuseOn: ["RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE"].sort(), engineEnabled: false });
    expect(DEFAULT_RESEARCH_ELIGIBILITY.refuseOn.slice().sort()).toEqual([...DEFAULT_AGENT_CONFIG.haltOn].sort()); // eligibility refuses exactly what the worker halts on, by default
  });
  it("parses every override", () => {
    expect(loadResearchEligibilityConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_RESEARCH_ELIGIBILITY_ENFORCED: "false", TWINS_RESEARCH_ELIGIBILITY_ON_MISSING: "ALLOW", TWINS_RESEARCH_ELIGIBILITY_WHEN_ENGINE_DISABLED: "REQUIRE",
      TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON: "RESEARCH_CAUTION,RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE" }))
      .toEqual({ enforced: false, onMissing: "ALLOW", whenEngineDisabled: "REQUIRE", refuseOn: ["RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_CAUTION", "RESEARCH_INCOMPLETE"], engineEnabled: true });
  });
  it.each<[string, Record<string, string>]>([
    ["a non-boolean switch", { TWINS_RESEARCH_ELIGIBILITY_ENFORCED: "yes" }], ["a bad missing policy", { TWINS_RESEARCH_ELIGIBILITY_ON_MISSING: "MAYBE" }], ["a bad engine-disabled policy", { TWINS_RESEARCH_ELIGIBILITY_WHEN_ENGINE_DISABLED: "NEVER" }],
    ["an unknown assessment", { TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON: "RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE,RESEARCH_GREAT" }], ["a list that drops a mandatory assessment", { TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON: "RESEARCH_BLOCKED,RESEARCH_INCOMPLETE" }],
    ["a list that refuses SUPPORTIVE", { TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON: "RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE,RESEARCH_SUPPORTIVE" }], ["a non-boolean engine switch", { TWINS_AGENT_ENGINE_ENABLED: "1" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadResearchEligibilityConfig(env)).toThrow(); });
  it("the refusal codes are fixed, distinct and listed among the eligibility reasons", () => {
    const codes = Object.values(RESEARCH_REFUSAL_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(ELIGIBILITY_REASONS as readonly string[]).toContain(c);
    expect(RESEARCH_REFUSAL_CODES).toMatchObject({ RESEARCH_BLOCKED: "research_assessment_blocked", RESEARCH_INCOMPLETE: "research_assessment_incomplete", RESEARCH_ADVERSE: "research_assessment_adverse", missing: "research_assessment_missing", unavailable: "research_assessment_unavailable" });
  });
});

describe("research eligibility reasons", () => {
  it.each([["RESEARCH_BLOCKED", "research_assessment_blocked"], ["RESEARCH_INCOMPLETE", "research_assessment_incomplete"], ["RESEARCH_ADVERSE", "research_assessment_adverse"]] as const)("%s refuses with %s", async (a, code) => {
    expect(await researchEligibilityReasons(dbWith(a), d, cfg())).toEqual([code]);
    expect(await researchEligibilityReasons(dbWith(a), d, cfg({ engineEnabled: false }))).toEqual([code]); // an existing bad assessment refuses even if the engine is later disabled
  });
  it.each(["RESEARCH_CAUTION", "RESEARCH_NEUTRAL", "RESEARCH_SUPPORTIVE"])("%s does not refuse (the existing eligibility rules continue)", async (a) => {
    expect(await researchEligibilityReasons(dbWith(a), d, cfg())).toEqual([]);
  });
  it("CAUTION or NEUTRAL can be made refusing by configuration, SUPPORTIVE cannot", async () => {
    expect(await researchEligibilityReasons(dbWith("RESEARCH_CAUTION"), d, cfg({ refuseOn: ["RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_CAUTION", "RESEARCH_INCOMPLETE"] }))).toEqual(["research_assessment_caution"]);
    expect(await researchEligibilityReasons(dbWith("RESEARCH_SUPPORTIVE"), d, cfg())).toEqual([]);
  });
  it("a missing assessment refuses when the engine is enabled; ALLOW lets it pass; with the engine disabled it is ignored unless REQUIRE", async () => {
    expect(await researchEligibilityReasons(dbWith(null), d, cfg())).toEqual(["research_assessment_missing"]);
    expect(await researchEligibilityReasons(dbWith(null), d, cfg({ onMissing: "ALLOW" }))).toEqual([]);
    expect(await researchEligibilityReasons(dbWith(null), d, cfg({ engineEnabled: false }))).toEqual([]);
    expect(await researchEligibilityReasons(dbWith(null), d, cfg({ engineEnabled: false, whenEngineDisabled: "REQUIRE" }))).toEqual(["research_assessment_missing"]);
  });
  it("an unreadable assessment store fails closed when a check applies and the provider message is never leaked; engine disabled is unchanged", async () => {
    const r = await researchEligibilityReasons(dbWith("throw"), d, cfg());
    expect(r).toEqual(["research_assessment_unavailable"]); expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
    expect(await researchEligibilityReasons(dbWith("throw"), d, cfg({ engineEnabled: false }))).toEqual([]);
  });
  it("enforced = false skips the application-layer re-check entirely", async () => {
    expect(await researchEligibilityReasons(dbWith("RESEARCH_ADVERSE"), d, cfg({ enforced: false }))).toEqual([]);
    expect(await researchEligibilityReasons(dbWith(null), d, cfg({ enforced: false }))).toEqual([]);
  });
  it("an unknown stored assessment is an error (fail closed), not a pass", async () => {
    await expect(latestResearchAssessment(dbWith("RESEARCH_GREAT"), d)).rejects.toThrow();
    expect(await researchEligibilityReasons(dbWith("RESEARCH_GREAT"), d, cfg())).toEqual(["research_assessment_unavailable"]);
  });
});
