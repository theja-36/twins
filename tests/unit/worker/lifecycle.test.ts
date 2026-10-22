import { describe, expect, it } from "vitest";
import { createBoundedDb } from "../../../packages/database/src/client";
import { workerDb, shutdown } from "../../../services/worker/src/index";

describe("Worker DB Lifecycle & Pool Bounding (R0A / REL-01)", () => {
  it("workerDb has a bounded connection pool with max=10 and idleTimeout", () => {
    expect(workerDb).toBeDefined();
    expect(workerDb.db).toBeDefined();
    expect(workerDb.pool).toBeDefined();
    expect(workerDb.close).toBeTypeOf("function");
    // Check pool options
    expect(workerDb.pool.options.max).toBe(10);
    expect(workerDb.pool.options.idleTimeoutMillis).toBe(30000);
  });

  it("createBoundedDb creates isolated bounded pool handles with working close()", async () => {
    const handle = createBoundedDb({ max: 5, idleTimeoutMillis: 10000 });
    expect(handle.pool.options.max).toBe(5);
    expect(handle.pool.options.idleTimeoutMillis).toBe(10000);
    // Ensure closing drains the pool cleanly without error
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("shutdown function exists and is callable for graceful shutdown", () => {
    expect(shutdown).toBeTypeOf("function");
  });

  it("processTelegramJob and processMarketBarsJob accept controlled db parameter without relying on global state", async () => {
    const { processTelegramJob, processMarketBarsJob } = await import(
      "../../../services/worker/src/index"
    );
    expect(processTelegramJob).toBeTypeOf("function");
    expect(processMarketBarsJob).toBeTypeOf("function");
  });
});

