/**
 * End-to-end correlation LOGGING across the real path (HTTP webhook -> BullMQ/Redis -> worker -> PostgreSQL).
 * Not distributed tracing. Log capture is controlled (injected sink); nothing here asserts console formatting.
 * Uses unique test-owned queues, synthetic data and the CI-guarded test databases only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { normalizeRawUpdate } from "../../../adapters/telegram/src/index";
import { schema } from "../../../packages/database/src/index";
import {
  TEST_API_KEY,
  TEST_WEBHOOK_SECRET,
  createHarness,
  failFirstInserts,
  must,
  telegramWebhookPayload,
  uniqueChatId,
  waitFor,
  webhookHeaders,
  type Harness,
} from "./harness";

const harnesses: Harness[] = [];
async function start(opts: Parameters<typeof createHarness>[0] = {}) {
  const records: LogRecord[] = [];
  const logger = createStructuredLogger((r) => records.push(r));
  const h = await createHarness({ ...opts, logger });
  harnesses.push(h);
  return { h, records };
}
afterAll(async () => {
  const errs: string[] = [];
  for (const h of harnesses) {
    try { await h.close(); } catch (e) { errs.push(e instanceof Error ? e.message : String(e)); }
  }
  if (errs.length) throw new Error(errs.join(" | "));
});

const rand = () => Math.floor(Math.random() * 1_000_000_000);
/** Durable-intake messages: wait for the outbox row; returns the pipeline job id the worker logs under (`outbox-<row id>`). */
const completed = async (h: Harness, chatId: number, messageId: number): Promise<string> => {
  await h.waitCompleted(`tg_chat_${chatId}`, String(messageId));
  return `outbox-${must(await h.outboxRow(`tg_chat_${chatId}`, String(messageId))).id}`;
};
/** A legacy job queued straight into Redis (no outbox row): wait for the BullMQ state. */
const completedJob = (h: Harness, jobId: string) =>
  waitFor(async () => ((await (await h.queue.getJob(jobId))?.getState()) === "completed" ? true : undefined), 20_000, `job ${jobId} to complete`);
const byEvent = (records: LogRecord[], event: string) => records.filter((r) => r.event === event);

async function post(h: Harness, chatId: number, messageId: number, extraHeaders: Record<string, string> = {}, user = `corr_${rand()}`) {
  return h.app.inject({
    method: "POST", url: "/webhooks/telegram",
    headers: { ...webhookHeaders, ...extraHeaders },
    payload: telegramWebhookPayload(rand(), messageId, user, chatId),
  });
}

