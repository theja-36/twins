import { describe, expect, it } from "vitest";
import { AgentContractError, AgentRegistry, createDefaultRegistry, loadAgentEngineConfig, sanitizeText, stableStringify, validateAgentContract, validateAgentOutput } from "../../../packages/agents/src/index";
import { answer, contractOf, fakeAgent } from "../../support/fakeAgents";

const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as AgentContractError).code; } return undefined; };

describe("agent contract validation", () => {
  it("accepts a well-formed contract and returns a normalized copy", () => {
    const c = validateAgentContract(contractOf("momentum_check", { dependsOn: ["zeta_agent", "alpha_agent"] }));
    expect(c).toMatchObject({ agentId: "momentum_check", version: "1.0.0", weight: 50, canBlock: false, advisoryOnly: false });
    expect(c.dependsOn).toEqual(["alpha_agent", "zeta_agent"]);
  });
  it.each<[string, Record<string, unknown>, string]>([
    ["a bad id", { agentId: "Bad-Id" }, "INVALID_AGENT_ID"], ["a too-short id", { agentId: "ab" }, "INVALID_AGENT_ID"], ["a bad name", { agentName: "x" }, "INVALID_AGENT_NAME"],
    ["a bad version", { version: "1.0" }, "INVALID_VERSION"], ["an unknown required input", { requiredInputs: ["raw_message"] }, "INVALID_INPUT_DECLARATION"],
    ["an input both required and optional", { requiredInputs: ["risk_decision"], optionalInputs: ["risk_decision"] }, "INVALID_INPUT_DECLARATION"],
    ["a duplicate input", { requiredInputs: ["risk_decision", "risk_decision"] }, "INVALID_INPUT_DECLARATION"],
    ["a timeout that is too small", { timeoutMs: 10 }, "INVALID_TIMEOUT"], ["a timeout that is too large", { timeoutMs: 999_999 }, "INVALID_TIMEOUT"],
    ["too many attempts", { retry: { maxAttempts: 6, backoffMs: 0 } }, "INVALID_RETRY_POLICY"], ["a missing retry policy", { retry: undefined }, "INVALID_RETRY_POLICY"],
    ["a negative weight", { weight: -1 }, "INVALID_WEIGHT"], ["a weight above 100", { weight: 101 }, "INVALID_WEIGHT"], ["a fractional weight", { weight: 1.5 }, "INVALID_WEIGHT"],
    ["non-boolean flags", { canBlock: "yes" }, "INVALID_FLAGS"], ["an advisory agent that can block", { canBlock: true, advisoryOnly: true }, "ADVISORY_CANNOT_BLOCK"],
    ["self-dependency", { dependsOn: ["fake_a"] }, "INVALID_DEPENDENCIES"], ["a duplicate dependency", { dependsOn: ["other_one", "other_one"] }, "INVALID_DEPENDENCIES"],
    ["an output schema with a bad type", { outputSchema: { fields: { x: { type: "object" } } } }, "INVALID_OUTPUT_SCHEMA"], ["no output schema", { outputSchema: undefined }, "INVALID_OUTPUT_SCHEMA"],
  ])("rejects %s", (_n, over, expected) => { expect(code(() => validateAgentContract({ ...contractOf("fake_a"), ...over }))).toBe(expected); });
  it("rejects non-objects", () => { for (const v of [null, "x", 3, []]) expect(code(() => validateAgentContract(v))).toBe("CONTRACT_NOT_AN_OBJECT"); });
});

