// Applies the drizzle migrations found in a given folder to DATABASE_URL (rehearsal helper).
// Usage: DATABASE_URL=... node docs/implementation/rehearsal/migrate-folder.mjs <migrationsFolder>
// Refuses to run unless DATABASE_URL is the loopback test Postgres (127.0.0.1:15432) AND the database is one of the exact
// approved rehearsal databases below (kept in sync with tests/integration/runtime/rehearsalTargets.ts by a unit test).
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const url = process.env.DATABASE_URL;
const folder = process.argv[2];
if (!url || !folder) throw new Error("DATABASE_URL and <migrationsFolder> are required");
const APPROVED = ["twins_rehearsal_fresh", "twins_rehearsal_upgrade", "twins_rehearsal_f2_upgrade", "twins_rehearsal_f2_fresh"];
const u = new URL(url);
if (`${u.hostname}:${u.port}` !== "127.0.0.1:15432") throw new Error("Refusing: not the loopback test Postgres 127.0.0.1:15432");
if (!APPROVED.includes(u.pathname.replace(/^\//, ""))) throw new Error(`Refusing: ${u.pathname} is not an approved rehearsal database`);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: folder });
  console.log(`[rehearsal] migrations from ${folder} applied to ${new URL(url).pathname}`);
} finally {
  await pool.end();
}
