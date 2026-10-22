import { requireTestDatabaseUrl } from "../targetConfig";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "../../../packages/database/src/index";
import { runIngestionJob } from "../../../packages/ingestion/src/jobs";
import { ProviderDataError, ProviderUnavailableError } from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

const noSleep = async () => {};

describe("runIngestionJob (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("records a succeeded job and a healthy provider_health row", async () => {
    const outcome = await runIngestionJob(db, {
      jobType: "market_bars",
      queueName: "market_queue",
      providerName: "fixture-market-success",
      providerType: "market",
      execute: async () => ({ fetched: 1, inserted: 1 }),
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.attempts).toBe(1);

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, outcome.jobId));
    expect(job?.status).toBe("succeeded");

    const [health] = await db
      .select()
      .from(schema.providerHealth)
      .where(eq(schema.providerHealth.providerName, "fixture-market-success"));
    expect(health?.status).toBe("healthy");
  });

  it("retries a transient provider-timeout error up to maxAttempts, then fails and records provider_health as down", async () => {
    let calls = 0;
    const outcome = await runIngestionJob(db, {
      jobType: "market_bars",
      queueName: "market_queue",
      providerName: "fixture-market-timeout",
      providerType: "market",
      maxAttempts: 3,
      sleep: noSleep,
      execute: async () => {
        calls += 1;
        throw new ProviderUnavailableError("fixture-market-timeout", "request timed out");
      },
    });

    expect(calls).toBe(3);
    expect(outcome.status).toBe("failed");
    expect(outcome.attempts).toBe(3);

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, outcome.jobId));
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("timed out");

    const [health] = await db
      .select()
      .from(schema.providerHealth)
      .where(eq(schema.providerHealth.providerName, "fixture-market-timeout"));
    expect(health?.status).toBe("down");
    expect(health?.lastErrorMessage).toContain("timed out");
  });

  it("does not retry a non-transient provider data error (fails after a single attempt)", async () => {
    let calls = 0;
    const outcome = await runIngestionJob(db, {
      jobType: "market_bars",
      queueName: "market_queue",
      providerName: "fixture-market-malformed",
      providerType: "market",
      maxAttempts: 3,
      sleep: noSleep,
      execute: async () => {
        calls += 1;
        throw new ProviderDataError("fixture-market-malformed", "response failed schema validation");
      },
    });

    expect(calls).toBe(1);
    expect(outcome.status).toBe("failed");
  });

  it("never turns a failed provider request into an empty successful result", async () => {
    const outcome = await runIngestionJob(db, {
      jobType: "market_bars",
      queueName: "market_queue",
      providerName: "fixture-market-error",
      providerType: "market",
      maxAttempts: 1,
      sleep: noSleep,
      execute: async () => {
        throw new Error("unexpected provider crash");
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toBeUndefined();
  });

  it("is safe to run the same job twice (each run is independently recorded, no shared mutable state)", async () => {
    const run = () =>
      runIngestionJob(db, {
        jobType: "market_bars",
        queueName: "market_queue",
        providerName: "fixture-market-repeat",
        providerType: "market",
        execute: async () => ({ fetched: 1, inserted: 1 }),
      });

    const [first, second] = await Promise.all([run(), run()]);
    expect(first.jobId).not.toBe(second.jobId);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
  });
});
