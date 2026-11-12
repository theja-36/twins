/**
 * F5 against REAL PostgreSQL (migration 0049): the acting user is bound by the DATABASE from a credential, not named by the application.
 * Two real LOGIN roles, built by the ACTUAL infrastructure scripts, are used over SEPARATE connections (a role connecting as itself, not `SET ROLE` from a superuser):
 *   API    = app-role.sql                      : may bind a user only by presenting that user's live session token (twins_bind_session);
 *   SYSTEM = app-role.sql + system-role.sql    : the worker / scheduler identity (twins_bind_system_user), never given to the API.
 * Every attack below is attempted AS the API role, i.e. as compromised application code. Proves: a custom setting no longer impersonates anyone; one user's token cannot become another user; a stored hash, a forged,
 * expired, revoked or deactivated-user token is refused; an identity is bound once per transaction and dies with it (rollback, commit, savepoint, pooled connection reuse); the identity table cannot be forged; the API
 * role cannot reach the system door; the system role keeps only its intended permissions; and the owner/superuser path stays explicitly separate.
 * It does NOT prove the credential is uncompromisable: a process that is handed a user's token can act as that user for as long as the token is valid (as with any bearer-token service).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIdentityBinding } from "../../../packages/audit-chain/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { mintSessionToken } from "../support/boundSession";
import { createDb, withUser } from "../../../packages/database/src/index";
import { sql } from "drizzle-orm";

const API = "twins_f5_api", SYS = "twins_f5_sys", PW = "f5_test_not_a_secret";
const script = (file: string, vars: Record<string, string>): string => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`:"${k}"`, `"${v}"`).replaceAll(`:'${k}'`, `'${v}'`), readFileSync(file, "utf8"));
const urlFor = (role: string): string => { const u = new URL(requireTestDatabaseUrl()); u.username = role; u.password = PW; return u.toString(); };
let owner: pg.Client, api: pg.Client, api2: pg.Client, sys: pg.Client;
let A: string, B: string, acctA: string, acctB: string, tokA: string, tokB: string;

const mkUser = async (active = true): Promise<string> => {
  const id = randomUUID(); await owner.query("begin"); await owner.query("select set_config('twins.privilege_door', 'open', true)");
  await owner.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'TRADER', $3)", [id, `${id}@example.com`, active]); await owner.query("commit"); return id;
};
const mkAccount = async (u: string): Promise<string> => (await owner.query("insert into accounts (id, user_id, name, trading_mode) values (gen_random_uuid(), $1, 'f5 test account', 'paper') returning id", [u])).rows[0].id as string;
const profile = (u: string, acct: string, note: string): [string, unknown[]] => ["insert into user_capital_profiles (id, user_id, account_id, version, total_capital, available_capital, created_by) values (gen_random_uuid(), $1, $2, 1, 1000, 1000, $3)", [u, acct, note]];
const err = async (c: pg.Client, q: string, p: unknown[] = []): Promise<{ ok: boolean; code: string; msg: string }> => { try { await c.query(q, p); return { ok: true, code: "", msg: "" }; } catch (e) { const x = e as { code?: string; message?: string }; return { ok: false, code: x.code ?? "error", msg: x.message ?? "" }; } };
/** Run `fn` in one transaction on `c` (always rolled back unless `commit`), after binding with `token` through the API door. */
async function tx<T>(c: pg.Client, token: string | null, fn: () => Promise<T>, commit = false): Promise<T> {
  await c.query("begin"); if (token) await c.query("select public.twins_bind_session($1)", [token]);
  try { const r = await fn(); await c.query(commit ? "commit" : "rollback"); return r; } catch (e) { await c.query("rollback").catch(() => undefined); throw e; }
}
/** A statement expected to fail inside an open transaction: wrapped in a savepoint so the transaction stays usable. */
const errSp = async (c: pg.Client, q: string, p: unknown[] = []): Promise<{ ok: boolean; code: string; msg: string }> => { await c.query("savepoint e"); const r = await err(c, q, p); await c.query("rollback to savepoint e"); return r; };
const bound = async (c: pg.Client): Promise<string | null> => (await c.query("select public.twins_bound_user_id() as u")).rows[0].u as string | null;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await owner.connect();
  for (const r of [API, SYS]) await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login password '${PW}'; end if; end $$`);
  for (const r of [API, SYS]) await owner.query(script("infrastructure/staging/app-role.sql", { app_role: r }));
  await owner.query(script("infrastructure/staging/system-role.sql", { system_role: SYS }));
  api = new pg.Client({ connectionString: urlFor(API) }); api2 = new pg.Client({ connectionString: urlFor(API) }); sys = new pg.Client({ connectionString: urlFor(SYS) });
  await Promise.all([api.connect(), api2.connect(), sys.connect()]);
  [A, B] = [await mkUser(), await mkUser()]; [acctA, acctB] = [await mkAccount(A), await mkAccount(B)];
  [tokA, tokB] = [await mintSessionToken(owner, A), await mintSessionToken(owner, B)];
  // B owns a protected record that A must never see or touch
  const [q, p] = profile(B, acctB, "owned by B"); await owner.query(q, p);
});
afterAll(async () => {
  await Promise.all([api, api2, sys].map((c) => c.end().catch(() => undefined)));
  for (const r of [API, SYS]) await owner.query(`drop owned by ${r}`).then(() => owner.query(`drop role if exists ${r}`)).catch(() => undefined);
  await owner.end();
});

describe("F5: a custom setting is no longer an identity", () => {
  it("the API role can SET twins.user_id to another user, and it changes nothing: no rows, no insert, no door", async () => {
    await api.query("begin"); await api.query("select set_config('twins.user_id', $1, true)", [B]);
    expect(await bound(api)).toBeNull();
    expect((await api.query("select count(*)::int as n from user_capital_profiles")).rows[0].n).toBe(0);               // B's record is invisible
    const [q, p] = profile(B, acctB, "forged as B"); const r = await err(api, q, p); expect(r.ok).toBe(false);      // and B cannot be written
    await api.query("rollback");
  });
  it("a session-level setting (set_config(..., false)) does not survive into a bound transaction either", async () => {
    await api.query("select set_config('twins.user_id', $1, false)", [B]);
    await tx(api, tokA, async () => { expect(await bound(api)).toBe(A); expect((await api.query("select count(*)::int as n from user_capital_profiles")).rows[0].n).toBe(0); });
    await api.query("reset twins.user_id");
  });
  it("the doors act for nobody when only the setting is set", async () => {
    await api.query("begin"); await api.query("select set_config('twins.user_id', $1, true)", [B]);
    const r = await err(api, "select twins_set_user_halt('DRAWDOWN_HALT', 'impersonating user B now', null)"); await api.query("rollback");
    expect(r.ok).toBe(false); expect(r.code).toBe("42501"); expect(r.msg).toMatch(/no user bound/);
    expect((await owner.query("select count(*)::int as n from risk_control_events where user_id = $1", [B])).rows[0].n).toBe(0);
  });
});

describe("F5: the only way to become a user is to present that user's live credential", () => {
  it("A's token binds A and A sees only A's rows; B's protected record stays invisible, unwritable and unmodifiable", async () => {
    const [q, p] = profile(A, acctA, "owned by A");
    await tx(api, tokA, async () => {
      expect(await bound(api)).toBe(A);
      expect((await api.query(q, p)).rowCount).toBe(1);
      expect((await api.query("select count(*)::int as n from user_capital_profiles where user_id = $1", [B])).rows[0].n).toBe(0);
      expect((await api.query("select count(*)::int as n from user_capital_profiles")).rows[0].n).toBe(1);
      const [qb, pb] = profile(B, acctB, "A writing as B"); const w = await errSp(api, qb, pb); expect(w.ok).toBe(false); expect(w.msg).toMatch(/row-level security/);
      const u = await errSp(api, "update user_capital_profiles set available_capital = 1 where user_id = $1", [B]); expect(u.ok).toBe(false); expect(u.code).toBe("42501"); // append-only for the runtime role, whoever it is bound as
    });
    expect((await owner.query("select count(*)::int as n from user_capital_profiles where user_id = $1 and created_by = 'owned by B'", [B])).rows[0].n).toBe(1); // B's row is intact
  });
  it("binding to a different user in the same transaction is refused; the same user again is a harmless no-op", async () => {
    await api.query("begin"); await api.query("select public.twins_bind_session($1)", [tokA]);
    const again = await err(api, "select public.twins_bind_session($1)", [tokA]); expect(again.ok).toBe(true);
    const swap = await err(api, "select public.twins_bind_session($1)", [tokB]); expect(swap.ok).toBe(false); expect(swap.code).toBe("42501"); expect(swap.msg).toMatch(/already bound to another user/);
    await api.query("rollback");
  });
  it("a forged, malformed, stored-hash, expired, revoked or deactivated-user credential is refused with one uniform error", async () => {
    const hashOfA = createHash("sha256").update(tokA).digest("hex");                                   // the API role CAN read this column; it must not be usable as a credential
    const expired = await mintSessionToken(owner, A, { expired: true }), revoked = await mintSessionToken(owner, A, { revoked: true });
    const gone = await mkUser(false), goneTok = await mintSessionToken(owner, gone);
    const forged = "tws_" + randomBytes(32).toString("base64url");
    for (const [name, t] of [["forged", forged], ["hash of a real token", hashOfA], ["hash with prefix", "tws_" + hashOfA.slice(0, 43)], ["empty", ""], ["sql", "x' or '1'='1"], ["expired", expired], ["revoked", revoked], ["deactivated user", goneTok]] as const) {
      await api.query("begin"); const r = await err(api, "select public.twins_bind_session($1)", [t]); await api.query("rollback");
      expect(r.ok, name).toBe(false); expect(r.code, name).toBe("42501"); expect(r.msg, name).toBe("twins_bind_session: not authenticated");
    }
    await api.query("begin"); const n = await err(api, "select public.twins_bind_session(null)"); await api.query("rollback"); expect(n.ok).toBe(false);
  });
  it("a session revoked after the credential was minted stops working on the next transaction", async () => {
    const t = await mintSessionToken(owner, A);
    await tx(api, t, async () => { expect(await bound(api)).toBe(A); });
    await owner.query("update user_sessions set revoked_at = now() where token_hash = $1", [createHash("sha256").update(t).digest("hex")]);
    await api.query("begin"); const r = await err(api, "select public.twins_bind_session($1)", [t]); await api.query("rollback"); expect(r.ok).toBe(false);
  });
  it("A cannot use the doors to act as B: a door reads the BOUND user, so a claimed actor id is refused", async () => {
    await tx(api, tokA, async () => {
      expect((await api.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [B, A])).rows[0].ok).toBe(false);          // claiming B as the actor
      expect((await api.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [A, B])).rows[0].ok).toBe(false);          // A is a trader: not permitted either
      const h = (await api.query("select twins_set_user_halt('DRAWDOWN_HALT', 'halt recorded for the bound user', null) as id")).rows[0].id as string;
      expect((await api.query("select user_id from risk_control_events where id = $1", [h])).rows[0].user_id).toBe(A); // recorded for the BOUND user only
    }, false);
    expect((await owner.query("select role from users where id = $1", [A])).rows[0].role).toBe("TRADER");
  });
});

describe("F5: transaction scope, rollback, connection reuse and context reset do not leak identity", () => {
  it("the identity dies with a rollback and with a commit: the next transaction on the SAME connection is unbound", async () => {
    await tx(api, tokA, async () => expect(await bound(api)).toBe(A), false);
    expect(await bound(api)).toBeNull();
    await tx(api, tokA, async () => expect(await bound(api)).toBe(A), true);
    expect(await bound(api)).toBeNull();
    await api.query("begin"); expect(await bound(api)).toBeNull(); await api.query("rollback");
  });
  it("alternating users on one pooled connection: each transaction sees only its own identity, never the previous one", async () => {
    const seen: (string | null)[] = [];
    for (const t of [tokA, tokB, tokA, null, tokB, null]) seen.push(await tx(api, t, () => bound(api), true));
    expect(seen).toEqual([A, B, A, null, B, null]);
  });
  it("a bind inside a rolled-back SAVEPOINT leaves no identity behind; a bind before one survives it", async () => {
    await api.query("begin"); await api.query("savepoint s"); await api.query("select public.twins_bind_session($1)", [tokA]); await api.query("rollback to savepoint s");
    expect(await bound(api)).toBeNull();
    await api.query("select public.twins_bind_session($1)", [tokB]); await api.query("savepoint s2"); await api.query("rollback to savepoint s2"); expect(await bound(api)).toBe(B); await api.query("rollback");
  });
  it("two connections bound to different users at the same time never see each other's identity", async () => {
    await api.query("begin"); await api2.query("begin");
    await api.query("select public.twins_bind_session($1)", [tokA]); await api2.query("select public.twins_bind_session($1)", [tokB]);
    expect([await bound(api), await bound(api2)]).toEqual([A, B]);
    await api.query("rollback"); await api2.query("rollback");
  });
  it("a stale identity row cannot be matched by a later transaction (xid) or a restored copy (boot time), and old rows are purged", async () => {
    await tx(api, tokA, async () => undefined, true);
    await owner.query("insert into public.twins_txn_identity (xid, boot, user_id, via) values ('1'::xid8, now() - interval '9 days', $1, 'SESSION')", [B]);
    await tx(api, tokA, async () => expect(await bound(api)).toBe(A), true);
    expect((await owner.query("select count(*)::int as n from public.twins_txn_identity where boot < now() - interval '1 day'")).rows[0].n).toBe(0); // purged by the next bind
  });
});

describe("F5: the identity table cannot be forged by application code", () => {
  it("the API and system roles can neither write nor delete it, and cannot truncate it", async () => {
    for (const c of [api, sys]) {
      for (const q of ["insert into public.twins_txn_identity (xid, user_id, via) values (pg_current_xact_id(), '" + B + "', 'SESSION')", "update public.twins_txn_identity set user_id = '" + B + "'", "delete from public.twins_txn_identity", "truncate public.twins_txn_identity"]) {
        await c.query("begin"); const r = await err(c, q); await c.query("rollback"); expect(r.ok, q).toBe(false); expect(r.code, q).toBe("42501");
      }
    }
  });
  it("it cannot read other transactions' identities (row-level security limits it to the caller's own transaction)", async () => {
    await owner.query("begin"); await owner.query("select public.twins_bind_system_user($1::uuid)", [A]);
    await api.query("begin"); await api.query("select public.twins_bind_session($1)", [tokB]);
    expect((await api.query("select count(*)::int as n from public.twins_txn_identity")).rows[0].n).toBe(1);   // its own, not the owner's open transaction
    expect((await api.query("select user_id from public.twins_txn_identity")).rows[0].user_id).toBe(B);
    await api.query("rollback"); await owner.query("rollback");
  });
  it("the bind doors cannot be replaced or redefined by the runtime roles (not owner, no CREATE)", async () => {
    for (const c of [api, sys]) {
      const r = await err(c, "create or replace function public.twins_bound_user_id() returns uuid language sql as $$ select '" + B + "'::uuid $$"); expect(r.ok).toBe(false);
      const s = await err(c, "create schema evil"); expect(s.ok).toBe(false);
    }
  });
  it("a temp table or schema shadowing cannot redirect the reader (fixed search_path, schema-qualified)", async () => {
    await api.query("begin"); const t = await err(api, "create temp table twins_txn_identity (xid xid8, boot timestamptz, user_id uuid, via text, bound_by name, bound_at timestamptz)");
    if (t.ok) await api.query("insert into pg_temp.twins_txn_identity values (pg_current_xact_id(), pg_postmaster_start_time(), '" + B + "', 'SESSION', 'x', now())");
    expect(await bound(api)).toBeNull(); await api.query("rollback");
  });
});

describe("F5: separation of the API, system and owner identities", () => {
  it("the API role cannot execute the system door at all, nor name a user by any other route", async () => {
    await api.query("begin"); const r = await err(api, "select public.twins_bind_system_user($1::uuid)", [B]); await api.query("rollback");
    expect(r.ok).toBe(false); expect(r.code).toBe("42501"); expect(r.msg).toMatch(/permission denied for function twins_bind_system_user/);
    expect((await owner.query("select has_function_privilege($1, 'public.twins_bind_system_user(uuid)', 'EXECUTE') as a", [API])).rows[0].a).toBe(false);
  });
  it("the system role binds a named existing user (and only that user per transaction); it holds no session door; it never reaches PUBLIC", async () => {
    await sys.query("begin"); await sys.query("select public.twins_bind_system_user($1::uuid)", [A]); expect(await bound(sys)).toBe(A);
    const swap = await err(sys, "select public.twins_bind_system_user($1::uuid)", [B]); expect(swap.ok).toBe(false); await sys.query("rollback");
    const missing = randomUUID();                                                                                   // a user that does not exist cannot be bound
    await sys.query("begin"); const r = await err(sys, "select public.twins_bind_system_user($1::uuid)", [missing]); await sys.query("rollback"); expect(r.ok).toBe(false); expect(r.code).toBe("42501");
    const dormant = await mkUser(false);                                                                             // a DEACTIVATED user still exists: background wind-down (e.g. closing paper positions) must keep working, so the system door checks existence only
    await tx(sys, null, async () => undefined); await sys.query("begin"); await sys.query("select public.twins_bind_system_user($1::uuid)", [dormant]); expect(await bound(sys)).toBe(dormant); await sys.query("rollback");
    await sys.query("begin"); const s = await err(sys, "select public.twins_bind_session($1)", [tokA]); await sys.query("rollback"); expect(s.code).toBe("42501");
    const pub = await owner.query("select count(*)::int as n from pg_proc p where p.proname in ('twins_bind_session', 'twins_bind_system_user') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')");
    expect(pub.rows[0].n).toBe(0);
  });
  it("the system role keeps its intended permissions only: it sees the bound user's rows, none of another user's, and still cannot touch the protected controls or audit tables", async () => {
    await sys.query("begin"); await sys.query("select public.twins_bind_system_user($1::uuid)", [A]);
    expect((await sys.query("select count(*)::int as n from user_capital_profiles where user_id = $1", [B])).rows[0].n).toBe(0);
    for (const q of ["insert into risk_control_events (id, scope, scope_key, kind, action, reason, actor, actor_kind) values (gen_random_uuid(), 'MARKET', 'NSE', 'KILL_SWITCH', 'SET', 'system role platform control', 'x', 'OWNER')", "update audit_events set event_type = 'x'", "delete from system_controls", "update system_controls set updated_at = now()"]) {
      await sys.query("savepoint x"); const r = await err(sys, q); await sys.query("rollback to savepoint x"); expect(r.ok, q).toBe(false);
    }
    await sys.query("rollback");
  });
  it("owner / superuser operations stay explicitly separate: the owner needs no binding, bypasses nothing it is not entitled to by the allowlist, and the privilege self-check passes for each role", async () => {
    expect((await owner.query("select count(*)::int as n from user_capital_profiles")).rows[0].n).toBeGreaterThanOrEqual(1);     // owner (superuser) is outside RLS by design
    expect(await checkIdentityBinding(api, "api")).toEqual([]);
    expect(await checkIdentityBinding(sys, "system")).toEqual([]);
    expect(await checkIdentityBinding(api, "other")).toEqual([]);
  });
  it("the self-check reports each identity regression", async () => {
    expect(await checkIdentityBinding(api, "system")).toEqual(expect.arrayContaining(["system_cannot_bind_system"]));
    expect(await checkIdentityBinding(sys, "api")).toEqual(expect.arrayContaining(["api_can_bind_system", "api_cannot_bind_session"]));
    expect(await checkIdentityBinding(sys, "other")).toEqual(expect.arrayContaining(["other_can_bind_system"]));
    await owner.query(`grant execute on function public.twins_bind_system_user(uuid) to ${API}`);
    try { expect(await checkIdentityBinding(api, "api")).toEqual(["api_can_bind_system"]); } finally { await owner.query(`revoke execute on function public.twins_bind_system_user(uuid) from ${API}`); }
    await owner.query(`grant insert on public.twins_txn_identity to ${API}`);
    try { expect(await checkIdentityBinding(api, "api")).toEqual(["can_write:twins_txn_identity"]); } finally { await owner.query(`revoke insert on public.twins_txn_identity from ${API}`); }
    await owner.query("grant execute on function public.twins_bind_session(text) to public");
    try { expect(await checkIdentityBinding(api, "api")).toContain("public_can_bind"); } finally { await owner.query("revoke execute on function public.twins_bind_session(text) from public"); }
  });
});

describe("F5: the application path (withUser) under each real role", () => {
  const rowsOf = (r: unknown): Array<{ user_id: string; via: string }> => (r as { rows: Array<{ user_id: string; via: string }> }).rows;
  it("a worker/scheduler cycle (system role, no request credential) is bound by SYSTEM for exactly the user it names", async () => {
    const db = createDb(urlFor(SYS));
    const out = await withUser(db, A, async (tx) => rowsOf(await tx.execute(sql`select user_id, via from public.twins_txn_identity`)));
    expect(out).toEqual([{ user_id: A, via: "SYSTEM" }]);
  });
  it("the same call from the API role (no request credential) fails closed instead of naming a user", async () => {
    const db = createDb(urlFor(API));
    await expect(withUser(db, A, async () => "never")).rejects.toThrow(/twins_bind_system_user/);
  });
});

describe("F5: nothing in the schema still reads the settable setting", () => {
  it("no policy, function or default in public references twins.user_id", async () => {
    const r = await owner.query("select (select count(*)::int from pg_policies where schemaname = 'public' and (qual like '%twins.user_id%' or with_check like '%twins.user_id%')) as policies, (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and prosrc like '%twins.user_id%') as functions, (select count(*)::int from pg_policies where schemaname = 'public' and (qual like '%twins_bound_user_id%' or with_check like '%twins_bound_user_id%')) as bound_policies");
    expect(r.rows[0].policies).toBe(0); expect(r.rows[0].functions).toBe(0); expect(r.rows[0].bound_policies).toBeGreaterThanOrEqual(29);
  });
});
