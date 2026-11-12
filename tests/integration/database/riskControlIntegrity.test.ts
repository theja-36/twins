/**
 * Risk-control hardening (migration 0047, infrastructure/staging/app-role.sql) against REAL PostgreSQL. The runtime role is created and granted by the ACTUAL app-role.sql, and every attempt runs as the role's own LOGIN
 * identity with `SET LOCAL SESSION AUTHORIZATION` (not `SET ROLE`): the guard trigger keys on session_user, so only a session-authorization switch shows the database the same identity a real connection would.
 * Proves: the runtime role cannot INSERT directly, cannot create platform-wide controls, CLEAR events or OWNER-labelled events; the one door accepts only valid USER-scope SYSTEM SET halts; the guard also holds against an over-granted role
 * and against a SUPERUSER that is not on the allowlist; RLS and append-only protections remain; the privilege self-check detects each regression. It does NOT and cannot prove that twins.user_id is authenticated (it is not: documented limitation).
 */
import { mintSessionToken } from "../support/boundSession";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRiskControlProtection, checkRuntimeRolePrivileges } from "../../../packages/audit-chain/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";

const APP = "twins_app_ctl", PROBE = "twins_guard_probe", SUPER = "twins_super_probe";
const roleSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${APP}"`).replaceAll(":'app_role'", `'${APP}'`);
let c: pg.Client, c2: pg.Client, A: string, B: string;
const mkUser = async (): Promise<string> => {
  const id = randomUUID(); await c.query("begin"); await c.query("select set_config('twins.privilege_door', 'open', true)");
  await c.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'TRADER', true)", [id, `${id}@example.com`]); await c.query("commit"); return id;
};
/** Run `fn` as the role's own login identity (session_user and current_user), optionally with a user bound to the transaction; always rolled back. */
async function as<T>(role: string, fn: () => Promise<T>, userId?: string): Promise<T> {
  const token = userId ? await mintSessionToken(c, userId) : undefined;
  await c.query("begin"); await c.query(`set local session authorization ${role}`); if (userId) await c.query("select public.twins_bind_session($1)", [token]);
  try { return await fn(); } finally { await c.query("rollback"); }
}
const attempt = async (role: string, q: string, p: unknown[] = [], user?: string): Promise<{ ok: boolean; code: string; msg: string }> =>
  as(role, async () => { try { await c.query(q, p); return { ok: true, code: "", msg: "" }; } catch (e) { const x = e as { code?: string; message?: string }; return { ok: false, code: x.code ?? "error", msg: x.message ?? "" }; } }, user);
const INSERT = "insert into risk_control_events (id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)";
const row = (o: Partial<{ user: string | null; scope: string; key: string | null; kind: string; action: string; actor: string; actorKind: string; exp: string | null }>): unknown[] => [o.user ?? null, o.scope ?? "MARKET", o.key ?? "NSE", o.kind ?? "RESTRICTION", o.action ?? "SET", "contract test control", o.actor ?? "test", o.actorKind ?? "OWNER", o.exp ?? null];
const GUARD = /may append only a USER-scope SET halt/;
const planning = (user: string, over: Parameters<typeof row>[0] = {}): unknown[] => row({ user, scope: "USER", key: user, kind: "DAILY_LOSS_HALT", action: "SET", actor: "planning-cycle", actorKind: "SYSTEM", exp: "2031-01-07T00:00:00Z", ...over });
const count = async (sql: string, p: unknown[] = []): Promise<number> => Number(((await c.query(sql, p)).rows[0] as { n: string | number }).n);

beforeAll(async () => {
  c = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await c.connect(); c2 = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await c2.connect();
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${APP}') then create role ${APP} login; end if; end $$`);
  await c.query(roleSql);
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${PROBE}') then create role ${PROBE} login; end if; end $$`);
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${SUPER}') then create role ${SUPER} login superuser; end if; end $$`);
  await c.query(`grant usage on schema public to ${PROBE}`); await c.query(`grant select, insert on risk_control_events to ${PROBE}`); await c.query(`grant execute on function public.twins_bind_session(text) to ${PROBE}`); // an OVER-GRANTED role: the guard must hold even if a grant is wrong
  [A, B] = [await mkUser(), await mkUser()];
  await c.query(INSERT, row({ user: null, scope: "MARKET", key: `PLAT-${A.slice(0, 8)}`, kind: "RESTRICTION" })); // a platform control written on the owner path
  await c.query(INSERT, planning(A, { exp: null, kind: "DRAWDOWN_HALT" })); await c.query(INSERT, planning(B, { exp: null, kind: "DRAWDOWN_HALT" }));
});
afterAll(async () => {
  for (const r of [PROBE, SUPER, APP]) await c.query(`drop owned by ${r}`).then(() => c.query(`drop role if exists ${r}`)).catch(() => undefined);
  await c.end(); await c2.end();
});

