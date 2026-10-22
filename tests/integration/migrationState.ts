/**
 * Compares a target database's recorded migrations with the repository's journal, using drizzle's own
 * convention: each applied migration is recorded with created_at = journal `when` and
 * hash = sha256(SQL file text). Read-only; never migrates or repairs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExpectedMigration { tag: string; when: number; hash: string }
export interface RecordedMigration { hash: string; created_at: string | number }

// import.meta.url (not __dirname) so this also works when imported from an ESM script (scripts/options-demo.ts).
const DRIZZLE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../packages/database/drizzle");

export function loadExpectedMigrations(dir: string = DRIZZLE_DIR): ExpectedMigration[] {
  const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  return journal.entries.map((e) => ({
    tag: e.tag,
    when: e.when,
    hash: createHash("sha256").update(readFileSync(resolve(dir, `${e.tag}.sql`), "utf8")).digest("hex"),
  }));
}

/** Returns a single diagnostic string when the target is not exactly at the expected chain, otherwise null. */
export function describeMigrationMismatch(expected: ExpectedMigration[], recorded: RecordedMigration[]): string | null {
  if (recorded.length > expected.length) return `target has ${recorded.length} recorded migrations but the repository has ${expected.length} (ahead or foreign history)`;
  for (const [i, rec] of recorded.entries()) {
    const want = expected[i];
    if (!want) break;
    if (rec.hash !== want.hash) return `migration ${want.tag} is recorded with different content than the repository (incompatible history)`;
    if (recorded.length === expected.length && Number(rec.created_at) !== want.when) return `migration ${want.tag} is recorded with a different journal timestamp than the repository`;
  }
  if (recorded.length < expected.length) {
    return `target is behind: ${recorded.length} of ${expected.length} migrations applied; missing ${expected.slice(recorded.length).map((m) => m.tag).join(", ")}`;
  }
  return null;
}
