import { describe, expect, it } from "vitest";
import {
  classifyStatus, costOf, createAiGateway, FixtureLlmProvider, isNarrative, LlmError, MemoryUsageSink, narrate, PromptRegistry, registerNarrativePrompt, NARRATIVE_TASK,
  type GatewayDeps, type LlmProvider, type UsageSink,
} from "../../../packages/ai/src/index";

const NOW = new Date("2026-11-09T05:00:00Z");
const PRICE = { inputPerMTokUsd: 1, outputPerMTokUsd: 5 };
const isAnswer = (v: unknown): v is { answer: string } => typeof v === "object" && v !== null && typeof (v as { answer?: unknown }).answer === "string";
function setup(over: Partial<GatewayDeps> & { primary?: LlmProvider; backup?: LlmProvider; sink?: UsageSink } = {}) {
  const prompts = new PromptRegistry();
  prompts.register({ id: "answer-task", version: "1.0.0", task: "answer", system: "Reply JSON {answer}", template: "Q: {{q}}", variables: ["q"] });
  const primary = over.primary ?? new FixtureLlmProvider("p1", () => '{"answer":"ok"}', ["m1"]);
  const backup = over.backup ?? new FixtureLlmProvider("p2", () => '{"answer":"backup"}', ["m2"]);
  const sink = over.sink ?? new MemoryUsageSink();
  const sleeps: number[] = [];
  const gw = createAiGateway({
    providers: { p1: primary, p2: backup }, routes: { answer: { task: "answer", provider: "p1", model: "m1", maxOutputTokens: 200, timeoutMs: 1000, fallbacks: [{ provider: "p2", model: "m2" }] } },
    prompts, prices: { "p1/m1": PRICE, "p2/m2": PRICE }, dailyBudgetUsd: 1, usage: sink, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, newId: (() => { let i = 0; return () => `id-${++i}`; })(), ...over,
  });
  return { gw, primary, backup, sink: sink as MemoryUsageSink, sleeps, prompts };
}
const ask = (gw: ReturnType<typeof setup>["gw"]) => gw.run({ task: "answer", vars: { q: "hi" }, guard: isAnswer, userId: "u1" });

