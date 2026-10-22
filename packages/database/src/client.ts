import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "@twins/config";
import * as schema from "./schema/index";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/**
 * Safe diagnostics for a pool-level error: a stable code and the error class name only. The error MESSAGE
 * and any payload are deliberately dropped (database errors can embed hostnames, credentials in connection
 * strings, or row values).
 */
export interface PoolErrorDiagnostic {
  pool: string;
  errorCode: string;
  errorName: string;
  /** Number of pool-level errors seen so far on this pool (monotonic). */
  errorCount: number;
}

/** Cumulative, read-only view of what the listener has seen. NOT a health signal (see attachPoolErrorHandler). */
export interface PoolErrorStats {
  errorCount: number;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
}

export type PoolErrorSink = (diagnostic: PoolErrorDiagnostic) => void;

const defaultPoolErrorSink: PoolErrorSink = (d) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "db.pool.error", ...d }));
};

function describePoolError(err: unknown): { errorCode: string; errorName: string } {
  const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : "";
  const name = typeof (err as { name?: unknown } | null)?.name === "string" ? (err as { name: string }).name : "";
  return {
    errorCode: /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : "UNEXPECTED_ERROR",
    errorName: /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) ? name : "Error",
  };
}

/**
 * Attaches the process-owned error listener to a pool, exactly once per pool.
 *
 * Why: node-postgres emits `error` on the POOL when an IDLE client fails (server restart/failover, network
 * reset). An EventEmitter `error` with no listener throws, which would terminate the process. This listener
 * only records safe diagnostics (code + class name, never the message) and never throws.
 *
 * What it deliberately does NOT do: it does not swallow or alter failed queries (those still reject in their
 * callers), it does not mark anything healthy or unhealthy (the stats are diagnostics, not a readiness signal),
 * and it does not create, replace or end the pool. Recovery policy supported: the failed idle client is
 * discarded by `pg`, the same pool keeps serving, and the next checkout opens a fresh connection; if the
 * database is still down that checkout/query fails and the caller sees the error. There is no circuit
 * breaker, no automatic pool rebuild and no process exit; restarting the process remains the orchestrator's
 * decision. Errors on a CHECKED-OUT client surface through that query, not through this listener.
 */
export function attachPoolErrorHandler(target: Pool, label: string, sink: PoolErrorSink = defaultPoolErrorSink): PoolErrorStats {
  const stats: PoolErrorStats = { errorCount: 0, lastErrorAt: null, lastErrorCode: null };
  target.on("error", (err: unknown) => {
    try {
      const safe = describePoolError(err);
      stats.errorCount += 1;
      stats.lastErrorAt = new Date();
      stats.lastErrorCode = safe.errorCode;
      sink({ pool: label, ...safe, errorCount: stats.errorCount });
    } catch {
      // A listener must never throw (it would be an uncaught exception on the emitter).
    }
  });
  return stats;
}

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
    attachPoolErrorHandler(pool, "shared");
  }
  return pool;
}

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/** Creates an independent db handle against an explicit connection string or pool (tests, scripts). */
export function createDb(connectionStringOrPool: string | Pool, poolConfig?: PoolConfig): Db {
  let p: Pool;
  if (typeof connectionStringOrPool === "string") {
    p = new Pool({ connectionString: connectionStringOrPool, ...poolConfig });
    attachPoolErrorHandler(p, "createDb");
  } else {
    p = connectionStringOrPool;
    // A pool supplied by the caller is owned by the caller; only add the safety listener if it has none.
    if (p.listenerCount("error") === 0) attachPoolErrorHandler(p, "supplied");
  }
  return drizzle(p, { schema });
}

export interface BoundedDbHandle {
  db: Db;
  pool: Pool;
  close: () => Promise<void>;
  /** Cumulative pool-level error diagnostics (not a health/readiness signal). */
  poolErrors: PoolErrorStats;
}

/**
 * Creates a bounded, process-owned database handle with explicit pool configuration
 * and a dedicated close() method for clean lifecycle management and graceful shutdown.
 */
export function createBoundedDb(
  connectionStringOrConfig?: string | PoolConfig,
  poolConfig?: PoolConfig,
  onPoolError?: PoolErrorSink,
): BoundedDbHandle {
  const config = loadConfig();
  let poolOptions: PoolConfig;

  if (typeof connectionStringOrConfig === "string") {
    poolOptions = { connectionString: connectionStringOrConfig, ...poolConfig };
  } else if (connectionStringOrConfig && typeof connectionStringOrConfig === "object") {
    poolOptions = { connectionString: config.databaseUrl, ...connectionStringOrConfig };
  } else {
    poolOptions = { connectionString: config.databaseUrl, ...poolConfig };
  }

  // Set safe bounded defaults if not explicitly specified
  if (poolOptions.max === undefined) {
    poolOptions.max = 10;
  }
  if (poolOptions.idleTimeoutMillis === undefined) {
    poolOptions.idleTimeoutMillis = 30000;
  }

  const p = new Pool(poolOptions);
  const poolErrors = attachPoolErrorHandler(p, "bounded", onPoolError);
  const d = drizzle(p, { schema });

  return {
    db: d,
    pool: p,
    close: async () => {
      await p.end();
    },
    poolErrors,
  };
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
