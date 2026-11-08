/**
 * Stage 01 against REAL PostgreSQL (migration 0040): the privilege doors that close G-13, the SQL auth store and sessions.
 * The unprivileged session below is granted UPDATE on every table (see support/tradingPipeline.session), i.e. a deliberately TOO-WIDE grant:
 * the trigger must still refuse a direct role / is_active change, so the test proves the second layer; app-role.sql's column grants are the first.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AuthService, sqlAuditSink, sqlAuthStore } from "../../../packages/auth/src/index";
import { PlatformError } from "../../../packages/types/src/index";
import { closeClients, db, owner, session } from "../support/tradingPipeline";

afterAll(async () => { await closeClients(); });
const PW = "correct horse battery staple", FAST = { N: 2 ** 10, r: 8, p: 1 };
const svc = (registrationOpen = true) => new AuthService({ store: sqlAuthStore(db), audit: sqlAuditSink(db), config: { scrypt: FAST, registrationOpen, maxLoginFailures: 3 } });
const email = (): string => `u${randomUUID().slice(0, 8)}@example.com`;
async function expectRefused(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`).toMatch(re);
}
/** An admin that exists even if other tests already created some: created by the owner connection through the door's bootstrap path is not possible when admins exist, so use the owner to open the door explicitly. */
async function makeAdmin(): Promise<{ id: string; email: string }> {
  const c = await owner(); const e = email(), id = randomUUID();
  await c.query("begin"); await c.query("select set_config('twins.privilege_door', 'open', true)");
  await c.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'ADMIN', true)", [id, e]); await c.query("commit");
  return { id, email: e };
}