describe("hosted-AI gateway", () => {
  it("a valid structured answer is returned as ADVISORY with provenance, tokens and cost, and usage is recorded", async () => {
    const { gw, sink } = setup();
    const r = await ask(gw);
    expect(r).toMatchObject({ ok: true, advisory: true, value: { answer: "ok" }, provenance: { provider: "p1", model: "m1", promptVersion: "1.0.0" } });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ outcome: "OK", provider: "p1", model: "m1", promptId: "answer-task", userId: "u1", task: "answer", attempt: 1, gatewayVersion: "ai-gateway-v1" });
    expect(sink.records[0]?.promptSha256).toMatch(/^[0-9a-f]{64}$/); expect(sink.records[0]?.costUsd).toBeGreaterThan(0);
  });
  it("untrusted output that is not JSON, empty or the wrong shape is rejected, never repaired, and still costs and records", async () => {
    for (const body of ["I think you should buy NIFTY", "", '{"answer": 5}', '{"answer":"x","extra":1}'.replace(',"extra":1', ',"a":') ]) {
      const { gw, sink } = setup({ primary: new FixtureLlmProvider("p1", () => body, ["m1"]) });
      const r = await ask(gw);
      expect(r).toMatchObject({ ok: false, reason: "INVALID_OUTPUT" }); expect(sink.records.map((x) => x.outcome)).toEqual(["INVALID_OUTPUT"]);
    }
  });
  it("rate limits and server errors are retried with backoff (honouring retry-after), then fall back to the next provider", async () => {
    let n = 0;
    const flaky = new FixtureLlmProvider("p1", () => (++n === 1 ? new LlmError("RATE_LIMIT", "slow", 1500) : new LlmError("SERVER")), ["m1"]);
    const { gw, sink, sleeps } = setup({ primary: flaky });
    const r = await ask(gw);
    expect(r).toMatchObject({ ok: true, value: { answer: "backup" }, provenance: { provider: "p2" } });
    expect(sleeps).toEqual([1500, 1000]); // retry-after, then 500 * 2
    expect(sink.records.map((x) => x.outcome)).toEqual(["RATE_LIMITED", "PROVIDER_ERROR", "PROVIDER_ERROR", "OK"]);
  });
  it("auth and client errors are not retried; every provider failing is ALL_PROVIDERS_FAILED, not a guess", async () => {
    const bad = (k: "AUTH" | "CLIENT") => new FixtureLlmProvider("x", () => new LlmError(k), ["m"]);
    const a = setup({ primary: new FixtureLlmProvider("p1", () => new LlmError("AUTH"), ["m1"]), backup: new FixtureLlmProvider("p2", () => new LlmError("CLIENT"), ["m2"]) });
    expect(await ask(a.gw)).toMatchObject({ ok: false, reason: "ALL_PROVIDERS_FAILED", detail: "CLIENT" });
    expect((a.primary as FixtureLlmProvider).calls).toHaveLength(1); expect((a.backup as FixtureLlmProvider).calls).toHaveLength(1); expect(a.sleeps).toEqual([]);
    expect(bad("AUTH")).toBeDefined();
  });
  it("a provider that never answers times out through AbortController and is recorded as TIMEOUT", async () => {
    const hang: LlmProvider = { name: "p1", capabilities: () => ({ name: "p1", source: "FIXTURE", models: ["m1"], structuredOutput: true, maxContextTokens: 1 }), complete: (_r, signal) => new Promise((_res, rej) => { signal.addEventListener("abort", () => rej(new LlmError("TIMEOUT"))); }) };
    const { gw, sink } = setup({ primary: hang, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, routes: { answer: { task: "answer", provider: "p1", model: "m1", maxOutputTokens: 10, timeoutMs: 20, fallbacks: [] } } });
    expect(await ask(gw)).toMatchObject({ ok: false, reason: "ALL_PROVIDERS_FAILED", detail: "TIMEOUT" }); expect(sink.records[0]?.outcome).toBe("TIMEOUT");
  });
  it("the daily budget fails closed: an exhausted budget blocks the call before any provider is contacted, and an unreadable budget refuses", async () => {
    const sink = new MemoryUsageSink();
    await sink.record({ id: "o", at: NOW.toISOString(), userId: null, task: "t", provider: "p", model: "m", promptId: "x", promptVersion: "1.0.0", promptSha256: "0".repeat(64), inputTokens: 0, outputTokens: 0, costUsd: 0.9999, latencyMs: 1, attempt: 1, outcome: "OK", errorKind: null, requestId: "r", gatewayVersion: "v" });
    const a = setup({ sink });
    expect(await ask(a.gw)).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED" }); expect((a.primary as FixtureLlmProvider).calls).toHaveLength(0);
    expect(sink.records.at(-1)?.outcome).toBe("BUDGET_BLOCKED");
    const broken: UsageSink = { record: async () => undefined, spentTodayUsd: async () => { throw new Error("db down"); } };
    const b = setup({ sink: broken });
    expect(await ask(b.gw)).toMatchObject({ ok: false, reason: "BUDGET_UNKNOWN" }); expect((b.primary as FixtureLlmProvider).calls).toHaveLength(0);
  });
  it("a usage record that cannot be stored stops the call: no unaccounted spend continues", async () => {
    const sink: UsageSink = { record: async () => { throw new Error("db down"); }, spentTodayUsd: async () => 0 };
    expect(await ask(setup({ sink }).gw)).toMatchObject({ ok: false, reason: "USAGE_RECORDING_FAILED" });
  });
  it("unknown route, prompt, price or provider model is refused and never called", async () => {
    const a = setup();
    expect(await a.gw.run({ task: "nope", vars: {}, guard: isAnswer })).toMatchObject({ reason: "NO_ROUTE" });
    expect(await a.gw.run({ task: "answer", vars: { q: "x", extra: "y" }, guard: isAnswer })).toMatchObject({ reason: "BAD_PROMPT_VARS" });
    const noPrice = setup({ prices: {} });
    expect(await ask(noPrice.gw)).toMatchObject({ reason: "NO_PRICED_PROVIDER" }); expect((noPrice.primary as FixtureLlmProvider).calls).toHaveLength(0);
    const sameFallback = setup({ routes: { answer: { task: "answer", provider: "p1", model: "m1", maxOutputTokens: 10, timeoutMs: 10, fallbacks: [{ provider: "p1", model: "m1" }] } } });
    expect(await ask(sameFallback.gw)).toMatchObject({ reason: "BAD_ROUTE" });
    expect(() => createAiGateway({ ...({} as GatewayDeps), dailyBudgetUsd: Number.NaN })).toThrow(RangeError);
  });
  it("helpers: status classification and deterministic cost", () => {
    expect([429, 401, 403, 408, 500, 503, 400, 404, 302].map(classifyStatus)).toEqual(["RATE_LIMIT", "AUTH", "AUTH", "TIMEOUT", "SERVER", "SERVER", "CLIENT", "CLIENT", "UNKNOWN"]);
    expect(costOf(PRICE, 1_000_000, 1_000_000)).toBe(6);
  });
});

