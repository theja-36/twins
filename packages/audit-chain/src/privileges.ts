import { HEADS_TABLE, PROTECTED_TABLES } from "./specs";
import type { Queryable } from "./verify";

/** Tables no runtime role may write at all: their rows are created only by triggers running for the owner/admin path. */
const NO_WRITE_FOR_RUNTIME = ["system_controls", "system_control_events", HEADS_TABLE];
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

  const all = [...PROTECTED_TABLES, "system_controls", HEADS_TABLE];
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