describe("agent output validation (the agent's own object is never kept)", () => {
  const c = contractOf("fake_a", { outputSchema: { fields: { note: { type: "string", required: true }, scores: { type: "number[]" }, flag: { type: "boolean" } } } });
  const good = { verdict: "SUPPORTIVE", confidence: 72.456, findings: [{ code: "SOME_FINDING", severity: "LOW", summary: "ok", detail: { n: 3, s: "x", b: true, z: null } }], evidence: [{ kind: "scorecard", ref: "scorecard:abc", sha256: "a".repeat(64) }], output: { note: "fine", scores: [1, 2], flag: true } };
  it("accepts a good output, rounds confidence and copies it", () => {
    const o = validateAgentOutput(c, good);
    expect(o).toMatchObject({ verdict: "SUPPORTIVE", confidence: 72.46, output: { note: "fine", scores: [1, 2], flag: true } });
    expect(o.findings[0]).toEqual({ code: "SOME_FINDING", severity: "LOW", summary: "ok", detail: { n: 3, s: "x", b: true, z: null } });
    expect(o).not.toBe(good);
  });
  it.each<[string, (o: Record<string, unknown>) => void, string]>([
    ["an unknown verdict", (o) => { o["verdict"] = "GREAT"; }, "OUTPUT_VERDICT_INVALID"], ["BLOCKING from an agent that cannot block", (o) => { o["verdict"] = "BLOCKING"; }, "OUTPUT_BLOCKING_NOT_PERMITTED"],
    ["confidence above 100", (o) => { o["confidence"] = 101; }, "OUTPUT_CONFIDENCE_INVALID"], ["NaN confidence", (o) => { o["confidence"] = Number.NaN; }, "OUTPUT_CONFIDENCE_INVALID"],
    ["a string confidence", (o) => { o["confidence"] = "80"; }, "OUTPUT_CONFIDENCE_INVALID"], ["a finding code in lower case", (o) => { o["findings"] = [{ code: "bad", severity: "LOW", summary: "x" }]; }, "OUTPUT_FINDINGS_INVALID"],
    ["a finding with nested detail", (o) => { o["findings"] = [{ code: "SOME_CODE", severity: "LOW", summary: "x", detail: { a: { b: 1 } } }]; }, "OUTPUT_FINDINGS_INVALID"],
    ["more than 20 findings", (o) => { o["findings"] = Array.from({ length: 21 }, () => ({ code: "SOME_CODE", severity: "LOW", summary: "x" })); }, "OUTPUT_FINDINGS_INVALID"],
    ["evidence with spaces in the reference", (o) => { o["evidence"] = [{ kind: "scorecard", ref: "has space" }]; }, "OUTPUT_EVIDENCE_INVALID"], ["evidence with a bad hash", (o) => { o["evidence"] = [{ kind: "scorecard", ref: "x", sha256: "zz" }]; }, "OUTPUT_EVIDENCE_INVALID"],
    ["an undeclared output field", (o) => { o["output"] = { note: "x", extra: 1 }; }, "OUTPUT_SCHEMA_VIOLATION"], ["a missing required output field", (o) => { o["output"] = {}; }, "OUTPUT_SCHEMA_VIOLATION"],
    ["a wrongly typed output field", (o) => { o["output"] = { note: 5 }; }, "OUTPUT_SCHEMA_VIOLATION"], ["a non-finite number in an array", (o) => { o["output"] = { note: "x", scores: [Number.POSITIVE_INFINITY] }; }, "OUTPUT_SCHEMA_VIOLATION"],
  ])("rejects %s", (_n, mutate, expected) => { const o = structuredClone(good) as Record<string, unknown>; mutate(o); expect(code(() => validateAgentOutput(c, o))).toBe(expected); });
  it("a permitted blocker may return BLOCKING; an advisory agent never", () => {
    expect(validateAgentOutput(contractOf("fake_b", { canBlock: true }), { ...good, output: {}, verdict: "BLOCKING" }).verdict).toBe("BLOCKING");
    expect(code(() => validateAgentOutput(contractOf("fake_c", { advisoryOnly: true }), { ...good, output: {}, verdict: "BLOCKING" }))).toBe("OUTPUT_BLOCKING_NOT_PERMITTED");
  });
  it("redacts secret-shaped text in summaries and strings", () => {
    const token = `${"123456789"}:${"A".repeat(35)}`;
    const o = validateAgentOutput(contractOf("fake_a"), { ...good, output: { note: `see ${token} and trader@example.com` }, findings: [{ code: "SOME_CODE", severity: "LOW", summary: `key ${"AK" + "IAABCDEFGHIJKLMNOP"} bearer token` }] });
    expect(JSON.stringify(o)).not.toContain("123456789");
    expect(JSON.stringify(o)).not.toContain("example.com");
    expect(JSON.stringify(o)).not.toContain("AKIAABC");
    expect(o.output["note"]).toContain("[redacted]");
  });
  it("rejects an oversized output snapshot", () => {
    const big = contractOf("fake_a", { outputSchema: { fields: { items: { type: "string[]" } } } });
    expect(code(() => validateAgentOutput(big, { verdict: "NEUTRAL", confidence: 1, output: { items: Array.from({ length: 50 }, () => "ab cd ".repeat(40)) } }))).toBe("OUTPUT_TOO_LARGE");
  });
});

