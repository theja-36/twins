import pg from "pg";
import { pgStateSource } from "./pgSource";
import type { StateSource } from "./types";

export interface PooledStateSource {
  source: StateSource;
  close(): Promise<void>;
}

/**
 * A small dedicated pool for processes that have no database handle of their own (the scheduler). Lazy: no connection is opened until the
 * first read. The pool's `error` event (an idle client failing) is absorbed so it cannot crash the process; a failed READ still rejects
 * and therefore fails closed in the core. statement_timeout bounds the query on the server side as well.
 */
export function createPooledStateSource(connectionString: string): PooledStateSource {
  const pool = new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5000, statement_timeout: 3000, application_name: "twins-runtime-state" });
  pool.on("error", () => undefined);
  return { source: pgStateSource(pool), close: () => pool.end() };
}