describe("the runtime role (app-role.sql applied for real) has no direct write path to risk_control_events", () => {
  it("cannot INSERT any row at all: the valid planning shape, a platform row, a CLEAR claiming OWNER, and an unbound user row are all refused for want of the privilege", async () => {
    for (const [name, params, user] of [["valid planning shape, user bound", planning(A), A], ["platform row, unbound", row({ user: null, scope: "MARKET", key: "NSE", kind: "KILL_SWITCH", actorKind: "SYSTEM" }), undefined], ["CLEAR claiming OWNER (platform), unbound", row({ action: "CLEAR", actorKind: "OWNER" }), undefined], ["user row, unbound", planning(A), undefined]] as const) {
      const r = await attempt(APP, INSERT, [...params], user); expect(r.ok, name).toBe(false); expect(r.code, name).toBe("42501"); expect(r.msg, name).toMatch(/permission denied/);
    }
  });
  it("cannot UPDATE, DELETE or TRUNCATE either", async () => {
    for (const q of ["update risk_control_events set reason = 'tampered reason text'", "delete from risk_control_events", "truncate risk_control_events"]) { const r = await attempt(APP, q); expect(r.ok, q).toBe(false); expect(r.code, q).toBe("42501"); }
  });
  it("holds only SELECT on the table, and nothing at all on the owner allowlist (so it cannot allow-list itself)", async () => {
    const p = (await c.query("select has_table_privilege($1, 'risk_control_events', 'SELECT') as s, has_table_privilege($1, 'risk_control_events', 'INSERT') as i, has_table_privilege($1, 'twins_control_privileged_roles', 'SELECT') as a_s, has_table_privilege($1, 'twins_control_privileged_roles', 'INSERT') as a_i", [APP])).rows[0] as Record<string, boolean>;
    expect(p).toEqual({ s: true, i: false, a_s: false, a_i: false });
    for (const q of ["select * from twins_control_privileged_roles", "insert into twins_control_privileged_roles (role_name, purpose) values ('twins_app_ctl', 'self allow-listing attempt')"]) { const r = await attempt(APP, q); expect(r.ok, q).toBe(false); expect(r.code, q).toBe("42501"); }
  });
});

