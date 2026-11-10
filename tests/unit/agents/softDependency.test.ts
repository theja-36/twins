import { describe, expect, it } from "vitest";
import { AgentRegistry, AgentUnavailableError, orchestrate, validateAgentContract, type AgentRunResult } from "../../../packages/agents/src/index";
import { answer, config, fakeAgent, INPUTS, REF } from "../../support/fakeAgents";

/** A soft dependency orders an agent after an OPTIONAL agent and lets it read that agent's result when COMPLETED, but never skips it. A hard dependency still skips it (pinned elsewhere). */
const go = async (defs: ReturnType<typeof fakeAgent>[], over: Parameters<typeof config>[0] = {}) => {
  const r = new AgentRegistry(); for (const d of defs) r.register(d);
  const cfg = config(over); const plan = r.resolve(cfg);
  return { plan, out: await orchestrate(plan, cfg, INPUTS as never, REF, { sleep: async () => undefined }) };
};
const by = (o: { results: AgentRunResult[] }, id: string): AgentRunResult => o.results.find((x) => x.agentId === id)!;
const dead = () => { throw new AgentUnavailableError("NO_DATA", "no data"); };
let seen: string[] = [];
const watcher = (id: string, hard: string[], soft: string[]) => fakeAgent(id, (ctx) => { seen = Object.keys(ctx.dependencies).sort(); return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }, { dependsOn: hard, softDependsOn: soft });

describe("softDependsOn contract rules", () => {
  const base = fakeAgent("agent_x", answer()).contract;
  it("is optional, sorted, and absent from the validated contract when empty", () => {
    expect(validateAgentContract({ ...base }).softDependsOn).toBeUndefined();
    expect(validateAgentContract({ ...base, softDependsOn: ["agent_b", "agent_a"] }).softDependsOn).toEqual(["agent_a", "agent_b"]);
  });
  it("refuses duplicates, itself, a malformed id, a non-list, and an id that is also a hard dependency", () => {
    for (const bad of [["agent_a", "agent_a"], ["agent_x"], ["Bad Id"], "agent_a", ["agent_a"]]) {
      const c = { ...base, softDependsOn: bad as never, ...(JSON.stringify(bad) === '["agent_a"]' ? { dependsOn: ["agent_a"] } : {}) };
      expect(() => validateAgentContract(c), JSON.stringify(bad)).toThrow();
    }
  });
});
describe("ordering", () => {
  it("a registered soft dependency runs first; an absent or disabled one is ignored (it is soft)", async () => {
    const { plan } = await go([fakeAgent("agent_opt", answer()), watcher("agent_w", [], ["agent_opt"])]);
    expect(plan.levels).toEqual([["agent_opt"], ["agent_w"]]);
    const absent = await go([watcher("agent_w", [], ["agent_missing"])]); expect(absent.plan.levels).toEqual([["agent_w"]]);
    const disabled = await go([fakeAgent("agent_opt", answer()), watcher("agent_w", [], ["agent_opt"])], { disabledAgents: ["agent_opt"] }); expect(disabled.plan.levels).toEqual([["agent_w"]]);
  });
  it("a cycle that runs through a soft dependency is still refused", () => {
    const r = new AgentRegistry();
    r.register(fakeAgent("agent_a", answer(), { softDependsOn: ["agent_b"] })); r.register(fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }));
    expect(() => r.resolve(config())).toThrow(/cycle/i);
  });
});
describe("execution", () => {
  it("a soft dependency that did not complete does NOT skip the agent, and is not passed to it", async () => {
    seen = []; const { out } = await go([fakeAgent("agent_opt", dead), watcher("agent_w", [], ["agent_opt"])]);
    expect(by(out, "agent_opt").status).toBe("UNAVAILABLE");
    expect(by(out, "agent_w")).toMatchObject({ status: "COMPLETED", errorCode: null }); expect(seen).toEqual([]);
  });
  it("a soft dependency that completed IS passed to the agent", async () => {
    seen = []; const { out } = await go([fakeAgent("agent_opt", answer("SUPPORTIVE", 90)), watcher("agent_w", [], ["agent_opt"])]);
    expect(by(out, "agent_w").status).toBe("COMPLETED"); expect(seen).toEqual(["agent_opt"]);
  });
  it("a HARD dependency that did not complete still skips the agent", async () => {
    seen = []; const { out } = await go([fakeAgent("agent_hard", dead), fakeAgent("agent_opt", answer()), watcher("agent_w", ["agent_hard"], ["agent_opt"])]);
    expect(by(out, "agent_w")).toMatchObject({ status: "SKIPPED", errorCode: "DEPENDENCY_NOT_COMPLETED" });
  });
  it("the result does not depend on which finishes first", async () => {
    const a = await go([fakeAgent("agent_opt", answer()), watcher("agent_w", [], ["agent_opt"])]), b = await go([watcher("agent_w", [], ["agent_opt"]), fakeAgent("agent_opt", answer())]);
    expect(a.out.results.map((r) => [r.agentId, r.status])).toEqual(b.out.results.map((r) => [r.agentId, r.status]));
  });
});