describe("end-to-end correlation logging (real Redis + PostgreSQL)", () => {
  it("one request is followed through intake -> queue -> worker -> outcome with the same correlation id; record ids match the database; no sensitive data is logged", async () => {
    const { h, records } = await start();
    const chatId = uniqueChatId(); const messageId = rand();
    const res = await post(h, chatId, messageId, { "x-correlation-id": "it-correlation-0001", authorization: `Bearer ${TEST_API_KEY}` });
    expect(res.statusCode).toBe(202);
    const jobId = await completed(h, chatId, messageId);

    const mine = records.filter((r) => r["correlationId"] === "it-correlation-0001");
    // Order is guaranteed WITHIN a process, not across processes: the worker may start the job
    // before the API has finished its post-enqueue duplicate lookup and logged the enqueue result.
    expect(mine.filter((r) => r.event.startsWith("webhook.")).map((r) => r.event)).toEqual(["webhook.intake.accepted", "webhook.enqueue.succeeded"]);
    expect(mine.filter((r) => r.event.startsWith("outbox.")).map((r) => r.event).sort()).toEqual(["outbox.accepted", "outbox.claimed", "outbox.completed", "outbox.enqueued"]);
    expect(mine.filter((r) => r.event.startsWith("worker.")).map((r) => r.event)).toEqual([
      "worker.job.started", "worker.message.ingested", "worker.revision.state", "worker.signal.resolved",
      "worker.market_context.refreshed", "worker.validation.recorded", "worker.job.completed",
    ]);
    const accepted = must(mine.find((r) => r.event === "webhook.intake.accepted"));
    for (const r of mine.filter((x) => x.event.startsWith("worker."))) {
      expect(r).toMatchObject({ jobId, attempt: 1, maxAttempts: 8, correlationOrigin: "job", intakeRequestId: accepted["requestId"] });
    }
    // identifiers reported by the worker match the persisted records
    const done = must(mine.find((r) => r.event === "worker.job.completed"));
    const [msg] = await h.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.externalMessageId, String(messageId)));
    const [sig] = await h.db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, must(msg).id));
    const [val] = await h.db.select().from(schema.signalValidations).where(eq(schema.signalValidations.signalId, must(sig).id));
    expect(done).toMatchObject({ outcome: "validation_created", signalId: must(sig).id, validationId: must(val).id });
    expect(val?.idempotencyKey).toBe(`telegram-ingest:${must(sig).id}`);

    // sensitive-data exclusion across EVERY record
    const all = JSON.stringify(records);
    for (const secret of [TEST_WEBHOOK_SECRET, TEST_API_KEY, "Bearer", "BUY RELIANCE @ 2800", "SL 2750"]) expect(all).not.toContain(secret);
  }, 60_000);

  it("a retry keeps the job's correlation id and identifies each attempt; the failed attempt carries a safe code only", async () => {
    const { h, records } = await start({ workerDb: (db) => failFirstInserts(db, "telegram_messages") });
    const chatId = uniqueChatId(); const messageId = rand();
    await post(h, chatId, messageId);
    const jobId = await completed(h, chatId, messageId);
    const forJob = records.filter((r) => r["jobId"] === jobId);
    const retryScheduled = byEvent(records, "outbox.retry_scheduled");
    expect(retryScheduled).toHaveLength(1);
    expect(retryScheduled[0]).toMatchObject({ attempt: 1, errorCode: "INGESTION_FAILED" });
    const started = byEvent(forJob, "worker.job.started");
    expect(started.map((r) => r["attempt"])).toEqual([1, 2]);
    expect(new Set(started.map((r) => r["correlationId"])).size).toBe(1);
    const failed = byEvent(forJob, "worker.job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ attempt: 1, retryable: true, errorCode: "INGESTION_FAILED" });
    expect(JSON.stringify(failed)).not.toContain("injected transient failure");
    expect(byEvent(forJob, "worker.job.completed")[0]).toMatchObject({ attempt: 2, outcome: "validation_created" });
    expect(h.invocations.get(`tg-tg_chat_${chatId}-${messageId}`)).toBe(2);
  }, 60_000);

  it("a duplicate webhook deduplicates onto the existing outbox row and does not become its context", async () => {
    const { h, records } = await start();
    const chatId = uniqueChatId(); const messageId = rand(); const user = `corr_dup_${rand()}`;
    await post(h, chatId, messageId, { "x-correlation-id": "it-first-request-1" }, user);
    const jobId = `tg-tg_chat_${chatId}-${messageId}`;
    const pipelineId = await completed(h, chatId, messageId);
    await post(h, chatId, messageId, { "x-correlation-id": "it-second-request-2" }, user);
    const dup = must(byEvent(records, "webhook.enqueue.deduplicated")[0]);
    expect(dup).toMatchObject({ jobId, correlationId: "it-second-request-2" });
    expect(byEvent(records, "outbox.duplicated")).toHaveLength(1);
    const row = must(await h.outboxRow(`tg_chat_${chatId}`, String(messageId)));
    expect((row.rawPayload as { correlation: { correlationId: string } }).correlation.correlationId).toBe("it-first-request-1");
    expect(row.correlationId).toBe("it-first-request-1");
    expect(h.invocations.get(jobId)).toBe(1); // processed once
    expect(pipelineId).toBe(`outbox-${row.id}`);
    expect(records.filter((r) => r.event.startsWith("worker.")).some((r) => r["correlationId"] === "it-second-request-2")).toBe(false);
  }, 60_000);

  it("a legacy job queued without correlation metadata is processed normally with a worker-generated, flagged id", async () => {
    const { h, records } = await start();
    const chatId = uniqueChatId(); const messageId = rand();
    const normalized = must(normalizeRawUpdate(telegramWebhookPayload(rand(), messageId, `corr_legacy_${rand()}`, chatId)));
    const jobId = `legacy-${messageId}`;
    await h.queue.add("telegram_messages", {
      jobType: "telegram_messages", providerName: "telegram-bot-webhook", // no `correlation`
      telegram: { params: { channelIdentifier: normalized.channelIdentifier }, normalizedMessage: normalized, exchange: "NSE", instrumentType: "equity" },
    } as never, { jobId, attempts: 3 });
    await completedJob(h, jobId);
    const started = must(records.find((r) => r.event === "worker.job.started" && r["jobId"] === jobId));
    expect(started["correlationOrigin"]).toBe("worker-generated");
    expect(started["correlationId"]).toMatch(/^corr_/);
    expect(records.find((r) => r.event === "worker.job.completed" && r["jobId"] === jobId)).toMatchObject({ outcome: "validation_created" });
  }, 60_000);

  it("concurrent requests never leak correlation context into each other's log lines", async () => {
    const { h, records } = await start();
    const chatId = uniqueChatId(); const user = `corr_conc_${rand()}`;
    const ids = Array.from({ length: 6 }, (_, i) => ({ messageId: rand() + i, corr: `it-concurrent-${i}-${rand()}` }));
    await Promise.all(ids.map((x) => post(h, chatId, x.messageId, { "x-correlation-id": x.corr }, user)));
    const pipelineIds = await Promise.all(ids.map((x) => completed(h, chatId, x.messageId)));
    for (const [i, x] of ids.entries()) {
      const jobId = must(pipelineIds[i]);
      const lines = records.filter((r) => r["jobId"] === jobId || r["externalMessageId"] === String(x.messageId));
      expect(lines.length).toBeGreaterThanOrEqual(7);
      expect(new Set(lines.map((r) => r["correlationId"]))).toEqual(new Set([x.corr]));
    }
    // every record that has a correlation id belongs to exactly one of the six requests
    const known = new Set(ids.map((x) => x.corr));
    expect(records.filter((r) => typeof r["correlationId"] === "string").every((r) => known.has(r["correlationId"] as string))).toBe(true);
  }, 90_000);
});