describe("the guard trigger holds even if a grant is wrong (an over-granted role) and even for a SUPERUSER that is not allow-listed", () => {
  for (const who of [PROBE, SUPER]) {
    it(`${who}: refuses every shape except the planning cycle's, and accepts that one`, async () => {
      const refused: Array<[string, unknown[], string | undefined]> = [
        ["platform row, unbound", row({ user: null, scope: "MARKET", key: "NSE", kind: "KILL_SWITCH", actorKind: "SYSTEM" }), undefined],
        ["CLEAR claiming OWNER", row({ action: "CLEAR", actorKind: "OWNER" }), undefined],
        ["OWNER-labelled SET", planning(A, { actorKind: "OWNER" }), A],
        ["USER row, user not bound", planning(A), undefined],
        ["USER row for another user than the one bound", planning(B), A],
        ["USER row with the wrong actor", planning(A, { actor: "someone-else" }), A],
        ["USER row with a non-halt kind (KILL_SWITCH)", planning(A, { kind: "KILL_SWITCH" }), A],
        ["USER row, a RESTRICTION", planning(A, { kind: "RESTRICTION" }), A],
        ["USER row with a null scope key", planning(A, { key: null }), A],
        ["USER CLEAR by the system actor", planning(A, { action: "CLEAR", kind: "DAILY_LOSS_HALT", exp: null }), A],
      ];
      for (const [name, params, user] of refused) { const r = await attempt(who, INSERT, params, user); expect(r.ok, `${who} ${name}`).toBe(false); expect(r.msg, `${who} ${name}`).toMatch(GUARD); }
      expect((await attempt(who, INSERT, planning(A), A)).ok).toBe(true); // the one shape the planning cycle writes
    });
  }
  it("the allow-listed owner path (the migrating login role) may write a platform control and a CLEAR", async () => {
    expect((await c.query("select session_user::text as u")).rows[0]).toMatchObject({ u: expect.any(String) });
    await c.query("begin"); try { await c.query(INSERT, row({ user: null, scope: "MARKET", key: "OWNER-PATH", kind: "KILL_SWITCH" })); await c.query(INSERT, row({ user: null, scope: "MARKET", key: "OWNER-PATH", kind: "KILL_SWITCH", action: "CLEAR" })); } finally { await c.query("rollback"); }
  });
  it("the guard survives session_replication_role = replica (the usual way to switch triggers off): it is ENABLE ALWAYS", async () => {
    await c.query("begin"); try { await c.query("set local session_replication_role = replica"); await c.query(`set local session authorization ${SUPER}`); const r = await c.query(INSERT, row({ user: null, scope: "MARKET", key: "NSE", kind: "KILL_SWITCH", actorKind: "SYSTEM" })).then(() => "ok", (e: { message: string }) => e.message); expect(r).toMatch(GUARD); } finally { await c.query("rollback"); }
  });
});

describe("twins_set_user_halt: the one runtime door", () => {
  const door = "select twins_set_user_halt($1, $2, $3::timestamptz) as id";
  it("an unbound call is refused; a bound call records exactly one USER-scope SET row with the fixed columns, whatever the arguments", async () => {
    expect((await attempt(APP, door, ["DRAWDOWN_HALT", "drawdown level reached", null])).code).toBe("42501");
    const uid = await mkUser();
    await as(APP, async () => {
      const id = ((await c.query(door, ["DRAWDOWN_HALT", "drawdown level HALT reached", null])).rows[0] as { id: string }).id;
      const r = (await c.query("select user_id, scope, scope_key, kind, action, actor, actor_kind, expires_at from risk_control_events where id = $1", [id])).rows[0] as Record<string, unknown>;
      expect(r).toMatchObject({ user_id: uid, scope: "USER", scope_key: uid, kind: "DRAWDOWN_HALT", action: "SET", actor: "planning-cycle", actor_kind: "SYSTEM", expires_at: null });
    }, uid);
  });
  it("accepts only the two halt kinds and a sane reason and expiry; each invalid request is refused with a check violation and writes nothing", async () => {
    const uid = await mkUser(), ok = "2031-01-07T00:00:00Z";
    const bad: Array<[string, unknown[]]> = [
      ["KILL_SWITCH", ["KILL_SWITCH", "kill switch by the runtime", null]], ["RESTRICTION", ["RESTRICTION", "restriction by the runtime", null]], ["null kind", [null, "a valid reason text", null]], ["unknown kind", ["CLEAR", "a valid reason text", null]],
      ["short reason", ["DRAWDOWN_HALT", "short", null]], ["null reason", ["DRAWDOWN_HALT", null, null]], ["reason over 500 characters", ["DRAWDOWN_HALT", "x".repeat(501), null]],
      ["daily halt without an expiry", ["DAILY_LOSS_HALT", "daily loss limit reached", null]], ["daily halt expiry decades away", ["DAILY_LOSS_HALT", "daily loss limit reached", "9999-01-01T00:00:00Z"]], ["daily halt already long expired", ["DAILY_LOSS_HALT", "daily loss limit reached", "2020-01-01T00:00:00Z"]],
      ["drawdown halt WITH an expiry", ["DRAWDOWN_HALT", "drawdown level reached", ok]],
    ];
    for (const [name, p] of bad) { const r = await attempt(APP, door, p, uid); expect(r.ok, name).toBe(false); expect(r.code, name).toBe("23514"); }
    expect(await count("select count(*) as n from risk_control_events where user_id = $1", [uid])).toBe(0);
    expect((await attempt(APP, door, ["DAILY_LOSS_HALT", "daily loss limit reached", ok], uid)).ok).toBe(true);
  });
  it("is idempotent: an identical halt is returned, not appended again; a different expiry appends; a hostile reason is stored verbatim as data", async () => {
    const uid = await mkUser(), hostile = "x'; delete from risk_control_events; -- <script>alert(1)</script>", e1 = "2031-01-07T00:00:00Z", e2 = "2031-01-08T00:00:00Z";
    const tok = await mintSessionToken(c, uid);
    await c.query("begin"); await c.query(`set local session authorization ${APP}`); await c.query("select public.twins_bind_session($1)", [tok]);
    const one = ((await c.query(door, ["DAILY_LOSS_HALT", hostile, e1])).rows[0] as { id: string }).id, again = ((await c.query(door, ["DAILY_LOSS_HALT", hostile, e1])).rows[0] as { id: string }).id, next = ((await c.query(door, ["DAILY_LOSS_HALT", hostile, e2])).rows[0] as { id: string }).id;
    await c.query("commit"); // the rows must outlive the rolled-back helper: they belong to a fresh user
    expect(again).toBe(one); expect(next).not.toBe(one); expect(await count("select count(*) as n from risk_control_events where user_id = $1", [uid])).toBe(2);
    expect(((await c.query("select reason from risk_control_events where id = $1", [one])).rows[0] as { reason: string }).reason).toBe(hostile);
    expect(await count("select count(*) as n from risk_control_events")).toBeGreaterThan(2); // the hostile statement deleted nothing
  });
  it("two concurrent identical calls (separate connections) record ONE row (advisory lock)", async () => {
    const uid = await mkUser(), call = async (cl: pg.Client): Promise<string> => { const tok = await mintSessionToken(c, uid); await cl.query("begin"); await cl.query(`set local session authorization ${APP}`); await cl.query("select public.twins_bind_session($1)", [tok]); const id = ((await cl.query(door, ["DRAWDOWN_HALT", "concurrent drawdown halt", null])).rows[0] as { id: string }).id; await cl.query("commit"); return id; };
    const [x, y] = await Promise.all([call(c), call(c2)]); expect(x).toBe(y); expect(await count("select count(*) as n from risk_control_events where user_id = $1", [uid])).toBe(1);
  });
  it("is not executable by PUBLIC or by a role that was not granted it", async () => {
    const r = await attempt(PROBE, door, ["DRAWDOWN_HALT", "probe without execute", null], A); expect(r.ok).toBe(false); expect(r.code).toBe("42501"); expect(r.msg).toMatch(/permission denied for function/);
  });
});

