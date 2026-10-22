/**
 * T1: pool-level error handling. These tests EMIT synthetic `error` events on real (unconnected or
 * unreachable) pg pools. They prove the listener's contract (no throw, safe diagnostics, no pool replacement,
 * queries still fail). They are NOT a PostgreSQL outage drill and prove nothing about real server restarts.
 */
import { EventEmitter } from "node:events";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  attachPoolErrorHandler,
  createBoundedDb,
  createDb,
  type PoolErrorDiagnostic,
} from "../../../packages/database/src/index";

const CANARY = "CANARYPOOL-4471";
const dirty = (code?: string) =>
  Object.assign(new Error(`terminating connection: password=${CANARY} host=db.internal.example row=(${CANARY})`), code ? { code } : {});

describe("why a listener is needed (baseline)", () => {
  it("an EventEmitter 'error' without a listener throws - the process-crash path the handler closes", () => {
    expect(() => new EventEmitter().emit("error", new Error("idle client failed"))).toThrow();
    const pool = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    expect(() => pool.emit("error", new Error("idle client failed"))).toThrow();
    return pool.end();
  });
});

describe("attachPoolErrorHandler", () => {
  it("records only a safe code + class name (never the message), counts errors, and does not throw", async () => {
    const pool = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    const seen: PoolErrorDiagnostic[] = [];
    const stats = attachPoolErrorHandler(pool, "unit", (d) => seen.push(d));
    expect(() => pool.emit("error", dirty("57P01"))).not.toThrow(); // admin_shutdown
    expect(() => pool.emit("error", dirty("not a valid code with spaces and way too long to be one"))).not.toThrow();
    expect(() => pool.emit("error", "just a string")).not.toThrow();
    expect(seen.map((d) => d.errorCode)).toEqual(["57P01", "UNEXPECTED_ERROR", "UNEXPECTED_ERROR"]);
    expect(seen.map((d) => d.errorCount)).toEqual([1, 2, 3]);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["errorCode", "errorCount", "errorName", "pool"]);
    expect(JSON.stringify(seen)).not.toContain(CANARY);
    expect(JSON.stringify(seen)).not.toMatch(/password|host=|db\.internal/);
    expect(stats).toMatchObject({ errorCount: 3, lastErrorCode: "UNEXPECTED_ERROR" });
    expect(stats.lastErrorAt).toBeInstanceOf(Date);
    await pool.end();
  });

  it("never throws even if the sink itself throws", async () => {
    const pool = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    attachPoolErrorHandler(pool, "unit", () => { throw new Error("sink blew up"); });
    expect(() => pool.emit("error", dirty("08006"))).not.toThrow();
    await pool.end();
  });

  it("the default sink writes one JSON line without the message", async () => {
    const pool = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: unknown) => { lines.push(String(l)); };
    try {
      attachPoolErrorHandler(pool, "default-sink");
      pool.emit("error", dirty("57P01"));
    } finally { console.error = orig; }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "error", event: "db.pool.error", pool: "default-sink", errorCode: "57P01", errorCount: 1 });
    expect(lines[0]).not.toContain(CANARY);
    await pool.end();
  });
});

describe("ownership and non-masking behaviour", () => {
  it("createBoundedDb attaches the listener to ITS pool once; errors do not replace the pool; close() still ends it", async () => {
    const seen: PoolErrorDiagnostic[] = [];
    const handle = createBoundedDb("postgresql://x:x@127.0.0.1:1/x", { max: 2 }, (d) => seen.push(d));
    const same = handle.pool;
    expect(handle.pool.listenerCount("error")).toBe(1);
    handle.pool.emit("error", dirty("57P01"));
    handle.pool.emit("error", dirty("57P01"));
    expect(handle.pool).toBe(same); // no fresh pool per error
    expect(handle.pool.listenerCount("error")).toBe(1); // no listener pile-up
    expect(handle.poolErrors.errorCount).toBe(2);
    expect(seen).toHaveLength(2);
    await handle.close(); // explicit ownership/cleanup preserved
    expect(handle.pool.ended).toBe(true);
  });

  it("logging an error does not hide failed queries or mark anything healthy: queries still reject", async () => {
    const handle = createBoundedDb("postgresql://x:x@127.0.0.1:1/x", { max: 1, connectionTimeoutMillis: 500 }, () => undefined);
    await expect(handle.pool.query("select 1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    handle.pool.emit("error", dirty("57P01"));
    await expect(handle.pool.query("select 1")).rejects.toMatchObject({ code: "ECONNREFUSED" }); // still failing after the event
    expect(handle.poolErrors.errorCount).toBe(1); // the failed QUERIES are not counted as pool errors: they surface to their callers
    await handle.close();
  });

  it("createDb(string) gets a listener; a caller-supplied pool keeps its own listener (no duplicate)", async () => {
    const owned = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    let calls = 0;
    owned.on("error", () => { calls += 1; });
    createDb(owned);
    expect(owned.listenerCount("error")).toBe(1);
    owned.emit("error", dirty());
    expect(calls).toBe(1);
    await owned.end();

    const bare = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x" });
    createDb(bare);
    expect(bare.listenerCount("error")).toBe(1); // safety listener added to an unprotected supplied pool
    await bare.end();
  });
});