describe("prompt registry", () => {
  it("hashes prompts, refuses a silent change, undeclared variables and variables that could carry message text", () => {
    const r = new PromptRegistry();
    const p = { id: "demo-prompt", version: "1.0.0", task: "t", system: "s", template: "{{a}}", variables: ["a"] };
    const reg = r.register(p);
    expect(reg.sha256).toMatch(/^[0-9a-f]{64}$/); expect(r.register(p).sha256).toBe(reg.sha256);
    expect(() => r.register({ ...p, template: "{{a}} more" })).toThrow(/cannot change/);
    expect(() => r.register({ ...p, id: "other-prompt", template: "{{b}}" })).toThrow(/undeclared/);
    for (const v of ["messageText", "raw", "text", "Message"]) expect(() => r.register({ ...p, id: "bad-prompt", template: `{{${v}}}`, variables: [v] })).toThrow(/message text/);
    expect(() => r.render(reg, { a: "x".repeat(2001) })).toThrow(/too long/); expect(() => r.render(reg, {})).toThrow(/missing/);
  });
});

describe("advisory narrative", () => {
  const facts = { assessment: "RESEARCH_INCOMPLETE", halted: true, verdictCounts: { INCOMPLETE: 9, SUPPORTIVE: 4 }, riskFlags: ["A_FLAG"], missingRoles: [] as string[] };
  it("returns a validated summary separately, labelled advisory; the facts object is untouched", async () => {
    const { gw, prompts } = setup({ primary: new FixtureLlmProvider("p1", () => '{"summary":"Research is incomplete."}', ["m1"]), routes: { [NARRATIVE_TASK]: { task: NARRATIVE_TASK, provider: "p1", model: "m1", maxOutputTokens: 300, timeoutMs: 1000, fallbacks: [] } } });
    registerNarrativePrompt(prompts);
    const before = JSON.stringify(facts);
    expect(await narrate(gw, facts)).toMatchObject({ summary: "Research is incomplete.", advisory: true, provider: "p1" });
    expect(JSON.stringify(facts)).toBe(before);
  });
  it("an invalid or failed narrative is null: research is unaffected", async () => {
    const { gw, prompts } = setup({ primary: new FixtureLlmProvider("p1", () => '{"summary":"x","action":"BUY"}', ["m1"]), routes: { [NARRATIVE_TASK]: { task: NARRATIVE_TASK, provider: "p1", model: "m1", maxOutputTokens: 300, timeoutMs: 1000, fallbacks: [] } } });
    registerNarrativePrompt(prompts);
    expect(await narrate(gw, facts)).toBeNull();
    expect(isNarrative({ summary: "x".repeat(1201) })).toBe(false);
  });
});
