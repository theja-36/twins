/**
 * The owner CLI for risk controls (scripts/ops/risk-control.ts `controls list|set|clear`) against REAL PostgreSQL: dry run by default, explicit --apply, optimistic concurrency (--expected-event),
 * strict confirmation for dangerous clears, authorisation by the owner allowlist (the runtime role is refused), validation, all-or-nothing writes, and the audit-chain row written with every change.
 * The declared operator identity (`operator:<name>`) is self-declared, not authenticated.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { createDb, ownerChangeControl, OwnerControlError, recordUserHalt, type Db } from "../../../packages/database/src/index";
import { runCli } from "../../../scripts/ops/risk-control";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl(), APP = "twins_app_cli";
const roleSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${APP}"`).replaceAll(":'app_role'", `'${APP}'`);
const pool = new pg.Pool({ connectionString: URL_, max: 4 }), owner = createDb(pool);
let user: string;
const uniq = (): string => `CLI-${randomUUID().slice(0, 8)}`;
const OP = "operator:tester";
async function cli(args: string[], db: Db = owner): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await runCli(["controls", ...args], { env: { DATABASE_URL: URL_ }, out: (l) => { out += l; }, err: (l) => { err += l; }, openDb: () => ({ db, close: async () => undefined }) });
  return { code, out, err };
}
const j = (s: string): Record<string, any> => JSON.parse(s) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rows = async (sql: string, p: unknown[] = []): Promise<Array<Record<string, any>>> => (await pool.query(sql, p)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
const nEvents = async (key: string): Promise<number> => Number((await rows("select count(*) as n from risk_control_events where scope_key = $1", [key]))[0]!["n"]);
const base = (key: string, extra: string[] = []): string[] => ["--scope", "MARKET", "--scope-key", key, "--kind", "KILL_SWITCH", "--reason", "owner CLI integration test", "--changed-by", OP, ...extra];

beforeAll(async () => {
  user = randomUUID(); await pool.query("begin"); await pool.query("select set_config('twins.privilege_door', 'open', true)");
  await pool.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'TRADER', true)", [user, `${user}@example.com`]); await pool.query("commit");
  await pool.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${APP}') then create role ${APP} login; end if; end $$`); await pool.query(roleSql);
});
afterAll(async () => { await pool.query(`drop owned by ${APP}`).then(() => pool.query(`drop role if exists ${APP}`)).catch(() => undefined); await pool.end(); });

describe("authorisation", () => {
  it("the runtime role is refused (exit 5) for list, set and clear, and nothing is written", async () => {
    const rt = new pg.Pool({ connectionString: URL_, max: 1 }); rt.on("connect", (cl) => { void cl.query(`set session authorization ${APP}`); }); const rdb = createDb(rt), key = uniq();
    try {
      for (const args of [["list"], ["set", ...base(key), "--apply", "--expected-event", "none"], ["clear", ...base(key), "--apply", "--expected-event", "none"]]) { const r = await cli(args, rdb); expect(r.code, args[0]).toBe(5); expect(r.err).toMatch(/NOT_AUTHORISED/); }
    } finally { await rt.end(); }
    expect(await nEvents(key)).toBe(0);
  });
  it("a database outage is a plain failure (exit 1), not an authorisation answer", async () => {
    const dead = new pg.Pool({ connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 }); dead.on("error", () => undefined);
    try { const r = await cli(["list"], createDb(dead)); expect(r.code).toBe(1); expect(r.err).not.toMatch(/NOT_AUTHORISED/); expect(r.err + r.out).not.toMatch(/nobody|nothing|127\.0\.0\.1/); } finally { await dead.end().catch(() => undefined); }
  });
});

describe("dry run, apply and concurrency", () => {
  it("set is a DRY RUN by default: it writes nothing and reports the latest event to expect", async () => {
    const key = uniq(), r = await cli(["set", ...base(key)]); expect(r.code).toBe(0); const o = j(r.out); expect(o).toMatchObject({ dryRun: true, latestEventId: null, useExpectedEvent: "none" }); expect(await nEvents(key)).toBe(0);
  });
  it("--apply needs --expected-event (a uuid or `none`); without it nothing is written", async () => {
    const key = uniq(); for (const extra of [[], ["--expected-event", "banana"]]) { const r = await cli(["set", ...base(key, ["--apply", ...extra])]); expect(r.code).toBe(2); }
    expect(await nEvents(key)).toBe(0);
  });
  it("apply writes the control event AND the audit-chain row (one transaction): OWNER actor kind, the declared operator, the previous event id", async () => {
    const key = uniq(), r = await cli(["set", ...base(key, ["--apply", "--expected-event", "none"])]); expect(r.code).toBe(0); const o = j(r.out);
    expect(o).toMatchObject({ applied: true, action: "SET", scope: "MARKET", scopeKey: key, previousEventId: null });
    const ev = (await rows("select actor, actor_kind, action, kind, user_id from risk_control_events where id = $1", [o["eventId"]]))[0]!; expect(ev).toMatchObject({ actor: OP, actor_kind: "OWNER", action: "SET", kind: "KILL_SWITCH", user_id: null });
    const au = (await rows("select event_type, entity_type, entity_id, actor_type, actor_id, metadata from audit_events where id = $1", [o["auditId"]]))[0]!; expect(au).toMatchObject({ event_type: "risk_control.set", entity_type: "risk_control_event", entity_id: o["eventId"], actor_id: OP }); expect(au["metadata"]).toMatchObject({ kind: "KILL_SWITCH", scopeKey: key, previousEventId: null });
  });
  it("a stale --expected-event is refused (exit 4) and writes nothing; the right one appends", async () => {
    const key = uniq(), first = j((await cli(["set", ...base(key, ["--apply", "--expected-event", "none"])])).out);
    const stale = await cli(["set", ...base(key, ["--apply", "--expected-event", "none"])]); expect(stale.code).toBe(4); expect(stale.err).toMatch(/CONCURRENT_CHANGE/); expect(await nEvents(key)).toBe(1);
    const ok = await cli(["set", ...base(key, ["--apply", "--expected-event", first["eventId"] as string])]); expect(ok.code).toBe(0); expect(j(ok.out)["previousEventId"]).toBe(first["eventId"]); expect(await nEvents(key)).toBe(2);
  });
  it("list shows the history and the controls in force", async () => {
    const key = uniq(); await cli(["set", ...base(key, ["--apply", "--expected-event", "none"])]);
    const active = j((await cli(["list", "--scope", "MARKET", "--active-only"])).out)["events"] as Array<{ scopeKey: string }>; expect(active.some((e) => e.scopeKey === key)).toBe(true);
    const hist = j((await cli(["list", "--scope", "MARKET", "--limit", "500"])).out)["events"] as Array<{ scopeKey: string }>; expect(hist.some((e) => e.scopeKey === key)).toBe(true);
  });
});

describe("clearing", () => {
  it("there is nothing to clear for a control that is not in force (exit 3)", async () => {
    const key = uniq(), r = await cli(["clear", ...base(key, ["--kind", "RESTRICTION", "--apply", "--expected-event", "none", "--confirm", `CLEAR:MARKET:${key}:RESTRICTION:platform`])]); expect(r.code).toBe(3); expect(r.err).toMatch(/NOT_IN_FORCE/); expect(await nEvents(key)).toBe(0); // (the confirmation is checked first: a platform clear is always "dangerous")
  });
  it("a dangerous clear (a KILL_SWITCH, a drawdown halt, anything platform-wide) needs the exact confirm token the dry run prints", async () => {
    const key = uniq(), set = j((await cli(["set", ...base(key, ["--apply", "--expected-event", "none"])])).out);
    const dry = j((await cli(["clear", ...base(key)])).out); expect(dry["confirmToken"]).toBe(`CLEAR:MARKET:${key}:KILL_SWITCH:platform`); expect(dry["dryRun"]).toBe(true);
    for (const extra of [[], ["--confirm", "yes"], ["--confirm", `CLEAR:MARKET:${key}:RESTRICTION:platform`]]) { const r = await cli(["clear", ...base(key, ["--apply", "--expected-event", set["eventId"] as string, ...extra])]); expect(r.code).toBe(3); expect(r.err).toMatch(/CONFIRMATION_REQUIRED/); }
    expect(await nEvents(key)).toBe(1);
    const ok = await cli(["clear", ...base(key, ["--apply", "--expected-event", set["eventId"] as string, "--confirm", dry["confirmToken"] as string])]); expect(ok.code).toBe(0);
    const still = (j((await cli(["list", "--scope", "MARKET", "--active-only"])).out)["events"] as Array<{ scopeKey: string }>).some((e) => e.scopeKey === key); expect(still).toBe(false);
    expect((await rows("select event_type from audit_events where id = $1", [j(ok.out)["auditId"]]))[0]).toMatchObject({ event_type: "risk_control.cleared" });
  });
  it("a USER-scope control is keyed by the user id, so the owner CLEAR matches the planning cycle's halt (written through the door) and lifts it", async () => {
    const door = await recordUserHalt(owner, user, { kind: "DRAWDOWN_HALT", reason: "drawdown level HALT reached", expiresAt: null });
    const args = ["--scope", "USER", "--user", user, "--kind", "DRAWDOWN_HALT", "--reason", "owner reviewed the drawdown", "--changed-by", OP];
    const dry = j((await cli(["clear", ...args])).out); expect(dry["latestEventId"]).toBe(door); expect(dry["confirmToken"]).toBe(`CLEAR:USER:${user}:DRAWDOWN_HALT:${user}`);
    expect((await cli(["clear", ...args, "--scope-key", randomUUID(), "--apply", "--expected-event", door])).code).toBe(2);
    const ok = await cli(["clear", ...args, "--apply", "--expected-event", door, "--confirm", dry["confirmToken"] as string]); expect(ok.code).toBe(0);
    expect((await rows("select scope_key, action, actor_kind from risk_control_events where id = $1", [j(ok.out)["eventId"]]))[0]).toMatchObject({ scope_key: user, action: "CLEAR", actor_kind: "OWNER" });
    expect((j((await cli(["list", "--user", user, "--active-only"])).out)["events"] as unknown[]).length).toBe(0);
  });
});

describe("validation and all-or-nothing", () => {
  it("invalid input is refused before anything is written", async () => {
    const key = uniq(), bad: Array<[string, string[], number]> = [
      ["short reason", ["set", "--scope", "MARKET", "--scope-key", key, "--kind", "KILL_SWITCH", "--reason", "short", "--changed-by", OP, "--apply", "--expected-event", "none"], 3],
      ["operator without the operator: prefix", ["set", ...base(key).slice(0, -1), "bob", "--apply", "--expected-event", "none"], 3],
      ["expiry in the past", ["set", ...base(key, ["--expires", "2020-01-01T00:00:00Z", "--apply", "--expected-event", "none"])], 3],
      ["expiry on a CLEAR", ["clear", ...base(key, ["--expires", "2099-01-01T00:00:00Z", "--apply", "--expected-event", "none"])], 3],
      ["platform scope without a scope key", ["set", "--scope", "MARKET", "--kind", "KILL_SWITCH", "--reason", "owner CLI integration test", "--changed-by", OP], 2],
      ["platform scope with a user", ["set", ...base(key, ["--user", user])], 2],
      ["USER scope without a user", ["set", "--scope", "USER", "--kind", "DRAWDOWN_HALT", "--reason", "owner CLI integration test", "--changed-by", OP], 2],
      ["unknown kind", ["set", ...base(key).map((a) => (a === "KILL_SWITCH" ? "DELETE_EVERYTHING" : a))], 2],
      ["unknown scope", ["list", "--scope", "GLOBAL"], 2],
    ];
    for (const [name, args, code] of bad) { const r = await cli(args); expect(r.code, name).toBe(code); }
    expect(await nEvents(key)).toBe(0);
  });
  it("a failure after the control event is written (the audit row cannot be written) leaves NO control event behind", async () => {
    const key = uniq(); let calls = 0;
    const flaky = { transaction: <T,>(fn: (tx: unknown) => Promise<T>) => owner.transaction((tx) => fn(new Proxy(tx as object, { get: (t, k) => (k === "execute" ? (q: unknown) => { calls++; if (JSON.stringify(q).includes("audit_events")) throw new Error("audit row refused"); return (t as { execute: (x: unknown) => unknown }).execute(q); } : (t as Record<string | symbol, unknown>)[k]) }))) } as unknown as Pick<Db, "transaction">;
    await expect(ownerChangeControl(flaky, { scope: "MARKET", scopeKey: key, kind: "KILL_SWITCH", userId: null }, "SET", { reason: "owner CLI integration test", operator: OP, expectedLatest: "none" })).rejects.toThrow(/audit row refused/);
    expect(calls).toBeGreaterThanOrEqual(3); expect(await nEvents(key)).toBe(0);
    await expect(ownerChangeControl(owner, { scope: "MARKET", scopeKey: key, kind: "KILL_SWITCH", userId: null }, "SET", { reason: "x", operator: OP, expectedLatest: "none" })).rejects.toBeInstanceOf(OwnerControlError);
  });
  it("the hash-chained audit trail verifies after all of these changes", async () => {
    const r = await verifyAuditChainsWithPool(pool, { chains: ["audit_events"] }); expect(r.ok).toBe(true);
  });
});