describe("RLS and append-only protections remain effective", () => {
  it("unbound sees only platform controls; a bound user sees their own plus platform, never another user's", async () => {
    const seen = async (user?: string): Promise<{ own: number; other: number; platform: number }> => as(APP, async () => ({ own: await count("select count(*) as n from risk_control_events where user_id = $1", [A]), other: await count("select count(*) as n from risk_control_events where user_id = $1", [B]), platform: await count("select count(*) as n from risk_control_events where user_id is null") }), user);
    const unbound = await seen(), asA = await seen(A), asB = await seen(B);
    expect(unbound.own + unbound.other).toBe(0); expect(unbound.platform).toBeGreaterThan(0); expect(asA.own).toBeGreaterThan(0); expect(asA.other).toBe(0); expect(asB.other).toBeGreaterThan(0); expect(asB.own).toBe(0);
  });
  it("update, delete and truncate are refused by the append-only triggers even for the owner path and under session_replication_role = replica", async () => {
    for (const mode of ["origin", "replica"]) for (const q of ["update risk_control_events set reason = 'tampered reason text'", "delete from risk_control_events", "truncate risk_control_events"]) {
      await c.query("begin"); try { await c.query(`set local session_replication_role = ${mode}`); const r = await c.query(q).then(() => "ok", (e: { code?: string }) => e.code); expect(r, `${mode}: ${q}`).toBe("23001"); } finally { await c.query("rollback"); }
    }
  });
  it("the owner allowlist is append-only too (UPDATE, DELETE, TRUNCATE refused even for the owner) and lists the migrating login role", async () => {
    for (const q of ["update twins_control_privileged_roles set purpose = 'tampered purpose text'", "delete from twins_control_privileged_roles", "truncate twins_control_privileged_roles"]) { await c.query("begin"); try { const r = await c.query(q).then(() => "ok", (e: { code?: string }) => e.code); expect(r, q).toBe("23001"); } finally { await c.query("rollback"); } }
    expect(await count("select count(*) as n from twins_control_privileged_roles")).toBeGreaterThanOrEqual(1);
  });
});

