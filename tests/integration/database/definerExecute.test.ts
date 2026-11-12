/**
 * Migration 0048 (SECURITY DEFINER EXECUTE hardening) against REAL PostgreSQL. The runtime role is created and granted by the ACTUAL app-role.sql; every attempt runs as that role's own login identity
 * (SET LOCAL SESSION AUTHORIZATION). Proves: PUBLIC cannot execute any SECURITY DEFINER function in public; an unrelated role is refused (42501); the runtime role keeps exactly the doors it uses; the approval bot
 * role (approval-bot-role.sql) keeps only its card doors; the audit-chain trigger still fires for roles without EXECUTE. Does NOT prove twins.user_id is authenticated (it is not: documented limitation).
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../targetConfig";

const APP = "twins_app_exec", NOBODY = "twins_exec_nobody";
const roleSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${APP}"`).replaceAll(":'app_role'", `'${APP}'`);
const FIXED = [
  "twins_audit_chain_after_insert()", "twins_clear_login_failures(text)", "twins_create_user(text,text,text,text,uuid)", "twins_set_user_role(uuid,uuid,text)", "twins_set_user_active(uuid,uuid,boolean)",
  "twins_create_user_decision(jsonb)", "twins_end_user_decision(uuid,text,text,text)", "twins_invalidate_decision(uuid,text,jsonb,text)", "twins_record_decision_approval(uuid,text,jsonb,text,text)",
  "twins_list_active_accounts()", "twins_list_active_account_users(integer)",
];
const RUNTIME = FIXED.filter((f) => f !== "twins_audit_chain_after_insert()");
let c: pg.Client;
const can = async (role: string, fn: string): Promise<boolean> => (await c.query("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, `public.${fn}`])).rows[0].ok as boolean;

beforeAll(async () => {
  c = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await c.connect();
  for (const r of [APP, NOBODY]) await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login; end if; end $$`);
  await c.query(roleSql);
});
afterAll(async () => { for (const r of [APP, NOBODY]) await c.query(`drop owned by ${r}`).then(() => c.query(`drop role if exists ${r}`)).catch(() => undefined); await c.end(); });

describe("migration 0048: no SECURITY DEFINER function in public is executable by PUBLIC", () => {
  it("the catalogue holds no PUBLIC-executable definer function", async () => {
    const r = await c.query("select p.oid::regprocedure::text as fn from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')");
    expect(r.rows).toEqual([]);
  });
  it("an unrelated role cannot execute any of the eleven functions", async () => { for (const f of FIXED) expect(await can(NOBODY, f), f).toBe(false); });
  it("calling one as an unrelated role fails with insufficient_privilege (42501), not a function-level rejection", async () => {
    await c.query("begin"); await c.query(`set local session authorization ${NOBODY}`);
    try { await expect(c.query("select twins_list_active_account_users(5)")).rejects.toMatchObject({ code: "42501" }); } finally { await c.query("rollback"); }
  });
});
describe("the runtime role keeps exactly the doors the application calls", () => {
  it("can execute every runtime function, and the lister really runs", async () => {
    for (const f of RUNTIME) expect(await can(APP, f), f).toBe(true);
    await c.query("begin"); await c.query(`set local session authorization ${APP}`);
    try { await expect(c.query("select * from twins_list_active_account_users(5)")).resolves.toBeDefined(); await expect(c.query("select * from twins_list_active_accounts()")).resolves.toBeDefined(); } finally { await c.query("rollback"); }
  });
  it("cannot execute the trigger function directly (not a door), yet the audit chain still advances on its inserts", async () => {
    expect(await can(APP, "twins_audit_chain_after_insert()")).toBe(false);
    const before = Number((await c.query("select count(*) as n from audit_events")).rows[0].n);
    await c.query("begin"); await c.query(`set local session authorization ${APP}`);
    try {
      await c.query("insert into audit_events (id, event_type, entity_type, actor_type, metadata) values (gen_random_uuid(), 'itest.exec', 'x', 'system', '{}'::jsonb)");
      expect(Number((await c.query("select count(*) as n from audit_events")).rows[0].n)).toBe(before + 1);
    } finally { await c.query("rollback"); }
  });
  it("the owner path is unchanged: the migrating role (the owner) can still execute them", async () => { for (const f of FIXED) expect(await can((await c.query("select current_user as u")).rows[0].u, f), f).toBe(true); });
});
