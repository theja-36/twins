import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry, AgentUnavailableError, buildSynthesisInput, orchestrate, synthesize, type AgentEvent, type AgentRunResult, type OrchestrationOutcome, type SynthesisInput } from "../../../packages/agents/src/index";
import { answer, config, delay, fakeAgent, INPUTS, REF } from "../../support/fakeAgents";

const run = async (defs: ReturnType<typeof fakeAgent>[], over: Parameters<typeof config>[0] = {}, inputs: Record<string, unknown> = INPUTS, events: AgentEvent[] = [], sleeps: number[] = []): Promise<OrchestrationOutcome> => {
  const r = new AgentRegistry();
  for (const d of defs) r.register(d);
  const cfg = config(over);
  return orchestrate(r.resolve(cfg), cfg, inputs as never, REF, { emit: (e) => events.push(e), sleep: async (ms) => { sleeps.push(ms); } });
};
const by = (o: OrchestrationOutcome, id: string): AgentRunResult => o.results.find((r) => r.agentId === id) as AgentRunResult;

describe("running agents", () => {
  it("runs a simple agent and records the full contract result", async () => {
    const o = await run([fakeAgent("agent_a", answer("SUPPORTIVE", 77.5, { findings: [{ code: "SOME_FINDING", severity: "INFO", summary: "fine" }], evidence: [{ kind: "scorecard", ref: "sc:1" }], output: { note: "hi" } }))]);
    const r = by(o, "agent_a");
    expect(r).toMatchObject({ agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 77.5, attempts: 1, errorCode: null, outputSnapshot: { note: "hi" } });
    expect(r.findings).toHaveLength(1);
    expect(r.evidence).toEqual([{ kind: "scorecard", ref: "sc:1" }]);
    expect(r.inputSnapshotRef).toMatch(/^[0-9a-f]{64}$/);
    expect(r.inputSnapshot).toEqual({ risk_decision: INPUTS.risk_decision });
    expect(r.startedAt).toBeInstanceOf(Date);
    expect(r.completedAt.getTime()).toBeGreaterThanOrEqual(r.startedAt.getTime());
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(o.status).toBe("COMPLETED");
  });
  it("an agent receives ONLY its declared inputs, as frozen copies", async () => {
    let seen: Record<string, unknown> = {};
    let mutation = "none";
    const a = fakeAgent("agent_a", (ctx) => {
      seen = { ...ctx.inputs };
      try { (ctx.inputs["risk_decision"] as { symbol: string }).symbol = "HACKED"; mutation = "allowed"; } catch { mutation = "blocked"; }
      return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} };
    }, { requiredInputs: ["risk_decision"], optionalInputs: ["signal_features"] });
    await run([a]);
    expect(Object.keys(seen).sort()).toEqual(["risk_decision", "signal_features"]);
    expect(mutation).toBe("blocked");
    expect(INPUTS.risk_decision.symbol).toBe("ACME");
  });
  it("runs independent agents in PARALLEL, bounded by maxConcurrency", async () => {
    let running = 0, peak = 0;
    const slow = (id: string) => fakeAgent(id, async () => { running += 1; peak = Math.max(peak, running); await delay(120); running -= 1; return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; });
    const t0 = Date.now();
    await run([slow("agent_a"), slow("agent_b"), slow("agent_c"), slow("agent_d")], { maxConcurrency: 4 });
    expect(peak).toBe(4);
    expect(Date.now() - t0).toBeLessThan(400); // sequential would be ~480 ms
    running = 0; peak = 0;
    await run([slow("agent_a"), slow("agent_b"), slow("agent_c"), slow("agent_d")], { maxConcurrency: 2 });
    expect(peak).toBe(2);
  });
  it("respects the dependency order and hands dependants the COMPLETED results of their dependencies", async () => {
    const order: string[] = [];
    let seenDep: unknown;
    const step = (id: string, ms: number, extra: Partial<Parameters<typeof fakeAgent>[2]> = {}) => fakeAgent(id, async (ctx) => {
      order.push(`start:${id}`);
      await delay(ms);
      if (id === "agent_c") seenDep = ctx.dependencies["agent_a"];
      order.push(`end:${id}`);
      return { verdict: "SUPPORTIVE", confidence: 60, findings: [], evidence: [], output: {} };
    }, extra);
    await run([step("agent_c", 5, { dependsOn: ["agent_a", "agent_b"] }), step("agent_b", 60, { dependsOn: ["agent_a"] }), step("agent_a", 40)]);
    expect(order.indexOf("end:agent_a")).toBeLessThan(order.indexOf("start:agent_b"));
    expect(order.indexOf("end:agent_b")).toBeLessThan(order.indexOf("start:agent_c"));
    expect(seenDep).toMatchObject({ agentId: "agent_a", status: "COMPLETED", verdict: "SUPPORTIVE" });
  });
  it("results are deterministic and sorted by agent id whatever the finishing order", async () => {
    const o = await run([fakeAgent("agent_z", async () => { await delay(60); return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }), fakeAgent("agent_a", answer())]);
    expect(o.results.map((r) => r.agentId)).toEqual(["agent_a", "agent_z"]);
  });
});

