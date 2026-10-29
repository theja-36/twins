import { describe, expect, it } from "vitest";
import {
  CONTROL_DEFAULTS,
  EmergencyActionRegistry,
  RuntimeState,
  RuntimeStateUnavailableError,
  SafetyRefusalError,
  assertIntakeEnabled,
  assertKillSwitchInactive,
  assertTradingEnabled,
  configureRuntimeState,
  inMemoryStateSource,
  isIntakeEnabled,
  isKillSwitchActive,
  isTradingEnabled,
  resetRuntimeState,
  type ControlName,
} from "../../../packages/runtime-state/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

function make(initial: Partial<Record<ControlName, boolean>> = {}, opts: { ttlMs?: number; failureTtlMs?: number; timeoutMs?: number; emergency?: EmergencyActionRegistry } = {}) {
  const source = inMemoryStateSource(initial);
  const logs: LogRecord[] = [];
  let now = 1000;
  const state = new RuntimeState({
    source,
    ttlMs: opts.ttlMs ?? 3000,
    failureTtlMs: opts.failureTtlMs ?? 1000,
    timeoutMs: opts.timeoutMs ?? 50,
    clock: () => now,
    logger: createStructuredLogger((r) => logs.push(r)),
    ...(opts.emergency ? { emergency: opts.emergency } : {}),
  });
  return { source, state, logs, advance: (ms: number) => (now += ms), setNow: (v: number) => (now = v) };
}
const refusal = async (p: Promise<unknown>): Promise<SafetyRefusalError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SafetyRefusalError);
    return e as SafetyRefusalError;
  }
  throw new Error("expected a SafetyRefusalError");
};

describe("defaults", () => {
  it("the documented defaults are trading off, intake on, kill switch off", () => {
    expect(CONTROL_DEFAULTS).toEqual({ TRADING_ENABLED: false, INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false });
  });
  it("with the default state: intake and decisions are allowed, trading is refused", async () => {
    const { state } = make();
    expect(await state.isIntakeEnabled()).toBe(true);
    expect(await state.isTradingEnabled()).toBe(false);
    expect(await state.isKillSwitchActive()).toBe(false);
    await expect(state.assertIntakeEnabled("t")).resolves.toBeUndefined();
    await expect(state.assertKillSwitchInactive("t")).resolves.toBeUndefined();
    expect((await refusal(state.assertTradingEnabled("t"))).reason).toBe("trading_disabled");
  });
});

describe("each control", () => {
  it("trading enabled: trading assertion passes", async () => {
    const { state } = make({ TRADING_ENABLED: true });
    await expect(state.assertTradingEnabled("t")).resolves.toBeUndefined();
    expect(await state.isTradingEnabled()).toBe(true);
  });
  it("intake disabled: intake refused with intake_disabled, kill-switch assertion still passes", async () => {
    const { state } = make({ INTAKE_ENABLED: false });
    const r = await refusal(state.assertIntakeEnabled("worker.job"));
    expect(r).toMatchObject({ reason: "intake_disabled", operation: "worker.job" });
    expect(await state.isIntakeEnabled()).toBe(false);
    await expect(state.assertKillSwitchInactive("t")).resolves.toBeUndefined();
  });
  it("kill switch active: refuses everything, even with trading and intake enabled, and dominates the other reasons", async () => {
    const { state } = make({ TRADING_ENABLED: true, INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: true });
    for (const fn of [() => state.assertIntakeEnabled("a"), () => state.assertTradingEnabled("b"), () => state.assertKillSwitchInactive("c")]) {
      expect((await refusal(fn())).reason).toBe("kill_switch_active");
    }
    expect(await state.isKillSwitchActive()).toBe(true);
    expect(await state.isIntakeEnabled()).toBe(false);
    expect(await state.isTradingEnabled()).toBe(false);
    const both = make({ INTAKE_ENABLED: false, KILL_SWITCH_ACTIVE: true });
    expect((await refusal(both.state.assertIntakeEnabled("x"))).reason).toBe("kill_switch_active");
  });
});

