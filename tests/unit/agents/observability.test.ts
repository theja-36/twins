import { describe, expect, it } from "vitest";
import { createRunObserver, loadObservabilityConfig, logConfigInvalid, logProviderAvailability, observeConfigLoad, providerAvailability, type AgentEvent, type EngineResult, type ObservabilityLevel } from "../../../packages/agents/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const DEC = "11111111-1111-4111-8111-111111111111", RUN = "22222222-2222-4222-8222-222222222222";
/** The real structured logger (with its own masking) writing to memory. */
const capture = () => { const records: LogRecord[] = []; return { records, log: createStructuredLogger((r) => records.push(r), {}, () => new Date("2025-01-06T04:05:00Z")) }; };
const result = (o: Partial<Extract<EngineResult, { runId: string }>> = {}): EngineResult => ({ runId: RUN, created: true, riskDecisionId: DEC, status: "COMPLETED", assessment: "RESEARCH_SUPPORTIVE", halt: false, haltReasonCode: "NO_HALT", agents: 3, ...o });
const finished = (agentId: string, status: string, verdict: string, durationMs = 5, attempt = 1, errorCode?: string): AgentEvent => ({ type: status === "SKIPPED" ? "agent.skipped" : "agent.finished", agentId, agentVersion: "1.0.0", status, verdict, durationMs, attempt, ...(errorCode ? { errorCode } : {}) });
const feed = (o: ReturnType<typeof createRunObserver>, events: AgentEvent[]) => { for (const e of events) o.emit(e); };
const EVENTS: AgentEvent[] = [
  { type: "orchestrator.started", agents: 3 }, { type: "agent.started", agentId: "agent-a-v1", agentVersion: "1.0.0" }, { type: "agent.started", agentId: "agent-b-v1", agentVersion: "1.0.0" },
  { type: "agent.attempt_failed", agentId: "agent-b-v1", attempt: 1, errorCode: "AGENT_ERROR" },
  finished("agent-a-v1", "COMPLETED", "SUPPORTIVE", 12), finished("agent-b-v1", "COMPLETED", "CAUTION", 30, 2), finished("agent-c-v1", "TIMEOUT", "UNAVAILABLE", 5000, 1, "AGENT_TIMEOUT"),
  { type: "orchestrator.finished", assessment: "RESEARCH_INCOMPLETE", agents: 3, durationMs: 5100 },
];
const names = (r: LogRecord[]) => r.map((x) => x.event);

describe("observability configuration", () => {
  it("defaults to summary; accepts the four levels; a malformed level THROWS", () => {
    expect(loadObservabilityConfig({})).toEqual({ level: "summary" });
    for (const l of ["errors", "summary", "agents", "debug"] as const) expect(loadObservabilityConfig({ TWINS_AGENT_LOG_LEVEL: l })).toEqual({ level: l });
    expect(() => loadObservabilityConfig({ TWINS_AGENT_LOG_LEVEL: "verbose" })).toThrowError(expect.objectContaining({ code: "INVALID_ENGINE_CONFIG" }));
  });
});

