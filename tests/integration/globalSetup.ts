/**
 * Runs once before the integration suite (vitest.integration.config.ts). Fails the whole run, before any
 * test writes data, when the target is not an explicitly configured, approved one at the expected
 * migration state. Read-only: one SELECT on drizzle.__drizzle_migrations. Never migrates or repairs.
 *
 * Runs that select only the pure guard/config test files (no database access) skip this check,
 * so they need no environment and no connection.
 */
import pg from "pg";
import { describeMigrationMismatch, loadExpectedMigrations } from "./migrationState";
import { resolveTestTarget } from "./targetConfig";

const NO_DATABASE_FILES = ["envGuard", "ciGuard"];

function selectedOnlyNoDatabaseFiles(argv: string[]): boolean {
  const valueFlags = new Set(["--config", "-c", "--reporter", "--outputFile", "--root", "-r"]);
  const filters: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "run" || a === "watch") continue;
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    filters.push(a);
  }
  return filters.length > 0 && filters.every((f) => NO_DATABASE_FILES.some((n) => f.includes(n)));
}

export default async function setup(): Promise<void> {
  if (selectedOnlyNoDatabaseFiles(process.argv)) return;
  const { context, database } = resolveTestTarget(process.env);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`integration test target refused: cannot connect to the ${context} database (${(e as { code?: string }).code ?? "connection error"})`);
  }
  try {
    const exists = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as ok");
    const expected = loadExpectedMigrations();
    let mismatch: string | null;
    if (!exists.rows[0]?.ok) {
      mismatch = `target has no migration history; expected ${expected.length} migrations applied`;
    } else {
      const { rows } = await client.query("select hash, created_at from drizzle.__drizzle_migrations order by id");
      mismatch = describeMigrationMismatch(expected, rows);
    }
    if (mismatch) throw new Error(`integration test target refused: schema incompatible in ${context} database '${database}': ${mismatch}. Migrations are not applied automatically.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