describe("fail closed", () => {
  const expectAllClosed = async (state: RuntimeState, reasonCause?: string) => {
    for (const fn of [() => state.assertIntakeEnabled("o"), () => state.assertTradingEnabled("o"), () => state.assertKillSwitchInactive("o")]) {
      const r = await refusal(fn());
      expect(r.reason).toBe("state_unavailable");
      if (reasonCause) expect((r.cause as RuntimeStateUnavailableError).reason).toBe(reasonCause);
    }
    expect(await state.isIntakeEnabled()).toBe(false);
    expect(await state.isTradingEnabled()).toBe(false);
    expect(await state.isKillSwitchActive()).toBe(true); // unknown = treated as active
  };

  it("database unavailable (the read rejects): every assertion refuses; the error is surfaced as a cause and logged, not swallowed", async () => {
    const { state, source, logs } = make({ TRADING_ENABLED: true });
    source.failWith(Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432 password=hunter2"), { code: "ECONNREFUSED" }));
    await expectAllClosed(state, "query_failed");
    const event = logs.find((l) => l.event === "safety.state_unavailable");
    expect(event).toMatchObject({ cause: "query_failed", detail: "ECONNREFUSED" });
    expect(JSON.stringify(logs)).not.toContain("hunter2"); // never a driver message
  });
  it("query timeout: a read that never finishes refuses (and does not hang the caller)", async () => {
    const { state, source } = make({}, { timeoutMs: 20 });
    source.hang(true);
    const started = Date.now();
    await expectAllClosed(state, "timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("missing state row: each of the three rows missing refuses", async () => {
    for (const name of ["TRADING_ENABLED", "INTAKE_ENABLED", "KILL_SWITCH_ACTIVE"] as const) {
      const { state, source } = make();
      source.remove(name);
      await expectAllClosed(state, "missing_row");
      expect(((await state.snapshot().catch((e: unknown) => e)) as RuntimeStateUnavailableError).detail).toBe(name);
    }
  });
  it("no rows at all, a non-array result and malformed rows refuse", async () => {
    for (const raw of [[], [null], [{ control_name: "KILL_SWITCH_ACTIVE", value: "false", version: 1 }], [{ control_name: "KILL_SWITCH_ACTIVE", value: false, version: 0 }]]) {
      const { state, source } = make();
      source.setRaw(raw as never);
      await expectAllClosed(state);
    }
    const s = make();
    s.source.read = async () => "not rows" as never;
    await expectAllClosed(s.state, "invalid_row");
  });
  it("duplicate rows and non-boolean values are invalid, unknown extra rows are ignored", async () => {
    const good = [
      { control_name: "TRADING_ENABLED", value: true, version: 2 },
      { control_name: "INTAKE_ENABLED", value: true, version: "7" },
      { control_name: "KILL_SWITCH_ACTIVE", value: false, version: 1 },
    ];
    const a = make();
    a.source.setRaw([...good, { control_name: "SOMETHING_ELSE", value: "x", version: "y" }]);
    expect(await a.state.isTradingEnabled()).toBe(true);
    expect((await a.state.snapshot()).versions.INTAKE_ENABLED).toBe(7);
    const b = make();
    b.source.setRaw([...good, { control_name: "TRADING_ENABLED", value: false, version: 3 }]);
    await expectAllClosed(b.state, "invalid_row");
    const c = make();
    c.source.setRaw(good.map((r) => (r.control_name === "TRADING_ENABLED" ? { ...r, value: 1 } : r)));
    await expectAllClosed(c.state, "invalid_row");
  });
  it("an unconfigured process refuses everything (module-level functions)", async () => {
    resetRuntimeState();
    try {
      for (const fn of [() => assertIntakeEnabled("o"), () => assertTradingEnabled("o"), () => assertKillSwitchInactive("o")]) {
        const r = await refusal(fn());
        expect(r.reason).toBe("state_unavailable");
        expect((r.cause as RuntimeStateUnavailableError).reason).toBe("not_configured");
      }
      expect(await isIntakeEnabled()).toBe(false);
      expect(await isTradingEnabled()).toBe(false);
      expect(await isKillSwitchActive()).toBe(true);
    } finally {
      configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }); // back to the test default
    }
  });
});