describe("run records are bounded by the log level", () => {
  const run = (level: ObservabilityLevel) => { const c = capture(); const o = createRunObserver(c.log, { level }, { riskDecisionId: DEC }); feed(o, EVENTS); o.completed(result({ status: "INCOMPLETE", assessment: "RESEARCH_INCOMPLETE", halt: true, haltReasonCode: "HALT_REQUIRED_AGENT_MISSING" })); return c.records; };
  it("errors: nothing for a completed run", () => { expect(run("errors")).toEqual([]); });
  it("summary: exactly ONE record per run, whatever the number of agents", () => {
    const r = run("summary");
    expect(names(r)).toEqual(["agent_engine.run.completed"]);
    expect(r[0]).toMatchObject({ level: "warn", riskDecisionId: DEC, runId: RUN, created: true, status: "INCOMPLETE", assessment: "RESEARCH_INCOMPLETE", halt: true, haltReasonCode: "HALT_REQUIRED_AGENT_MISSING", agents: 3, durationMs: 5100, timedOut: 1, notCompleted: 1, failedAttempts: 1 });
    expect(r[0]!["statusCounts"]).toEqual({ COMPLETED: 2, TIMEOUT: 1 }); expect(r[0]!["verdictDistribution"]).toEqual({ SUPPORTIVE: 1, CAUTION: 1, UNAVAILABLE: 1 });
    expect(r[0]!["agentList"]).toEqual([
      { agentId: "agent-a-v1", status: "COMPLETED", verdict: "SUPPORTIVE", durationMs: 12, attempts: 1, errorCode: null }, { agentId: "agent-b-v1", status: "COMPLETED", verdict: "CAUTION", durationMs: 30, attempts: 2, errorCode: null },
      { agentId: "agent-c-v1", status: "TIMEOUT", verdict: "UNAVAILABLE", durationMs: 5000, attempts: 1, errorCode: "AGENT_TIMEOUT" },
    ]);
  });
  it("agents: + run started and one record per agent (a timeout is its own warning)", () => {
    const r = run("agents");
    expect(names(r)).toEqual(["agent_engine.run.started", "agent_engine.agent.finished", "agent_engine.agent.finished", "agent_engine.agent.timed_out", "agent_engine.run.completed"]);
    expect(r.find((x) => x.event === "agent_engine.agent.timed_out")).toMatchObject({ level: "warn", agentId: "agent-c-v1", status: "TIMEOUT", durationMs: 5000, errorCode: "AGENT_TIMEOUT" });
    expect(r.find((x) => x.event === "agent_engine.agent.finished")).toMatchObject({ level: "info", agentId: "agent-a-v1", verdict: "SUPPORTIVE", attempts: 1 });
  });
  it("debug: + agent started and failed attempts", () => {
    expect(names(run("debug"))).toEqual(["agent_engine.run.started", "agent_engine.agent.started", "agent_engine.agent.started", "agent_engine.agent.attempt_failed", "agent_engine.agent.finished", "agent_engine.agent.finished", "agent_engine.agent.timed_out", "agent_engine.run.completed"]);
  });
  it("a clean run is an info record; a halt or an agent that did not complete is a warning", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "summary" }, { riskDecisionId: DEC });
    feed(o, [{ type: "orchestrator.started", agents: 1 }, finished("agent-a-v1", "COMPLETED", "SUPPORTIVE"), { type: "orchestrator.finished", assessment: "RESEARCH_SUPPORTIVE", agents: 1, durationMs: 9 }]);
    o.completed(result({ agents: 1 }));
    expect(c.records[0]).toMatchObject({ level: "info", halt: false, haltReasonCode: "NO_HALT", timedOut: 0, notCompleted: 0 });
    const c2 = capture(); const o2 = createRunObserver(c2.log, { level: "summary" }, { riskDecisionId: DEC });
    feed(o2, [finished("agent-a-v1", "COMPLETED", "ADVERSE")]); o2.completed(result({ assessment: "RESEARCH_ADVERSE", halt: true, haltReasonCode: "HALT_ADVERSE_VETO" }));
    expect(c2.records[0]).toMatchObject({ level: "warn", assessment: "RESEARCH_ADVERSE", haltReasonCode: "HALT_ADVERSE_VETO" });
  });
  it("a stored result that is returned again is one info record (no agent events, no re-run)", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "summary" }, { riskDecisionId: DEC });
    o.completed(result({ created: false, halt: true, assessment: "RESEARCH_ADVERSE", haltReasonCode: "UNKNOWN" }));
    expect(c.records).toHaveLength(1); expect(c.records[0]).toMatchObject({ event: "agent_engine.run.reused", level: "info", runId: RUN, haltReasonCode: "UNKNOWN", halt: true });
    const c2 = capture(); createRunObserver(c2.log, { level: "errors" }, { riskDecisionId: DEC }).completed(result({ created: false })); expect(c2.records).toEqual([]);
  });
  it("a disabled engine ({ skipped }) logs nothing", () => {
    const c = capture(); createRunObserver(c.log, { level: "debug" }, { riskDecisionId: DEC }).completed({ skipped: "ENGINE_DISABLED" }); expect(c.records).toEqual([]);
  });
  it("a run of many agents stays bounded: the compact list is capped at 20", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "summary" }, { riskDecisionId: DEC });
    for (let i = 0; i < 40; i++) o.emit(finished(`agent-${String(i).padStart(2, "0")}-v1`, "COMPLETED", "NEUTRAL"));
    o.completed(result({ agents: 40 }));
    expect(c.records).toHaveLength(1); expect((c.records[0]!["agentList"] as unknown[]).length).toBeLessThanOrEqual(10); // the logger itself also bounds arrays
    expect(c.records[0]!["verdictDistribution"]).toEqual({ NEUTRAL: 40 });
  });
});

