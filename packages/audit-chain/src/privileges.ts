import { HEADS_TABLE, PROTECTED_TABLES } from "./specs";
import type { Queryable } from "./verify";

/** Tables no runtime role may write at all: their rows are created only by triggers running for the owner/admin path. */
const NO_WRITE_FOR_RUNTIME = ["system_controls", "system_control_events", HEADS_TABLE, "risk_control_events"];
/** Protected audit tables the runtime role must be able to APPEND to but never modify. */
const APPEND_FOR_RUNTIME = ["audit_events", "signal_validations", "telegram_messages", "options_claims", "stop_loss_validations"];

export class AuditRoleSeparationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`audit role separation violated: ${problems.slice(0, 3).join(", ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
    this.name = "AuditRoleSeparationError";
  }
}

/**
 * Privilege self-check for a RUNTIME role (the api / worker / scheduler connection). Returns stable problem codes (empty = as designed):
 *  - the role must not be a superuser or have CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS;
 *  - it must not own any protected table (owners can ALTER ... DISABLE TRIGGER) and must not be able to CREATE in schema public;
 *  - on every protected audit table it may SELECT and INSERT but never UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER;
 *  - it may not write system_controls, system_control_events or audit_chain_heads in any way.
 * The approval bot has its own, stricter check (services/approval-bot/src/db.ts).
 */
export async function checkRuntimeRolePrivileges(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const role = (await db.query("select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = current_user")).rows[0];
  if (!role) return ["role_not_found"];
  for (const k of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"]) if (role[k] === true) problems.push(`role_is:${k}`);
  if ((await db.query("select has_schema_privilege('public', 'CREATE') as c")).rows[0]?.["c"] === true) problems.push("can_create_in_schema_public");

  const all = [...PROTECTED_TABLES, "system_controls", HEADS_TABLE, "risk_control_events"];
  for (const table of all) {
    const r = (
      await db.query(
        `select pg_get_userbyid(c.relowner) = current_user as owner,
                has_table_privilege(c.oid, 'SELECT') as sel, has_table_privilege(c.oid, 'INSERT') as ins,
                has_any_column_privilege(c.oid, 'UPDATE') as upd, has_table_privilege(c.oid, 'DELETE') as del,
                has_table_privilege(c.oid, 'TRUNCATE') as trunc, has_table_privilege(c.oid, 'REFERENCES') as refs, has_table_privilege(c.oid, 'TRIGGER') as trg
           from pg_class c where c.oid = to_regclass($1)`,
        [`public.${table}`],
      )
    ).rows[0];
    if (!r) {
      problems.push(`table_missing:${table}`);
      continue;
    }
    if (r["owner"] === true) problems.push(`owns:${table}`);
    for (const [flag, name] of [["upd", "UPDATE"], ["del", "DELETE"], ["trunc", "TRUNCATE"], ["refs", "REFERENCES"], ["trg", "TRIGGER"]] as const) if (r[flag] === true) problems.push(`can_${name.toLowerCase()}:${table}`);
    if (NO_WRITE_FOR_RUNTIME.includes(table) && r["ins"] === true) problems.push(`can_insert:${table}`);
    if (APPEND_FOR_RUNTIME.includes(table) && (r["ins"] !== true || r["sel"] !== true)) problems.push(`cannot_append:${table}`);
  }
  problems.push(...(await checkRiskControlProtection(db)));
  return problems;
}

const WRITER_ROLE = "twins_control_writer";
const RISK_DOOR = "public.twins_set_user_halt(text, text, timestamptz)";
const RISK_TRIGGERS = ["risk_control_events_guard", "risk_control_events_no_update_delete", "risk_control_events_no_truncate"];
/**
 * Risk-control protection (migration 0047), checked from the RUNTIME role's own connection. Stable problem codes (empty = as designed):
 *  - risk_control_events: row-level security enabled AND forced, a policy present, the three triggers present and ENABLE ALWAYS, the runtime role neither owner nor a member of the owner role (checked above: no INSERT/UPDATE/DELETE/TRUNCATE);
 *  - the door twins_set_user_halt exists, is SECURITY DEFINER, is owned by twins_control_writer, has a fixed search_path, is executable by the runtime role and NOT by PUBLIC;
 *  - twins_control_writer: NOLOGIN, not superuser / createrole / createdb / replication / bypassrls, owns exactly one function and no relation, has no CREATE on public, and the runtime role is not a member;
 *  - twins_control_privileged_roles (the owner allowlist): the runtime role has no privilege on it at all.
 * It does NOT prove that twins.user_id is authenticated: it is a trusted session setting (documented limitation).
 */
export async function checkRiskControlProtection(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const one = async (text: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> => (await db.query(text, params)).rows[0] as Record<string, unknown> | undefined;
  const tbl = await one("select c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies, pg_get_userbyid(c.relowner) as owner from pg_class c where c.oid = to_regclass('public.risk_control_events')");
  if (!tbl) return ["table_missing:risk_control_events"];
  if (tbl["rls"] !== true) problems.push("rls_not_enabled:risk_control_events");
  if (tbl["forced"] !== true) problems.push("rls_not_forced:risk_control_events");
  if (Number(tbl["policies"]) < 1) problems.push("policy_missing:risk_control_events");
  const triggers = (await db.query("select tgname, tgenabled::text as enabled from pg_trigger where tgrelid = to_regclass('public.risk_control_events') and not tgisinternal")).rows as Array<{ tgname: string; enabled: string }>;
  for (const name of RISK_TRIGGERS) {
    const row = triggers.find((t) => t.tgname === name);
    if (!row) problems.push(`trigger_missing:${name}`);
    else if (row.enabled !== "A") problems.push(`trigger_not_always:${name}`);
  }
  const member = await one("select pg_has_role(current_user, $1::name, 'member') as m, current_user::text = $1::text as same", [String(tbl["owner"])]);
  if (member && member["m"] === true && member["same"] !== true) problems.push("member_of_table_owner:risk_control_events");
  const fn = await one("select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.proconfig as cfg, has_function_privilege(current_user, p.oid, 'EXECUTE') as can_exec, exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec from pg_proc p where p.oid = to_regprocedure($1)", [RISK_DOOR]);
  if (!fn) problems.push("function_missing:twins_set_user_halt");
  else {
    if (fn["definer"] !== true) problems.push("function_not_definer:twins_set_user_halt");
    if (fn["owner"] !== WRITER_ROLE) problems.push("function_wrong_owner:twins_set_user_halt");
    if (!Array.isArray(fn["cfg"]) || !(fn["cfg"] as string[]).some((c) => /^search_path=pg_catalog, pg_temp$/.test(c))) problems.push("function_search_path_not_fixed:twins_set_user_halt");
    if (fn["can_exec"] !== true) problems.push("cannot_execute:twins_set_user_halt");
    if (fn["public_exec"] === true) problems.push("public_can_execute:twins_set_user_halt");
  }
  const w = await one("select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolcanlogin, (select count(*) from pg_proc where proowner = r.oid)::int as procs, (select count(*) from pg_class where relowner = r.oid)::int as rels, has_schema_privilege(r.oid, 'public', 'CREATE') as can_create, pg_has_role(current_user, r.oid, 'member') as runtime_member from pg_roles r where r.rolname = $1", [WRITER_ROLE]);
  if (!w) problems.push("writer_role_missing");
  else {
    for (const [k, code] of [["rolsuper", "rolsuper"], ["rolcreaterole", "rolcreaterole"], ["rolcreatedb", "rolcreatedb"], ["rolreplication", "rolreplication"], ["rolbypassrls", "rolbypassrls"], ["rolcanlogin", "rolcanlogin"]] as const) if (w[k] === true) problems.push(`writer_role_is:${code}`);
    if (Number(w["procs"]) !== 1) problems.push("writer_role_owns_unexpected_functions");
    if (Number(w["rels"]) !== 0) problems.push("writer_role_owns_relations");
    if (w["can_create"] === true) problems.push("writer_role_can_create_in_public");
    if (w["runtime_member"] === true) problems.push("runtime_is_member_of_writer_role");
  }
  const al = await one("select has_table_privilege(current_user, 'public.twins_control_privileged_roles', 'SELECT') as s, has_table_privilege(current_user, 'public.twins_control_privileged_roles', 'INSERT') as i, has_table_privilege(current_user, 'public.twins_control_privileged_roles', 'UPDATE') as u, has_table_privilege(current_user, 'public.twins_control_privileged_roles', 'DELETE') as d");
  if (al && (al["s"] === true || al["i"] === true || al["u"] === true || al["d"] === true)) problems.push("can_access:twins_control_privileged_roles");
  return problems;
}

export async function assertRuntimeRoleSeparation(db: Queryable): Promise<void> {
  const problems = await checkRuntimeRolePrivileges(db);
  if (problems.length > 0) throw new AuditRoleSeparationError(problems);
}

export const ROLE_SEPARATION_EXIT_CODE = 82;

/**
 * Process-start form for staging/production runtime services: refuses to start (one content-free JSON line on stderr, exit 82) when the
 * database role in use could modify protected audit tables. Skipped by callers in APP_ENV=development, where the local owner role is expected.
 * An unreadable database also refuses: a runtime service that cannot prove its privileges does not run.
 */
export async function enforceRuntimeRoleSeparation(
  processName: string,
  db: Queryable,
  options: { exit?: (code: number) => never; write?: (line: string) => void } = {},
): Promise<void> {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let problems: string[];
  try {
    problems = await checkRuntimeRolePrivileges(db);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    problems = [`check_failed:${typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : "error"}`];
  }
  if (problems.length === 0) return;
  write(`${JSON.stringify({ level: "fatal", event: "audit.role_separation.refused", process: processName, problems: problems.slice(0, 10), count: problems.length })}\n`);
  exit(ROLE_SEPARATION_EXIT_CODE);
}