describe("sanitizeText / stableStringify", () => {
  it("strips control characters, truncates and removes private-key blocks", () => {
    expect(sanitizeText("a\u0000b\nc")).toBe("a b c");
    expect(sanitizeText("word ".repeat(100), 50)).toHaveLength(50);
    expect(sanitizeText("x".repeat(500))).toBe("[redacted]"); // an opaque long token
    expect(sanitizeText(`${"-----BEGIN RSA PRIV"}${"ATE KEY-----"} MIIEvQ... ${"-----END RSA PRIV"}${"ATE KEY-----"}`)).toBe("[redacted]");
  });
  it("is key-order independent", () => { expect(stableStringify({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(stableStringify({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 })); });
});

describe("registry", () => {
  it("registers agents, prevents duplicate ids (any version) and rejects agents without a run function", () => {
    const r = new AgentRegistry();
    r.register(fakeAgent("agent_one", answer()));
    expect(code(() => r.register(fakeAgent("agent_one", answer())))).toBe("DUPLICATE_AGENT_ID");
    expect(code(() => r.register(fakeAgent("agent_one", answer(), { version: "2.0.0" })))).toBe("DUPLICATE_AGENT_ID");
    expect(code(() => r.register({ contract: contractOf("agent_two") } as never))).toBe("AGENT_HAS_NO_RUN");
    expect(code(() => r.register(fakeAgent("Bad", answer())))).toBe("INVALID_AGENT_ID");
    expect(r.has("agent_one")).toBe(true);
    expect(r.snapshot().map((c) => c.agentId)).toEqual(["agent_one"]);
  });
  it("stored contracts are frozen copies (a registered agent cannot be changed afterwards)", () => {
    const r = new AgentRegistry();
    const def = fakeAgent("agent_one", answer());
    r.register(def);
    (def.contract as { weight: number }).weight = 99;
    expect(r.get("agent_one")?.contract.weight).toBe(50);
    expect(() => { (r.get("agent_one")?.contract as { weight: number }).weight = 1; }).toThrow();
  });
  it("orders by dependency (levels), deterministically, regardless of registration order", () => {
    const build = (order: string[]) => {
      const r = new AgentRegistry();
      const defs: Record<string, ReturnType<typeof fakeAgent>> = {
        agent_c: fakeAgent("agent_c", answer(), { dependsOn: ["agent_a", "agent_b"] }), agent_a: fakeAgent("agent_a", answer()), agent_b: fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }), agent_d: fakeAgent("agent_d", answer()),
      };
      for (const id of order) r.register(defs[id] as never);
      return r.resolve({ disabledAgents: [], requiredAgents: [] });
    };
    const a = build(["agent_c", "agent_a", "agent_b", "agent_d"]), b = build(["agent_d", "agent_b", "agent_a", "agent_c"]);
    expect(a.levels).toEqual([["agent_a", "agent_d"], ["agent_b"], ["agent_c"]]);
    expect(b.levels).toEqual(a.levels);
    expect(a.agents.map((x) => x.contract.agentId)).toEqual(["agent_a", "agent_d", "agent_b", "agent_c"]);
  });
  it("rejects a cycle, a missing dependency and a dependency on a disabled agent", () => {
    const cyc = new AgentRegistry();
    cyc.register(fakeAgent("agent_a", answer(), { dependsOn: ["agent_b"] }));
    cyc.register(fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }));
    expect(code(() => cyc.resolve({ disabledAgents: [], requiredAgents: [] }))).toBe("DEPENDENCY_CYCLE");
    const miss = new AgentRegistry();
    miss.register(fakeAgent("agent_a", answer(), { dependsOn: ["agent_zz"] }));
    expect(code(() => miss.resolve({ disabledAgents: [], requiredAgents: [] }))).toBe("DEPENDENCY_NOT_REGISTERED");
    const dis = new AgentRegistry();
    dis.register(fakeAgent("agent_a", answer()));
    dis.register(fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }));
    expect(code(() => dis.resolve({ disabledAgents: ["agent_a"], requiredAgents: [] }))).toBe("DEPENDENCY_DISABLED");
  });
  it("honours the enable / disable configuration and reports required agents that cannot run", () => {
    const r = new AgentRegistry();
    r.register(fakeAgent("agent_a", answer()));
    r.register(fakeAgent("agent_b", answer()));
    const plan = r.resolve({ disabledAgents: ["agent_b"], requiredAgents: ["agent_a", "agent_b", "agent_missing"] });
    expect(plan.agents.map((x) => x.contract.agentId)).toEqual(["agent_a"]);
    expect(plan.missingRequired).toEqual([{ agentId: "agent_b", reason: "DISABLED" }, { agentId: "agent_missing", reason: "NOT_REGISTERED" }]);
  });
  it("the production registry is empty: no research agent is implemented in this task", () => { expect(createDefaultRegistry().snapshot()).toEqual([]); });
});