describe("failures", () => {
  it("a failed run is always an error record with a code (even at the lowest level)", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "errors" }, { riskDecisionId: DEC });
    o.failed(Object.assign(new Error("database exploded SECRET-DETAIL token=abc123"), { code: "safety_refused" }));
    expect(c.records).toHaveLength(1); expect(c.records[0]).toMatchObject({ level: "error", event: "agent_engine.run.failed", riskDecisionId: DEC, errorCode: "safety_refused", errorName: "Error" });
    expect(JSON.stringify(c.records)).not.toContain("SECRET-DETAIL"); expect(JSON.stringify(c.records)).not.toContain("abc123");
    const c2 = capture(); createRunObserver(c2.log, { level: "errors" }, { riskDecisionId: DEC }).failed("not an error");
    expect(c2.records[0]).toMatchObject({ errorCode: "ENGINE_ERROR", errorName: "Error" });
    const c3 = capture(); createRunObserver(c3.log, { level: "errors" }, { riskDecisionId: DEC }).failed({ cause: { code: "STORE_DOWN" } });
    expect(c3.records[0]).toMatchObject({ errorCode: "STORE_DOWN" });
  });
  it("a sink that throws never breaks the engine", () => {
    const bad = { info: () => { throw new Error("sink down"); }, warn: () => { throw new Error("sink down"); }, error: () => { throw new Error("sink down"); } };
    const o = createRunObserver(bad, { level: "debug" }, { riskDecisionId: DEC });
    expect(() => { feed(o, EVENTS); o.completed(result()); o.failed(new Error("x")); }).not.toThrow();
  });
  it("config validation failures are logged with the setting names (never values) and the error is rethrown", () => {
    const c = capture();
    const boom = Object.assign(new Error("invalid agent rules configuration: TWINS_AGENT_TECH_MIN_BARS token 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), { code: "INVALID_ENGINE_CONFIG" });
    expect(() => observeConfigLoad(c.log, "agent-rules", () => { throw boom; })).toThrow(boom);
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({ level: "error", event: "agent_engine.config.invalid", config: "agent-rules", errorCode: "INVALID_ENGINE_CONFIG", errorName: "Error" });
    expect(String(c.records[0]!["problem"])).toContain("TWINS_AGENT_TECH_MIN_BARS"); expect(JSON.stringify(c.records)).not.toContain("AAAAAAAAAAAA");
    expect(observeConfigLoad(c.log, "ok", () => 42)).toBe(42); expect(c.records).toHaveLength(1);
    logConfigInvalid({ info: () => undefined, warn: () => undefined, error: () => { throw new Error("sink"); } }, "x", new Error("y")); // never throws
  });
});

describe("redaction: nothing but codes, ids, counts and durations is logged", () => {
  it("hostile values in events and results are neutralised (no free text, no secrets, no raw message text reaches a record)", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "debug" }, { riskDecisionId: "not a uuid SECRET-MESSAGE-TEXT" });
    const evil = "BUY RELIANCE @ 100 SECRET-MESSAGE-TEXT api_key=hunter2 sk-abcdefghijklmnopqrstuvwxyz";
    feed(o, [
      { type: "orchestrator.started", agents: 1 }, { type: "agent.started", agentId: evil, agentVersion: evil }, { type: "agent.attempt_failed", agentId: evil, attempt: 1, errorCode: evil },
      { type: "agent.finished", agentId: evil, agentVersion: evil, status: evil, verdict: evil, durationMs: Number.NaN, attempt: 1, errorCode: evil },
    ]);
    o.completed(result({ runId: evil, assessment: evil as never, haltReasonCode: evil, status: evil as never }));
    o.failed(Object.assign(new Error(evil), { code: evil, name: evil }));
    const text = JSON.stringify(c.records);
    for (const secret of ["SECRET-MESSAGE", "hunter2", "sk-abcdef", "BUY RELIANCE"]) expect(text, secret).not.toContain(secret);
    expect(c.records.every((r) => r["riskDecisionId"] === null)).toBe(true);
    expect(c.records.find((r) => r.event === "agent_engine.run.completed")).toMatchObject({ runId: null, assessment: "UNKNOWN", haltReasonCode: "UNKNOWN", status: "UNKNOWN" });
    expect(text).not.toContain("[redacted]"); // no field name was masked by the logger: the records use only safe field names
  });
  it("only fixed field names are used and none looks sensitive to the logger's own filter", () => {
    const c = capture(); const o = createRunObserver(c.log, { level: "debug" }, { riskDecisionId: DEC }); feed(o, EVENTS); o.completed(result());
    o.failed(new Error("x")); logProviderAvailability(c.log, { level: "debug" }, { ohlcProvider: { name: "p" } }, true);
    const keys = new Set(c.records.flatMap((r) => Object.keys(r)));
    for (const k of keys) expect(k, k).not.toMatch(/(secret|token|authorization|password|passwd|api[_-]?key|cookie|credential|raw|text|payload|body|content)/i);
    expect(JSON.stringify(c.records)).not.toContain("[redacted]");
  });
});

describe("provider availability", () => {
  it("reports which providers the registry was given, by kind, with names (sanitised); engine enabled with a gap is a warning", () => {
    const a = providerAvailability({ ohlcProvider: { name: "file:ohlc-export" }, quoteProvider: { name: "x".repeat(200) }, newsProvider: null });
    expect(a.configured).toEqual(["quotes", "ohlc"]); expect(a.missing).toHaveLength(13); expect(a.missing).toContain("news"); expect(a.providers["ohlc"]).toBe("file:ohlc-export"); expect((a.providers["quotes"] as string).length).toBeLessThanOrEqual(60);
    const c = capture();
    logProviderAvailability(c.log, { level: "summary" }, { ohlcProvider: { name: "p" } }, true);
    expect(c.records[0]).toMatchObject({ event: "agent_engine.providers", level: "warn", engineEnabled: true, configuredCount: 1, missingCount: 14, providerNames: ["ohlc=p"] });
    const c2 = capture(); logProviderAvailability(c2.log, { level: "summary" }, {}, false); expect(c2.records[0]).toMatchObject({ level: "info", engineEnabled: false });
    const c3 = capture(); logProviderAvailability(c3.log, { level: "errors" }, {}, true); expect(c3.records).toEqual([]);
  });
});