describe("cache", () => {
  it("serves a successful read for the TTL, then reads again; a change elsewhere is seen within one TTL", async () => {
    const { state, source, advance } = make({ INTAKE_ENABLED: true });
    expect(await state.isIntakeEnabled()).toBe(true);
    source.set({ INTAKE_ENABLED: false });
    advance(2999);
    expect(await state.isIntakeEnabled()).toBe(true); // still cached
    expect(source.reads).toBe(1);
    advance(2);
    expect(await state.isIntakeEnabled()).toBe(false);
    expect(source.reads).toBe(2);
  });
  it("concurrent callers share one in-flight read", async () => {
    const { state, source } = make();
    await Promise.all(Array.from({ length: 25 }, () => state.assertKillSwitchInactive("c")));
    expect(source.reads).toBe(1);
  });
  it("forceRefresh bypasses the cache; invalidate drops it", async () => {
    const { state, source } = make({ KILL_SWITCH_ACTIVE: false });
    await state.snapshot();
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect(await state.isKillSwitchActive()).toBe(false);
    expect((await state.forceRefresh()).killSwitchActive).toBe(true);
    expect(await state.isKillSwitchActive()).toBe(true);
    source.set({ KILL_SWITCH_ACTIVE: false });
    state.invalidate();
    expect(await state.isKillSwitchActive()).toBe(false);
  });
  it("a failed refresh drops the previous snapshot: a stale 'enabled' is never served", async () => {
    const { state, source, advance } = make({ TRADING_ENABLED: true });
    expect(await state.isTradingEnabled()).toBe(true);
    advance(5000);
    source.failWith(new Error("down"));
    expect(await state.isTradingEnabled()).toBe(false);
    source.failWith(null);
    advance(500); // inside the failure TTL: still failing closed without a new read
    const reads = source.reads;
    expect(await state.isTradingEnabled()).toBe(false);
    expect(source.reads).toBe(reads);
    advance(600); // failure TTL over: recovers
    expect(await state.isTradingEnabled()).toBe(true);
  });
  it("a clock that goes backwards is not trusted (the cache expires instead of living forever)", async () => {
    const { state, source, setNow } = make();
    await state.snapshot();
    setNow(0); // earlier than the cached read
    await state.snapshot();
    expect(source.reads).toBe(2);
  });
  it("an old in-flight read cannot overwrite the result of a forced refresh", async () => {
    const { state, source } = make({ KILL_SWITCH_ACTIVE: false });
    const originalRead = source.read.bind(source);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    source.read = async () => {
      const rows = await originalRead();
      if (first) {
        first = false;
        await gate; // the first read returns the OLD state late
      }
      return rows;
    };
    const slow = state.snapshot();
    source.set({ KILL_SWITCH_ACTIVE: true });
    const forced = await state.forceRefresh();
    expect(forced.killSwitchActive).toBe(true);
    release();
    await slow;
    expect(await state.isKillSwitchActive()).toBe(true); // the late old result did not replace the newer state
  });
  it("TTL bounds are enforced (0-5000 ms)", () => {
    for (const ttlMs of [-1, 5001, Number.NaN]) expect(() => new RuntimeState({ source: inMemoryStateSource(), ttlMs })).toThrow();
    expect(() => new RuntimeState({ source: inMemoryStateSource(), ttlMs: 0 })).not.toThrow();
    expect(() => new RuntimeState({ source: inMemoryStateSource(), ttlMs: 5000 })).not.toThrow();
  });
});

describe("kill-switch events and the emergency extension point", () => {
  it("emits a structured safety event once per transition and runs registered emergency actions (fire-and-forget)", async () => {
    const emergency = new EmergencyActionRegistry();
    const calls: Array<{ origin: string; version?: number }> = [];
    emergency.register({ name: "future-flatten", run: async (e) => void calls.push(e) });
    emergency.register({ name: "broken", run: async () => { throw new Error("boom"); } });
    const { state, source, logs, advance } = make({}, { emergency });
    await state.snapshot();
    expect(calls).toHaveLength(0);
    source.set({ KILL_SWITCH_ACTIVE: true });
    advance(3001);
    await state.snapshot();
    advance(3001);
    await state.snapshot(); // still active: no second transition
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ origin: "observed", version: 2 }]);
    expect(logs.filter((l) => l.event === "safety.kill_switch.observed")).toHaveLength(1);
    expect(logs.some((l) => l.event === "safety.emergency_action.failed" && l.action === "broken")).toBe(true);
    source.set({ KILL_SWITCH_ACTIVE: false });
    advance(3001);
    await state.snapshot();
    expect(logs.some((l) => l.event === "safety.kill_switch.cleared_observed")).toBe(true);
    source.set({ KILL_SWITCH_ACTIVE: true });
    advance(3001);
    await state.snapshot();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2); // a new transition runs the actions again
  });
  it("a process that starts while the kill switch is already active observes it (first observation)", async () => {
    const { state, logs } = make({ KILL_SWITCH_ACTIVE: true });
    await state.snapshot();
    expect(logs.find((l) => l.event === "safety.kill_switch.observed")).toMatchObject({ firstObservation: true });
  });
  it("a slow emergency action never delays an assertion", async () => {
    const emergency = new EmergencyActionRegistry();
    emergency.register({ name: "slow", run: () => new Promise<void>(() => undefined) });
    const { state } = make({ KILL_SWITCH_ACTIVE: true }, { emergency });
    await expect(refusal(state.assertKillSwitchInactive("x"))).resolves.toMatchObject({ reason: "kill_switch_active" });
  });
  it("refusals emit safety.refused with operation and reason, rate-limited per operation/reason", async () => {
    const { state, logs, advance } = make({ KILL_SWITCH_ACTIVE: true });
    for (let i = 0; i < 5; i++) await state.evaluate("intake", "worker.job");
    expect(logs.filter((l) => l.event === "safety.refused")).toHaveLength(1);
    expect(logs.find((l) => l.event === "safety.refused")).toMatchObject({ operation: "worker.job", reason: "kill_switch_active" });
    advance(10_001);
    await state.evaluate("intake", "worker.job");
    const refused = logs.filter((l) => l.event === "safety.refused");
    expect(refused).toHaveLength(2);
    expect(refused[1]).toMatchObject({ suppressedSinceLast: 4 });
  });
});