describe("configuration (disabled by default, strict)", () => {
  it("is disabled by default with conservative halting", () => {
    const c = loadAgentEngineConfig({});
    expect(c).toMatchObject({ enabled: false, requiredAgents: ["index-constituent-impact-v1", "instrument-verification-v1", "macro-global-v1", "market-calendar-v1", "news-sentiment-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1"], maxConcurrency: 4, haltOn: ["RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE", "RESEARCH_ADVERSE"] });
  });
  it("parses overrides", () => {
    const c = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "agent_b, agent_a", TWINS_AGENT_ENGINE_DISABLED_AGENTS: "agent_z", TWINS_AGENT_ENGINE_WEIGHTS: '{"agent_a":70}', TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "2", TWINS_AGENT_ENGINE_HALT_ON: "RESEARCH_BLOCKED" });
    expect(c).toMatchObject({ enabled: true, requiredAgents: ["agent_a", "agent_b"], disabledAgents: ["agent_z"], weights: { agent_a: 70 }, maxConcurrency: 2, haltOn: ["RESEARCH_BLOCKED"] });
  });
  it.each<[string, Record<string, string>]>([
    ["a non-boolean flag", { TWINS_AGENT_ENGINE_ENABLED: "yes" }], ["a bad agent id", { TWINS_AGENT_ENGINE_REQUIRED: "Bad Id" }], ["a duplicate id", { TWINS_AGENT_ENGINE_REQUIRED: "agent_a,agent_a" }],
    ["required and disabled", { TWINS_AGENT_ENGINE_REQUIRED: "agent_a", TWINS_AGENT_ENGINE_DISABLED_AGENTS: "agent_a" }], ["non-JSON weights", { TWINS_AGENT_ENGINE_WEIGHTS: "{nope" }],
    ["an out-of-range weight", { TWINS_AGENT_ENGINE_WEIGHTS: '{"agent_a":500}' }], ["concurrency 0", { TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "0" }], ["concurrency 99", { TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "99" }],
    ["an unknown halt assessment", { TWINS_AGENT_ENGINE_HALT_ON: "RESEARCH_GREAT" }],
  ])("a malformed override (%s) THROWS instead of falling back", (_n, env) => { expect(code(() => loadAgentEngineConfig(env))).toBe("INVALID_ENGINE_CONFIG"); });
});