describe("timeouts, retries and failure isolation", () => {
  it("a timed-out agent is TIMEOUT (after its attempts); its late result is ignored; others are unaffected", async () => {
    let finished = false;
    const slow = fakeAgent("agent_slow", async () => { await delay(300); finished = true; return { verdict: "SUPPORTIVE", confidence: 99, findings: [], evidence: [], output: {} }; }, { timeoutMs: 60 });
    const o = await run([slow, fakeAgent("agent_ok", answer("SUPPORTIVE", 70))]);
    expect(by(o, "agent_slow")).toMatchObject({ status: "TIMEOUT", verdict: "UNAVAILABLE", confidence: null, errorCode: "AGENT_TIMEOUT", attempts: 1 });
    expect(by(o, "agent_ok")).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE" });
    await delay(350);
    expect(finished).toBe(true); // it did finish late: the recorded result stays TIMEOUT
    expect(by(o, "agent_slow").status).toBe("TIMEOUT");
  });
  it("the abort signal is raised on timeout", async () => {
    let aborted = false;
    await run([fakeAgent("agent_a", (ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { aborted = true; }); }), { timeoutMs: 50 })]);
    expect(aborted).toBe(true);
  });
  it("retries a failing agent up to maxAttempts with the configured (linear) backoff, then succeeds", async () => {
    let calls = 0;
    const flaky = fakeAgent("agent_flaky", () => { calls += 1; if (calls < 3) throw Object.assign(new Error("boom"), { code: "UPSTREAM_DOWN" }); return { verdict: "NEUTRAL", confidence: 40, findings: [], evidence: [], output: {} }; }, { retry: { maxAttempts: 3, backoffMs: 25 } });
    const events: AgentEvent[] = [], sleeps: number[] = [];
    const o = await run([flaky], {}, INPUTS, events, sleeps);
    expect(by(o, "agent_flaky")).toMatchObject({ status: "COMPLETED", attempts: 3 });
    expect(sleeps).toEqual([25, 50]);
    expect(events.filter((e) => e.type === "agent.attempt_failed").map((e) => [e.attempt, e.errorCode])).toEqual([[1, "UPSTREAM_DOWN"], [2, "UPSTREAM_DOWN"]]);
  });
  it("gives up after maxAttempts: FAILED with a fixed error code and a sanitized message", async () => {
    let calls = 0;
    const o = await run([fakeAgent("agent_bad", () => { calls += 1; throw new Error(`failed with ${"123456789"}:${"B".repeat(35)} secret`); }, { retry: { maxAttempts: 2, backoffMs: 0 } })]);
    expect(calls).toBe(2);
    const r = by(o, "agent_bad");
    expect(r).toMatchObject({ status: "FAILED", verdict: "UNAVAILABLE", confidence: null, errorCode: "AGENT_ERROR", attempts: 2 });
    expect(r.errorMessage).not.toContain("123456789");
    expect(r.errorMessage).toContain("[redacted]");
  });
  it("retries timeouts too, ending in TIMEOUT only if every attempt timed out", async () => {
    let calls = 0;
    const o = await run([fakeAgent("agent_a", async () => { calls += 1; if (calls === 1) await delay(300); return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }, { timeoutMs: 50, retry: { maxAttempts: 2, backoffMs: 0 } })]);
    expect(by(o, "agent_a")).toMatchObject({ status: "COMPLETED", attempts: 2 });
    const o2 = await run([fakeAgent("agent_b", () => delay(300) as never, { timeoutMs: 50, retry: { maxAttempts: 2, backoffMs: 0 } })]);
    expect(by(o2, "agent_b")).toMatchObject({ status: "TIMEOUT", attempts: 2 });
  });
  it("does NOT retry a contract violation or an unavailable agent", async () => {
    let bad = 0, un = 0;
    const o = await run([
      fakeAgent("agent_bad", () => { bad += 1; return { verdict: "GREAT", confidence: 1, findings: [], evidence: [], output: {} } as never; }, { retry: { maxAttempts: 3, backoffMs: 0 } }),
      fakeAgent("agent_un", () => { un += 1; throw new AgentUnavailableError("NO_DATA_FEED", "no feed"); }, { retry: { maxAttempts: 3, backoffMs: 0 } }),
    ]);
    expect([bad, un]).toEqual([1, 1]);
    expect(by(o, "agent_bad")).toMatchObject({ status: "FAILED", errorCode: "OUTPUT_VERDICT_INVALID", attempts: 1 });
    expect(by(o, "agent_un")).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", errorCode: "NO_DATA_FEED", attempts: 1 });
  });
  it("an agent that RETURNS the UNAVAILABLE verdict is recorded UNAVAILABLE with its findings", async () => {
    const o = await run([fakeAgent("agent_a", answer("UNAVAILABLE", 0, { findings: [{ code: "NO_COVERAGE", severity: "INFO", summary: "nothing to evaluate" }] }))]);
    expect(by(o, "agent_a")).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "AGENT_REPORTED_UNAVAILABLE" });
    expect(by(o, "agent_a").findings).toHaveLength(1);
  });
  it("ISOLATES failures: a throwing agent, a mutating agent and a good agent never affect each other's results", async () => {
    const shared: { n: number } = { n: 1 };
    const o = await run([
      fakeAgent("agent_throw", () => { throw new Error("kaboom"); }),
      fakeAgent("agent_mutate", (ctx) => { (ctx.inputs["risk_decision"] as { entryPrice: number }).entryPrice = 1; shared.n = 2; return { verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], output: {} }; }),
      fakeAgent("agent_good", answer("SUPPORTIVE", 90)),
    ]);
    expect(by(o, "agent_throw").status).toBe("FAILED");
    expect(by(o, "agent_mutate").status).toBe("FAILED"); // the frozen input refused the write
    expect(by(o, "agent_good")).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90 });
    expect(INPUTS.risk_decision.entryPrice).toBe(100);
  });
  it("an agent that mutates its returned object afterwards cannot change the stored result", async () => {
    let held: { verdict: string; output: Record<string, unknown> } | undefined;
    const o = await run([fakeAgent("agent_a", () => { held = { verdict: "NEUTRAL", output: { note: "a" } }; return { ...held, confidence: 50, findings: [], evidence: [] } as never; })]);
    held!.output["note"] = "changed";
    expect(by(o, "agent_a").outputSnapshot).toEqual({ note: "a" });
  });
  it("a throwing event sink never breaks an orchestration", async () => {
    const r = new AgentRegistry();
    r.register(fakeAgent("agent_a", answer()));
    const cfg = config();
    const o = await orchestrate(r.resolve(cfg), cfg, INPUTS as never, REF, { emit: () => { throw new Error("sink down"); } });
    expect(by(o, "agent_a").status).toBe("COMPLETED");
  });
});