describe("the privilege self-check passes for the runtime role and detects each regression", () => {
  const checkAs = async (role: string, ddl: string[] = []): Promise<string[]> => { await c.query("begin"); try { for (const q of ddl) await c.query(q); await c.query(`set local session authorization ${role}`); return await checkRuntimeRolePrivileges(c); } finally { await c.query("rollback"); } };
  it("an unmodified runtime role has no problems, and the risk-control part alone is clean", async () => {
    expect(await checkAs(APP)).toEqual([]);
    await c.query("begin"); try { await c.query(`set local session authorization ${APP}`); expect(await checkRiskControlProtection(c)).toEqual([]); } finally { await c.query("rollback"); }
  });
  it("the owner / superuser role does not pass", async () => { expect(await checkRuntimeRolePrivileges(c)).toEqual(expect.arrayContaining(["role_is:rolsuper"])); });
  const mutations: Array<[string, string[], string]> = [
    ["direct INSERT granted on risk_control_events", [`grant insert on risk_control_events to ${APP}`], "can_insert:risk_control_events"],
    ["UPDATE granted on risk_control_events", [`grant update on risk_control_events to ${APP}`], "can_update:risk_control_events"],
    ["EXECUTE on the door revoked", [`revoke execute on function twins_set_user_halt(text, text, timestamptz) from ${APP}`], "cannot_execute:twins_set_user_halt"],
    ["EXECUTE on the door granted to PUBLIC", ["grant execute on function twins_set_user_halt(text, text, timestamptz) to public"], "public_can_execute:twins_set_user_halt"],
    ["the door made SECURITY INVOKER", ["alter function twins_set_user_halt(text, text, timestamptz) security invoker"], "function_not_definer:twins_set_user_halt"],
    ["the door's search_path changed", ["alter function twins_set_user_halt(text, text, timestamptz) set search_path = public"], "function_search_path_not_fixed:twins_set_user_halt"],
    ["the door owned by another role", [`alter function twins_set_user_halt(text, text, timestamptz) owner to ${PROBE}`], "function_wrong_owner:twins_set_user_halt"],
    ["row-level security no longer forced", ["alter table risk_control_events no force row level security"], "rls_not_forced:risk_control_events"],
    ["row-level security disabled", ["alter table risk_control_events disable row level security"], "rls_not_enabled:risk_control_events"],
    ["the guard trigger disabled", ["alter table risk_control_events disable trigger risk_control_events_guard"], "trigger_not_always:risk_control_events_guard"],
    ["the guard trigger downgraded to ENABLE (origin only)", ["alter table risk_control_events enable trigger risk_control_events_guard"], "trigger_not_always:risk_control_events_guard"],
    ["the append-only trigger disabled", ["alter table risk_control_events disable trigger risk_control_events_no_update_delete"], "trigger_not_always:risk_control_events_no_update_delete"],
    ["the writer role given LOGIN", ["alter role twins_control_writer login"], "writer_role_is:rolcanlogin"],
    ["the writer role given BYPASSRLS", ["alter role twins_control_writer bypassrls"], "writer_role_is:rolbypassrls"],
    ["the writer role given CREATE on public", ["grant create on schema public to twins_control_writer"], "writer_role_can_create_in_public"],
    ["the runtime role made a member of the writer role", [`grant twins_control_writer to ${APP}`], "runtime_is_member_of_writer_role"],
    ["the runtime role given SELECT on the owner allowlist", [`grant select on twins_control_privileged_roles to ${APP}`], "can_access:twins_control_privileged_roles"],
  ];
  for (const [name, ddl, code] of mutations) it(`detects: ${name}`, async () => { expect(await checkAs(APP, ddl)).toEqual(expect.arrayContaining([code])); });
});
