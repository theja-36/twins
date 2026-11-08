/**
 * G-13, runtime-role half. Applies the ACTUAL infrastructure/staging/app-role.sql to PostgreSQL and proves what the runtime role can and cannot do to users, the decision and execution tables and the auth log.
 * (tests/integration/auth/stage01.test.ts proves the second layer, the trigger, using a deliberately over-granted role. This file proves the first layer, the real grants.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../targetConfig";

const ROLE = "twins_app_stage01";
const roleSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${ROLE}"`).replaceAll(":'app_role'", `'${ROLE}'`);
let c: pg.Client; let admin: string, trader: string, other: string;
const asApp = async <T>(fn: () => Promise<T>, userId?: string): Promise<T> => {
  await c.query("begin"); await c.query(`set local role ${ROLE}`); if (userId) await c.query("select set_config('twins.user_id', $1, true)", [userId]);
  try { return await fn(); } finally { await c.query("rollback"); }
};
const code = async (q: string, p: unknown[] = [], user?: string): Promise<string> => asApp(async () => { try { await c.query(q, p); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "error"; } }, user);
const mkUser = async (role: "ADMIN" | "TRADER"): Promise<string> => {
  const id = randomUUID(); await c.query("begin"); await c.query("select set_config('twins.privilege_door', 'open', true)");
  await c.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', $3, true)", [id, `${id}@example.com`, role]); await c.query("commit"); return id;
};

beforeAll(async () => {
  c = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await c.connect();
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} login; end if; end $$`);
  await c.query(roleSql);
  [admin, trader, other] = [await mkUser("ADMIN"), await mkUser("TRADER"), await mkUser("TRADER")];
});
afterAll(async () => { await c.end(); });

describe("the runtime role (app-role.sql applied for real)", () => {
  it("is not a superuser, does not bypass RLS and owns nothing", async () => {
    const r = await c.query("select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = $1", [ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });
  it("cannot change users.role or users.is_active directly (column privilege, SQLSTATE 42501)", async () => {
    expect(await code("update users set role = 'ADMIN' where id = $1", [trader])).toBe("42501");
    expect(await code("update users set is_active = false where id = $1", [other])).toBe("42501");
    expect(await code("update users set role = 'ADMIN', password_hash = 'x' where id = $1", [trader])).toBe("42501");
    expect(await code("update users set email = 'x@example.com' where id = $1", [trader])).toBe("42501");
  });
  it("cannot insert or delete users, and cannot update every row through a bulk statement", async () => {
    expect(await code("insert into users (id, email, password_hash, role) values (gen_random_uuid(), $1, 'x', 'ADMIN')", [`${randomUUID()}@example.com`])).toBe("42501");
    expect(await code("insert into users (id, email, password_hash) values (gen_random_uuid(), $1, 'x')", [`${randomUUID()}@example.com`])).toBe("42501");
    expect(await code("delete from users")).toBe("42501"); expect(await code("update users set role = 'TRADER'")).toBe("42501");
  });
  it("can still do its legitimate work on users: read, change a password hash or display name", async () => {
    expect(await code("select id, email, role from users where id = $1", [trader])).toBe("ok");
    expect(await code("update users set password_hash = 'y', display_name = 'n', updated_at = now() where id = $1", [trader])).toBe("ok");
  });
  it("the doors work from the runtime role only for the right actor", async () => {
    expect(await asApp(async () => (await c.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [trader, other])).rows[0].ok, trader)).toBe(false);   // a trader cannot
    expect(await asApp(async () => (await c.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [admin, other])).rows[0].ok, other)).toBe(false);   // the transaction user must be the actor
    expect(await asApp(async () => (await c.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [admin, admin])).rows[0].ok, admin)).toBe(false);   // never yourself
    expect(await asApp(async () => { const r = (await c.query("select twins_set_user_role($1::uuid, $2::uuid, 'ADMIN') as ok", [admin, other])).rows[0].ok; const role = (await c.query("select role from users where id = $1", [other])).rows[0].role; return [r, role]; }, admin)).toEqual([true, "ADMIN"]);
    expect((await c.query("select role from users where id = $1", [other])).rows[0].role).toBe("TRADER"); // that probe was rolled back
    expect(await code("select twins_create_user($1, 'x', null, 'ADMIN', null)", [`${randomUUID()}@example.com`])).toBe("42501"); // an administrator exists: no anonymous admin
  });
  it("cannot write the decision, order, fill or position tables directly, and cannot delete from the auth log", async () => {
    expect(await code("insert into user_decisions (id, user_id) values (gen_random_uuid(), $1)", [trader], trader)).toBe("42501");
    expect(await code("update user_decisions set workflow_state = 'APPROVED'", [], trader)).toBe("42501");
    for (const t of ["orders", "fills", "positions"]) expect(await code(`insert into ${t} default values`), t).toBe("42501");
    expect(await code("delete from auth_login_failures")).toBe("42501");
    expect(await code("insert into auth_login_failures (id, key_hash) values (gen_random_uuid(), 'k')")).toBe("ok");
    expect(await code("select twins_clear_login_failures('k')")).toBe("ok");
  });
  it("cannot read another user's private rows without the session binding (row-level security applies to the role)", async () => {
    expect(await asApp(async () => (await c.query("select count(*)::int as n from user_decisions")).rows[0].n)).toBe(0);
  });
});
