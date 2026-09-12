import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "@twins/config";
import * as schema from "./schema/index";

type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/**
 * Lazily-created singleton pool/db. PostgreSQL is the source of record
 * (spec section 47) - this is the only place a connection pool should be
 * constructed; every other package must go through `getDb()` rather than
 * opening its own connection. Nothing here runs at import time, so this
 * module stays safe to import from contexts without DATABASE_URL set
 * (e.g. drizzle-kit config resolution).
 */
export function getPool(): Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/** Creates an independent db handle against an explicit connection string (tests, scripts). */
export function createDb(connectionString: string): Db {
  return drizzle(new Pool({ connectionString }), { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
