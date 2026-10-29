import { describe, expect, it, vi } from "vitest";
import {
  ControlChangeInvalidError,
  ControlChangeRefusedError,
  EmergencyActionRegistry,
  StaleControlVersionError,
  changeControl,
  type ClientLike,
  type PoolLike,
} from "../../../packages/runtime-state/src/index";
import { main } from "../../../scripts/ops/safety-control";
import { must } from "../../support/must";

/** A scripted client: records every statement; `controls` answers the locking select. */
function fakePool(controls: Array<{ n: string; v: boolean; version: number }>, opts: { failUpdate?: boolean } = {}) {
  const statements: Array<{ text: string; params?: unknown[] }> = [];
  let released = 0;
  const client: ClientLike = {
    async query(text, params) {
      statements.push({ text: text.replace(/\s+/g, " ").trim(), ...(params ? { params } : {}) });
      if (/^select control_name, value, version from system_controls order by control_name for update/.test(text)) return { rows: controls.map((c) => ({ control_name: c.n, value: c.v, version: String(c.version) })) };
      if (/^update system_controls/.test(text)) {
        if (opts.failUpdate) throw Object.assign(new Error("trigger refused"), { code: "23001" });
        return { rows: [{ version: String(Number(params?.[0] === undefined ? 0 : 0) + 99) }] };
      }
      return { rows: [] };
    },
    release() { released += 1; },
  };
  const pool: PoolLike = { async connect() { return client; } };
  return { pool, statements, released: () => released, verbs: () => statements.map((s) => s.text.split(" ")[0]) };
}
const ALL = (over: Partial<Record<string, boolean>> = {}) => [
  { n: "INTAKE_ENABLED", v: over["INTAKE_ENABLED"] ?? true, version: 1 },
  { n: "KILL_SWITCH_ACTIVE", v: over["KILL_SWITCH_ACTIVE"] ?? false, version: 4 },
  { n: "TRADING_ENABLED", v: over["TRADING_ENABLED"] ?? false, version: 2 },
];
const valid = { control: "KILL_SWITCH_ACTIVE" as const, value: true, reason: "drill: verify the halt path", changedBy: "operator:alice", mechanism: "cli" as const, sourceProcess: "safety-control", operatorContext: { os_user: "alice", host: "ops-1", pid: 1234 } };

describe("changeControl validation: nothing touches the database for an invalid request", () => {
  it.each([
    ["unknown control", { ...valid, control: "LIVE_TRADING" as never }],
    ["non-boolean target", { ...valid, value: "true" as never }],
    ["missing target", { ...valid, value: undefined as never }],
    ["empty reason", { ...valid, reason: "" }],
    ["whitespace reason", { ...valid, reason: "          " }],
    ["short reason", { ...valid, reason: "short" }],
    ["control characters in reason", { ...valid, reason: "line1\nline2 injected" }],
    ["overlong reason", { ...valid, reason: "x".repeat(501) }],
    ["missing changed_by", { ...valid, changedBy: "" }],
    ["cli change without the operator: prefix", { ...valid, changedBy: "alice" }],
    ["cli change declared as a service identity", { ...valid, changedBy: "service:alice" }],
    ["service change declared as an operator", { ...valid, mechanism: "service" as const, changedBy: "operator:alice" }],
    ["unknown mechanism", { ...valid, mechanism: "sql" as never }],
    ["bad source process", { ...valid, sourceProcess: "x" }],
    ["nested operator context", { ...valid, operatorContext: { a: { b: 1 } } as never }],
    ["oversized operator context", { ...valid, operatorContext: { big: "x".repeat(1600) } }],
    ["changed_by with spaces", { ...valid, changedBy: "operator:ops alice" }],
    ["changed_by too short", { ...valid, changedBy: "a" }],
    ["bad expected version", { ...valid, expectedVersion: 0 }],
  ])("%s", async (_n, input) => {
    const f = fakePool(ALL());
    await expect(changeControl(f.pool, input)).rejects.toBeInstanceOf(ControlChangeInvalidError);
    expect(f.statements).toHaveLength(0);
  });
});