describe("missing inputs, dependencies and required agents fail CLOSED", () => {
  it("a missing required input SKIPS the agent (it is never run with a guessed input)", async () => {
    let ran = false;
    const o = await run([fakeAgent("agent_a", () => { ran = true; return { verdict: "SUPPORTIVE", confidence: 99, findings: [], evidence: [], output: {} }; }, { requiredInputs: ["source_intelligence"] })], {}, { ...INPUTS, source_intelligence: null });
    expect(ran).toBe(false);
    expect(by(o, "agent_a")).toMatchObject({ status: "SKIPPED", verdict: "UNAVAILABLE", errorCode: "MISSING_REQUIRED_INPUT", attempts: 0 });
  });
  it("a dependent of a failed / timed-out / skipped agent is SKIPPED", async () => {
    const o = await run([fakeAgent("agent_a", () => { throw new Error("x"); }), fakeAgent("agent_b", answer(), { dependsOn: ["agent_a"] }), fakeAgent("agent_c", answer(), { dependsOn: ["agent_b"] })]);
    expect(by(o, "agent_b")).toMatchObject({ status: "SKIPPED", errorCode: "DEPENDENCY_NOT_COMPLETED" });
    expect(by(o, "agent_c")).toMatchObject({ status: "SKIPPED", errorCode: "DEPENDENCY_NOT_COMPLETED" });
  });
  it("a required agent whose result is missing makes the run INCOMPLETE - also when it is unregistered or disabled", async () => {
    const failing = await run([fakeAgent("agent_a", () => { throw new Error("x"); }), fakeAgent("agent_b", answer("SUPPORTIVE", 90))], { requiredAgents: ["agent_a"] });
    expect(failing).toMatchObject({ status: "INCOMPLETE" });
    expect(failing.synthesis).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", missingRequired: [{ agentId: "agent_a", status: "FAILED" }] });
    const absent = await run([fakeAgent("agent_b", answer("SUPPORTIVE", 90))], { requiredAgents: ["agent_nope"] });
    expect(absent.synthesis.assessment).toBe("RESEARCH_INCOMPLETE");
    expect(by(absent, "agent_nope")).toMatchObject({ status: "SKIPPED", errorCode: "REQUIRED_AGENT_NOT_REGISTERED" });
    const off = await run([fakeAgent("agent_b", answer("SUPPORTIVE", 90))], { requiredAgents: ["agent_b"], disabledAgents: [] });
    expect(off.synthesis.assessment).not.toBe("RESEARCH_INCOMPLETE");
  });
  it("an engine with no agents at all is INCOMPLETE, never silently fine", async () => { expect((await run([])).synthesis).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", notes: expect.arrayContaining(["NO_SCORING_RESULTS"]) }); });
});

describe("events are allow-listed", () => {
  it("emit identifiers, codes and numbers only - no inputs, outputs or free text", async () => {
    const events: AgentEvent[] = [];
    await run([fakeAgent("agent_a", answer("NEUTRAL", 50, { output: { note: "SECRET-ish text" } })), fakeAgent("agent_b", () => { throw new Error("detail with text"); })], {}, INPUTS, events);
    expect(events[0]?.type).toBe("orchestrator.started");
    expect(events.at(-1)?.type).toBe("orchestrator.finished");
    const allowed = new Set(["type", "agentId", "agentVersion", "attempt", "status", "verdict", "durationMs", "errorCode", "agents", "assessment"]);
    for (const e of events) for (const k of Object.keys(e)) expect(allowed.has(k), k).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/SECRET|detail with text|ACME/);
  });
});

describe("synthesis (pure, deterministic, never an approval)", () => {
  const A = (id: string, over: Partial<SynthesisInput["agents"][number]> = {}): SynthesisInput["agents"][number] => ({
    agentId: id, agentVersion: "1.0.0", weight: 50, canBlock: false, advisoryOnly: false, required: false, status: "COMPLETED", verdict: "NEUTRAL", confidence: 100, findings: [], outputSha256: "0".repeat(64), errorCode: null, ...over,
  });
  const input = (agents: SynthesisInput["agents"], over: Partial<SynthesisInput> = {}): SynthesisInput => ({
    algorithmVersion: "research-synthesis-v1", riskDecisionId: REF.riskDecisionId, decisionVersion: 2, thresholds: { supportiveMin: 0.35, neutralMin: -0.15, cautionMin: -0.5, adverseVetoWeight: 50 }, requiredAgents: [], agents, ...over,
  });
  it.each<[string, SynthesisInput["agents"], string, number | null]>([
    ["all supportive", [A("agent_a", { verdict: "SUPPORTIVE" }), A("agent_b", { verdict: "SUPPORTIVE" })], "RESEARCH_SUPPORTIVE", 1],
    ["supportive and neutral (mean 0.5)", [A("agent_a", { verdict: "SUPPORTIVE" }), A("agent_b")], "RESEARCH_SUPPORTIVE", 0.5],
    ["neutral", [A("agent_a"), A("agent_b")], "RESEARCH_NEUTRAL", 0],
    ["mild caution (mean -0.1)", [A("agent_a", { verdict: "CAUTION", weight: 20 }), A("agent_b", { weight: 80 })], "RESEARCH_NEUTRAL", -0.1],
    ["caution (mean -0.25)", [A("agent_a", { verdict: "CAUTION" }), A("agent_b")], "RESEARCH_CAUTION", -0.25],
    ["caution (mean -0.5 at the boundary)", [A("agent_a", { verdict: "CAUTION" })], "RESEARCH_CAUTION", -0.5],
    ["adverse by mean, below the veto weight", [A("agent_a", { verdict: "ADVERSE", weight: 40 }), A("agent_b", { verdict: "CAUTION", weight: 40 })], "RESEARCH_ADVERSE", -0.75],
    ["low confidence pulls toward neutral", [A("agent_a", { verdict: "ADVERSE", weight: 40, confidence: 10 }), A("agent_b", { weight: 40 })], "RESEARCH_NEUTRAL", -0.05],
    ["weights matter", [A("agent_a", { verdict: "SUPPORTIVE", weight: 90 }), A("agent_b", { verdict: "CAUTION", weight: 10 })], "RESEARCH_SUPPORTIVE", 0.85],
  ])("%s -> %s", (_n, agents, expected, score) => {
    const s = synthesize(input(agents));
    expect(s.assessment).toBe(expected);
    expect(s.score).toBe(score);
    expect(s.grantsApproval).toBe(false);
  });
  it("an ADVERSE verdict from a heavy scoring agent vetoes a good mean", () => {
    const s = synthesize(input([A("agent_a", { verdict: "ADVERSE", weight: 50 }), A("agent_b", { verdict: "SUPPORTIVE", weight: 50 }), A("agent_c", { verdict: "SUPPORTIVE", weight: 50 })]));
    expect(s).toMatchObject({ assessment: "RESEARCH_ADVERSE", notes: expect.arrayContaining(["ADVERSE_VETO"]) });
    expect(synthesize(input([A("agent_a", { verdict: "ADVERSE", weight: 50 }), A("agent_b", { verdict: "SUPPORTIVE", weight: 50 }), A("agent_c", { verdict: "SUPPORTIVE", weight: 50 })], { thresholds: { supportiveMin: 0.35, neutralMin: -0.15, cautionMin: -0.5, adverseVetoWeight: 101 } })).assessment).toBe("RESEARCH_NEUTRAL"); // (mean 0.33: the veto, not the mean, made it ADVERSE)
  });
  it("a BLOCKING verdict from a blocking-capable agent is RESEARCH_BLOCKED, ahead of everything else - even a missing required agent", () => {
    const s = synthesize(input([A("agent_a", { verdict: "BLOCKING", canBlock: true, findings: [{ code: "HARD_STOP", severity: "CRITICAL" }] }), A("agent_b", { verdict: "SUPPORTIVE" }), A("agent_c", { required: true, status: "FAILED", verdict: "UNAVAILABLE", confidence: null })]));
    expect(s).toMatchObject({ assessment: "RESEARCH_BLOCKED", blockers: [{ agentId: "agent_a", findingCodes: ["HARD_STOP"] }] });
    expect(s.grantsApproval).toBe(false);
  });
  it("a BLOCKING verdict from an agent that cannot block, or from an advisory agent, never blocks", () => {
    expect(synthesize(input([A("agent_a", { verdict: "BLOCKING", canBlock: false }), A("agent_b", { verdict: "SUPPORTIVE" })])).assessment).toBe("RESEARCH_SUPPORTIVE");
    expect(synthesize(input([A("agent_a", { verdict: "BLOCKING", canBlock: true, advisoryOnly: true }), A("agent_b", { verdict: "SUPPORTIVE" })])).assessment).toBe("RESEARCH_SUPPORTIVE");
  });
  it("advisory-only agents are reported but never scored; zero-weight agents do not score", () => {
    const s = synthesize(input([A("agent_a", { verdict: "ADVERSE", advisoryOnly: true, weight: 100 }), A("agent_b", { verdict: "SUPPORTIVE" }), A("agent_z", { verdict: "ADVERSE", weight: 0 })]));
    expect(s.assessment).toBe("RESEARCH_SUPPORTIVE");
    expect(s.advisory).toEqual([{ agentId: "agent_a", verdict: "ADVERSE", confidence: 100 }]);
    expect(s.contributions.map((c) => c.agentId)).toEqual(["agent_b"]);
    expect(synthesize(input([A("agent_a", { advisoryOnly: true })])).assessment).toBe("RESEARCH_INCOMPLETE");
  });
  it.each<[string, SynthesisInput["agents"]]>([
    ["a required agent timed out", [A("agent_a", { required: true, status: "TIMEOUT", verdict: "UNAVAILABLE", confidence: null }), A("agent_b", { verdict: "SUPPORTIVE" })]],
    ["a required agent is unavailable", [A("agent_a", { required: true, status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null }), A("agent_b", { verdict: "SUPPORTIVE" })]],
    ["a required agent was skipped", [A("agent_a", { required: true, status: "SKIPPED", verdict: "UNAVAILABLE", confidence: null }), A("agent_b", { verdict: "SUPPORTIVE" })]],
    ["nothing completed", [A("agent_a", { status: "FAILED", verdict: "UNAVAILABLE", confidence: null })]],
    ["no agents", []],
  ])("%s -> RESEARCH_INCOMPLETE", (_n, agents) => { expect(synthesize(input(agents)).assessment).toBe("RESEARCH_INCOMPLETE"); });
  it("a failed OPTIONAL agent does not make the run incomplete (it is listed as unavailable)", () => {
    const s = synthesize(input([A("agent_a", { verdict: "SUPPORTIVE" }), A("agent_b", { status: "TIMEOUT", verdict: "UNAVAILABLE", confidence: null })]));
    expect(s).toMatchObject({ assessment: "RESEARCH_SUPPORTIVE", unavailableOptional: ["agent_b"], notes: ["OPTIONAL_AGENTS_UNAVAILABLE"] });
  });
  it("is deterministic: identical agent results synthesize identically, whatever the timings or the order", async () => {
    const mk = async () => run([fakeAgent("agent_b", async () => { await delay(Math.random() * 30); return { verdict: "CAUTION", confidence: 70, findings: [], evidence: [], output: { note: "x" } }; }), fakeAgent("agent_a", answer("SUPPORTIVE", 85, { output: { note: "y" } }))]);
    const [x, y] = [await mk(), await mk()];
    expect(JSON.stringify(x.synthesis)).toBe(JSON.stringify(y.synthesis));
    expect(x.synthesisInput).toEqual(y.synthesisInput);
    expect(x.synthesis.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    const rebuilt = buildSynthesisInput(REF, x.results, x.metas, config());
    expect(synthesize(rebuilt).assessment).toBe(x.synthesis.assessment);
  });
});

describe("architecture: the engine creates no executable state and calls nothing external", () => {
  const ROOT = join(__dirname, "../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));
  const files = walk("packages/agents/src");
  it("imports no broker / execution / Telegram / approval code and uses no network or LLM client", () => {
    for (const f of files) expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/@twins\/(execution|broker|adapter|alerting)|packages\/(execution|broker)|adapters\/|approval-bot|api\.telegram|sendMessage|\bfetch\(|node:https?|node:net\b|node:dgram|undici|axios|zerodha|kite|anthropic|openai|llm/i);
  });
  it("writes only the six agent tables; never updates or deletes; creates no order / fill / position / card / approval / risk decision", () => {
    for (const f of files) {
      const t = strip(readFileSync(join(ROOT, f), "utf8"));
      for (const m of t.matchAll(/\b(?:db|tx)\.(insert|update|delete)\(\s*(?:schema\.)?(\w+)/g)) expect(m[2], f).toMatch(/^(D|O|S|agentRuns|agentFindings|agentEvidenceReferences|agentDefinitions|agentOrchestrator\w+)$/);
      expect(t, f).not.toMatch(/\b(?:db|tx)\.(update|delete)\(/);
      expect(t, f).not.toMatch(/schema\.(orders|fills|positions|riskApprovals|riskApprovalCards|riskDecisions|decisions|signals)\b|createRiskDecision|supersedeRiskDecision|createApprovalCard|recordRiskApproval/);
    }
  });
  it("neither reads nor stores raw message text", () => { for (const f of files) expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/rawText|raw_text|rawPayload|telegramMessages/); });
  it("the synthesis can never grant approval: the result type is the literal false and nothing creates APPROVED_FOR_REVIEW", () => {
    const t = strip(readFileSync(join(ROOT, "packages/agents/src/synthesis.ts"), "utf8"));
    expect(t).toMatch(/grantsApproval: false/);
    for (const f of files) expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/APPROVED_FOR_REVIEW/);
  });
  it("the worker hook sits after source intelligence and before sizing, is a no-op when disabled, and halts only", () => {
    const w = strip(readFileSync(join(ROOT, "services/worker/src/index.ts"), "utf8"));
    const fn = w.slice(w.indexOf("async function recordPendingRiskDecision"));
    expect(fn.indexOf("await intel()")).toBeLessThan(fn.indexOf("await agents(latestId)"));
    expect(fn.indexOf("await agents(latestId)")).toBeLessThan(fn.indexOf("await size()"));
    expect(w).toMatch(/const agentEngineConfig = loadAgentEngineConfig\(\)/);
    expect(read("packages/agents/src/record.ts")).toMatch(/if \(!config\.enabled\) return \{ skipped: "ENGINE_DISABLED" \}/);
    expect(read("packages/agents/src/config.ts")).toMatch(/enabled: false/);
  });
  const read = (f: string): string => strip(readFileSync(join(ROOT, f), "utf8"));
});
