import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { buildJobLogContext } from "../../../services/worker/src/correlationLog";
import { processTelegramQueueJob } from "../../../services/worker/src/index";

const must = <T,>(v: T | undefined | null): T => { if (v === undefined || v === null) throw new Error("expected a value"); return v; };

const capture = () => {
  const records: LogRecord[] = [];
  return { records, logger: createStructuredLogger((r) => records.push(r)) };
};

// A job whose timestamp is malformed fails BEFORE any database use, so no DB is needed.
function badJob(id: string, correlationId: string | undefined, attemptsStarted: number) {
  return {
    id,
    attemptsStarted,
    attemptsMade: attemptsStarted - 1,
    opts: { attempts: 3 },
    data: {
      jobType: "telegram_messages",
      ...(correlationId ? { correlation: { correlationId, requestId: `req_for_${id}`, receivedAt: "2026-01-01T00:00:00.000Z" } } : {}),
      telegram: {
        params: { channelIdentifier: "tg_chat_-1" },
        normalizedMessage: { channelIdentifier: "tg_chat_-1", externalMessageId: id, rawText: "BUY CANARYTEXT @ 1", messageTimestamp: "not-a-date" },
        exchange: "NSE", instrumentType: "equity",
      },
    },
  } as never;
}
const noDb = new Proxy({}, { get: () => { throw new Error("db must not be touched"); } }) as never;

describe("worker correlation logging", () => {
  it("buildJobLogContext carries the job's correlation id, attempt and message identity", () => {
    const ctx = buildJobLogContext(badJob("m1", "corr_carried-0001", 2) as never);
    expect(ctx).toMatchObject({
      correlationId: "corr_carried-0001", correlationOrigin: "job", intakeRequestId: "req_for_m1",
      jobId: "m1", attempt: 2, maxAttempts: 3, channelIdentifier: "tg_chat_-1", externalMessageId: "m1",
    });
  });

  it("falls back to attemptsMade+1 when attemptsStarted is absent", () => {
    expect(buildJobLogContext({ id: "j", attemptsMade: 1, data: {} } as never)).toMatchObject({ attempt: 2 });
    expect(buildJobLogContext({ id: "j", data: {} } as never)).toMatchObject({ attempt: 1 });
  });

  it("failure is logged with the carried correlation id, attempt info and a safe code, and still maps to a permanent error", async () => {
    const { records, logger } = capture();
    const err = await processTelegramQueueJob(badJob("m1", "corr_carried-0001", 1), undefined, noDb, { logger }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(records.map((r) => r.event)).toEqual(["worker.job.started", "worker.job.failed"]);
    for (const r of records) expect(r).toMatchObject({ correlationId: "corr_carried-0001", attempt: 1, maxAttempts: 3, jobId: "m1" });
    expect(records[1]).toMatchObject({ errorCode: "INVALID_JOB_INPUT", retryable: false });
    expect(JSON.stringify(records)).not.toContain("CANARYTEXT");
    expect(JSON.stringify(records)).not.toContain("not-a-date");
  });

  it("a retry of the same job keeps the correlation id and reports the new attempt number", async () => {
    const { records, logger } = capture();
    for (const attempt of [1, 2, 3]) {
      await processTelegramQueueJob(badJob("m1", "corr_carried-0001", attempt), undefined, noDb, { logger }).catch(() => undefined);
    }
    const started = records.filter((r) => r.event === "worker.job.started");
    expect(started.map((r) => r["attempt"])).toEqual([1, 2, 3]);
    expect(new Set(started.map((r) => r["correlationId"]))).toEqual(new Set(["corr_carried-0001"]));
  });

  it("legacy job without metadata is still processed: worker generates and flags an id", async () => {
    const { records, logger } = capture();
    await processTelegramQueueJob(badJob("legacy1", undefined, 1), undefined, noDb, { logger }).catch(() => undefined);
    const started = must(records.find((r) => r.event === "worker.job.started"));
    expect(started["correlationOrigin"]).toBe("worker-generated");
    expect(started["correlationId"]).toMatch(/^corr_/);
    expect(must(records.find((r) => r.event === "worker.job.failed"))["correlationId"]).toBe(started["correlationId"]);
  });

  it("malformed metadata is treated like missing metadata, not a failure", () => {
    const ctx = buildJobLogContext({ id: "j", data: { correlation: { correlationId: "bad id!!" } } } as never);
    expect(ctx["correlationOrigin"]).toBe("worker-generated");
  });

  it("concurrent jobs never leak context into each other's log lines", async () => {
    const { records, logger } = capture();
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    await Promise.all(ids.map((id, i) => (i % 2 ? Promise.resolve() : Promise.resolve()).then(() =>
      processTelegramQueueJob(badJob(id, `corr_concurrent-${id}`, 1), undefined, noDb, { logger }).catch(() => undefined))));
    expect(records).toHaveLength(50);
    for (const r of records) {
      expect(r["correlationId"]).toBe(`corr_concurrent-${r["jobId"]}`);
      expect(r["externalMessageId"]).toBe(r["jobId"]);
    }
  });
});