describe("changeControl transaction", () => {
  it("locks all rows in a fixed order, updates once with the trimmed reason, commits, releases", async () => {
    const f = fakePool(ALL());
    const result = await changeControl(f.pool, { ...valid, reason: "  drill: verify the halt path  " });
    expect(result).toMatchObject({ changed: true, control: "KILL_SWITCH_ACTIVE", previousValue: false, newValue: true });
    expect(f.verbs()).toEqual(["begin", "select", "select", "update", "commit"]);
    expect(must(f.statements[2]).text).toContain("set_config('twins.change_mechanism'");
    expect(f.statements[2]).toMatchObject({ params: ["cli", "safety-control", JSON.stringify({ os_user: "alice", host: "ops-1", pid: 1234 })] });
    expect(f.statements[3]).toMatchObject({ params: ["KILL_SWITCH_ACTIVE", true, "drill: verify the halt path", "operator:alice"] });
    expect(must(f.statements[1]).text).toContain("order by control_name for update");
    expect(f.released()).toBe(1);
  });
  it("a no-op change records nothing: rollback, changed=false", async () => {
    const f = fakePool(ALL({ KILL_SWITCH_ACTIVE: true }));
    expect(await changeControl(f.pool, valid)).toMatchObject({ changed: false, version: 4 });
    expect(f.verbs()).toEqual(["begin", "select", "rollback"]);
  });
  it("refuses to enable trading while the kill switch is active (rolled back, nothing updated)", async () => {
    const f = fakePool(ALL({ KILL_SWITCH_ACTIVE: true }));
    await expect(changeControl(f.pool, { control: "TRADING_ENABLED", value: true, reason: "resume paper trading", changedBy: "operator:alice", mechanism: "cli" as const, sourceProcess: "safety-control" })).rejects.toMatchObject({ name: "ControlChangeRefusedError", code: "kill_switch_active" });
    expect(f.verbs()).toEqual(["begin", "select", "rollback"]);
    // disabling trading and deactivating the kill switch are always allowed
    const g = fakePool(ALL({ KILL_SWITCH_ACTIVE: true, TRADING_ENABLED: true }));
    expect((await changeControl(g.pool, { control: "TRADING_ENABLED", value: false, reason: "stay off after incident", changedBy: "operator:alice", mechanism: "cli" as const, sourceProcess: "safety-control" })).changed).toBe(true);
  });
  it("compare-and-set: a stale expectedVersion is refused", async () => {
    const f = fakePool(ALL());
    await expect(changeControl(f.pool, { ...valid, expectedVersion: 3 })).rejects.toBeInstanceOf(StaleControlVersionError);
    expect(f.verbs()).toEqual(["begin", "select", "rollback"]);
    await expect(changeControl(fakePool(ALL()).pool, { ...valid, expectedVersion: 4 })).resolves.toMatchObject({ changed: true });
  });
  it("a missing control row is refused (never silently created)", async () => {
    const f = fakePool(ALL().filter((c) => c.n !== "TRADING_ENABLED"));
    await expect(changeControl(f.pool, valid)).rejects.toBeInstanceOf(ControlChangeRefusedError);
    expect(f.verbs()).not.toContain("insert");
  });
  it("a database error rolls back and is rethrown (not swallowed); the connection is always released", async () => {
    const f = fakePool(ALL(), { failUpdate: true });
    await expect(changeControl(f.pool, valid)).rejects.toMatchObject({ code: "23001" });
    expect(f.verbs()).toEqual(["begin", "select", "select", "update", "rollback"]);
    expect(f.released()).toBe(1);
  });
  it("activating the kill switch emits the safety events and runs registered emergency actions in the admin process; deactivating does not", async () => {
    const emergency = new EmergencyActionRegistry();
    const run = vi.fn(async () => undefined);
    emergency.register({ name: "future-flatten", run });
    const logs: string[] = [];
    const logger = { info: () => undefined, warn: (e: string) => void logs.push(e), error: (e: string) => void logs.push(e), child() { return this; } };
    await changeControl(fakePool(ALL()).pool, valid, { emergency, logger: logger as never });
    await new Promise((r) => setTimeout(r, 5));
    expect(run).toHaveBeenCalledWith({ origin: "admin", version: 99 });
    expect(logs).toEqual(["safety.control.changed", "safety.kill_switch.activated"]);
    run.mockClear();
    await changeControl(fakePool(ALL({ KILL_SWITCH_ACTIVE: true })).pool, { ...valid, value: false, reason: "all clear after drill" }, { emergency, logger: logger as never });
    await new Promise((r) => setTimeout(r, 5));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("operations CLI (no HTTP surface; explicit control, target state, reason and changed-by are required)", () => {
  const run = async (argv: string[], env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://u:secret-pw@db.internal:5432/twins" }, pool = fakePool(ALL())) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l), openPool: () => ({ pool: pool.pool, close: async () => undefined }) });
    return { code, out, err, pool };
  };
  it("usage errors (exit 2) never reach the database", async () => {
    const cases: string[][] = [
      [], ["frobnicate"], ["set"],
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "true", "--changed-by", "operator:alice"], // no reason
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "true", "--reason", "drill: halt path"], // no changed-by
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--reason", "drill: halt path", "--changed-by", "operator:alice"], // no target state
      ["set", "--control", "NOPE", "--value", "true", "--reason", "drill: halt path", "--changed-by", "operator:alice"],
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "yes", "--reason", "drill: halt path", "--changed-by", "operator:alice"],
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "true", "--value", "false", "--reason", "drill: halt path", "--changed-by", "operator:alice"],
      ["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "true", "--reason", "drill: halt path", "--changed-by", "operator:alice", "--expected-version", "abc"],
      ["set", "--force", "x"], ["status", "--control", "KILL_SWITCH_ACTIVE"],
    ];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.pool.statements, argv.join(" ")).toHaveLength(0);
    }
    expect((await run(["status"], {})).code).toBe(2); // no DATABASE_URL
  });
  it("a valid set changes the control and prints a result without the connection string", async () => {
    const r = await run(["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "true", "--reason", "drill: halt path", "--changed-by", "operator:alice"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("changed KILL_SWITCH_ACTIVE: false -> true");
    expect(r.out.join("\n") + r.err.join("\n")).not.toContain("secret-pw");
  });
  it("a rule violation exits 3 with a message; an unchanged control exits 0 and says nothing was recorded", async () => {
    const refused = await run(["set", "--control", "TRADING_ENABLED", "--value", "true", "--reason", "resume paper trading", "--changed-by", "operator:alice"], undefined, fakePool(ALL({ KILL_SWITCH_ACTIVE: true })));
    expect(refused.code).toBe(3);
    expect(refused.err.join("\n")).toContain("kill switch");
    const same = await run(["set", "--control", "INTAKE_ENABLED", "--value", "true", "--reason", "confirm intake is on", "--changed-by", "operator:alice"]);
    expect(same.code).toBe(0);
    expect(same.out.join("\n")).toContain("nothing recorded");
  });
  it("a driver failure exits 1 and never prints the driver message (it can embed host or credentials)", async () => {
    const pool: PoolLike = { async connect() { throw Object.assign(new Error("connect ECONNREFUSED db.internal:5432 password=secret-pw"), { code: "ECONNREFUSED" }); } };
    const r = await run(["status"], undefined, { pool } as never);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toBe("failed: Error (ECONNREFUSED)");
  });
});