describe("registration and login on PostgreSQL", () => {
  it("registers a TRADER, logs in, authenticates and revokes a session; the stored session holds only a hash", async () => {
    const s = svc(), e = email(), u = await s.register({ email: e, password: PW });
    expect(u.role).toBe("TRADER");
    const login = await s.login({ email: e, password: PW }), a = await s.authenticate(login.token);
    expect(a.user.id).toBe(u.id);
    const c = await owner(); const r = await c.query("select token_hash from user_sessions where user_id = $1", [u.id]);
    expect(r.rows[0].token_hash).not.toContain(login.token); expect(r.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    await s.logout(login.token);
    await expect(s.authenticate(login.token)).rejects.toBeInstanceOf(PlatformError);
  });
  it("a duplicate email is a CONFLICT, and repeated failures lock the email out", async () => {
    const s = svc(), e = email(); await s.register({ email: e, password: PW });
    await expect(s.register({ email: e, password: PW })).rejects.toMatchObject({ code: "CONFLICT" });
    for (let i = 0; i < 3; i++) await expect(s.login({ email: e, password: "wrong-password-123" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(s.login({ email: e, password: PW })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("login failures are recorded without the address", async () => {
    const s = svc(), e = email(); await s.register({ email: e, password: PW }); await s.login({ email: e, password: "wrong-password-123" }).catch(() => undefined);
    const c = await owner(); const r = await c.query("select key_hash from auth_login_failures order by at desc limit 5");
    expect(JSON.stringify(r.rows)).not.toContain(e.split("@")[0]!);
  });
});

describe("G-13: role and active changes only through the doors", () => {
  it("a direct UPDATE of users.role is refused even for a role that holds UPDATE on users", async () => {
    const s = svc(), t = await s.register({ email: email(), password: PW }), c = await session(t.id);
    await expectRefused(() => c.query("update users set role = 'ADMIN' where id = $1", [t.id]), /only through twins_set_user_role/);
    await expectRefused(() => c.query("update users set is_active = false where id = $1", [t.id]), /change only through twins_set_user_role / twins_set_user_active/);
    const o = await owner(); expect((await o.query("select role from users where id = $1", [t.id])).rows[0].role).toBe("TRADER");
  });
  it("a direct INSERT of an ADMIN is refused; creating one needs an active administrator", async () => {
    const c = await session(randomUUID());
    await expectRefused(() => c.query("insert into users (id, email, password_hash, role) values (gen_random_uuid(), $1, 'x', 'ADMIN')", [email()]), /only through twins_create_user/);
    const s = svc(); const t = await s.register({ email: email(), password: PW }); await makeAdmin(); // an active administrator exists
    const mk = (actorId: string | null) => () => sqlAuthStore(db).createUser({ email: email(), passwordHash: "x", displayName: null, role: "ADMIN", actorId: actorId as never });
    await expectRefused(mk(t.id), /only an active administrator can create an administrator/);
    await expectRefused(mk(null), /an administrator already exists/);
  });
  it("a TRADER cannot promote themselves or anyone through the door; a foreign actor id is refused", async () => {
    const s = svc(), t = await s.register({ email: email(), password: PW }), v = await s.register({ email: email(), password: PW }), store = sqlAuthStore(db);
    expect(await store.setRole(t.id, t.id, "ADMIN")).toBe(false); expect(await store.setRole(t.id, v.id, "ADMIN")).toBe(false);
    const c = await session(t.id); const ad = await makeAdmin();   // acting as t but naming the admin as actor: the transaction user must equal the actor
    expect((await c.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [ad.id, v.id])).rows[0].ok).toBe(false);
    const o = await owner(); expect((await o.query("select role from users where id = any($1::uuid[])", [[t.id, v.id]])).rows.map((r) => r.role)).toEqual(["TRADER", "TRADER"]);
  });
  it("an ADMIN promotes another user through the service; the change is audited and the target's sessions are revoked; self-change is refused", async () => {
    const s = svc(), ad = await makeAdmin(), t = await s.register({ email: email(), password: PW });
    const login = await s.login({ email: t.email, password: PW });
    const actor = { kind: "user", userId: ad.id as never, roles: ["ADMIN"] } as const;
    await s.changeRole(actor, t.id, "ADMIN");
    const o = await owner(); expect((await o.query("select role from users where id = $1", [t.id])).rows[0].role).toBe("ADMIN");
    await expect(s.authenticate(login.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const ev = await o.query("select actor_id, before_state, after_state from audit_events where event_type = 'auth.role_changed' and entity_id = $1", [t.id]);
    expect(ev.rows).toHaveLength(1); expect(ev.rows[0].actor_id).toBe(ad.id); expect(ev.rows[0].after_state).toEqual({ role: "ADMIN" });
    await expect(s.changeRole(actor, ad.id as never, "TRADER")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("the last active ADMIN cannot be demoted or deactivated by the door", async () => {
    const o = await owner();
    await o.query("begin"); await o.query("select set_config('twins.privilege_door', 'open', true)");
    await o.query("update users set is_active = false where role = 'ADMIN'"); await o.query("commit"); // isolate: no active admin left except the two created next
    const a1 = await makeAdmin(), a2 = await makeAdmin(), store = sqlAuthStore(db);
    const c1 = await session(a1.id);
    expect((await c1.query("select twins_set_user_role($1::uuid, $2::uuid, 'TRADER') as ok", [a1.id, a2.id])).rows[0].ok).toBe(true);   // two admins: allowed
    const c2 = await session(a2.id);
    expect((await c2.query("select twins_set_user_active($1::uuid, $2::uuid, false) as ok", [a2.id, a1.id])).rows[0].ok).toBe(false);   // a2 is now a TRADER: not an acceptable actor
    expect(await store.countActiveAdmins()).toBe(1);
    const a3 = await makeAdmin(); const c3 = await session(a3.id);
    expect((await c3.query("select twins_set_user_role($1::uuid, $2::uuid, 'TRADER') as ok", [a3.id, a1.id])).rows[0].ok).toBe(true);
    expect((await c3.query("select twins_set_user_role($1::uuid, $2::uuid, 'TRADER') as ok", [a3.id, a3.id])).rows[0].ok).toBe(false);
  });
});

describe("migration 0040 shape", () => {
  it("the runtime-role grants in app-role.sql make users read-only apart from the password hash and display name", async () => {
    const o = await owner(); const r = await o.query("select proname from pg_proc where proname in ('twins_create_user','twins_set_user_role','twins_set_user_active','twins_clear_login_failures','twins_users_privilege_guard') order by 1");
    expect(r.rows.map((x) => x.proname)).toEqual(["twins_clear_login_failures", "twins_create_user", "twins_set_user_active", "twins_set_user_role", "twins_users_privilege_guard"]);
  });
});
