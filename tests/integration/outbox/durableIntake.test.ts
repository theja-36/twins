/**
 * Durable Telegram intake outbox (Stage 2 / Task 2) against real PostgreSQL and Redis (disposable test targets, synthetic data only).
 * The API handler, the Redis job, the worker claim, the real pipeline and the reconciler are the production code; time is injected where a
 * deterministic backoff or lease expiry is asserted.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, inArray } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";
import { buildApp } from "../../support/apiWithTestPolicy";
import { processSignalQueueJob, processTelegramQueueJob } from "../../support/workerWithTestPolicy";
import { createOwnedOutbox } from "../../support/ownedOutbox";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { claimOutboxRow, PgIntakeOutbox, readOutboxRow, type OutboxRow } from "../../../packages/ingestion/src/index";
import { configureRuntimeState, inMemoryStateSource, SafetyRefusalError, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { processOutboxQueueJob, reconcileOutbox } from "../../../services/worker/src/outbox";
import { marketDataProviders, YAHOO_PROVIDER_NAME } from "../../../adapters/market/src/index";
import { DATABASE_URL, REDIS_URL, must, syntheticMarketProvider, uniqueChatId } from "../runtime/harness";

const TOKEN = "outbox-it-token-0123456789abcdefghijklmnop-ABCDEF";
const API_KEY = "outbox-it-api-key-0123456789abcdef";
const WEBHOOK_SECRET = "outbox-it-webhook-secret-0123456789ab";
const TEXT = "BUY RELIANCE @ 2800 SL 2750 TGT 2900";
const SYNTHETIC = { source: "r0b-synthetic", timeframe: "1d", context: "synthetic" } as const;
const FAST = { baseMs: 50, maxMs: 200 };
const rand = () => Math.floor(Math.random() * 1_000_000_000);
const nowSeconds = () => Math.floor(Date.now() / 1000);

let dbHandle: BoundedDbHandle;
let queue: Queue;
let producerRedis: Redis;
let owned: ReturnType<typeof createOwnedOutbox>;
let source: InMemoryStateSource;
const records: LogRecord[] = [];
const logger = createStructuredLogger((r) => records.push(r));
const apps: Array<{ close: () => Promise<unknown> }> = [];

beforeAll(async () => {
  dbHandle = createBoundedDb({ url: DATABASE_URL, max: 6, idleTimeoutMillis: 10_000 });
  await dbHandle.db.execute("SELECT 1");
  marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);
  producerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  queue = new Queue(`r0b_test_outbox_${randomUUID().replace(/-/g, "")}`, { connection: producerRedis });
  await queue.waitUntilReady();
  owned = createOwnedOutbox(dbHandle.db);
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => {
  source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false });
  source.failWith(null);
  records.length = 0;
});
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close().catch(() => undefined);
  await producerRedis?.quit().catch(() => undefined);
  await dbHandle?.close().catch(() => undefined);
});

async function makeApp(over: Record<string, unknown> = {}) {
  const app = await buildApp({
    apiKey: API_KEY, telegramWebhookSecret: WEBHOOK_SECRET, captureIngestToken: TOKEN,
    telegramQueue: queue, intakeOutbox: owned.outbox, db: dbHandle.db, structuredLogger: logger, logger: false,
    ...over,
  } as never);
  apps.push(app);
  const post = (body: unknown) =>
    app.inject({ method: "POST", url: "/internal/ingest/telegram-user", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, payload: JSON.stringify(body) });
  return { app, post };
}
const chatOf = (chatId: number) => ({ id: chatId, type: "channel", title: "Synthetic" });
const live = (chatId: number, messages: unknown[]) => ({ schemaVersion: 1, captureMethod: "api_live", event: "message", chat: chatOf(chatId), messages });
const deletion = (chatId: number, ids: number[]) => ({ schemaVersion: 1, captureMethod: "api_live", event: "delete", chat: chatOf(chatId), deletedMessageIds: ids });
const msg = (id: number, over: Record<string, unknown> = {}) => ({ id, date: nowSeconds() - 100, text: TEXT, ...over });

const rowsFor = (chatId: number) =>
  dbHandle.db.select().from(schema.telegramIntakeOutbox).where(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`)).orderBy(schema.telegramIntakeOutbox.createdAt);
const rowOf = async (chatId: number, sourceMessageId: string) =>
  must((await rowsFor(chatId)).find((r) => r.sourceMessageId === sourceMessageId), `outbox row ${sourceMessageId}`);
const refresh = async (id: string) => must(await readOutboxRow(dbHandle.db, id), "outbox row");
const jobFor = (outboxId: string, attemptCount = 0) => queue.getJob(`outbox-${outboxId}-${attemptCount}`);

async function counts(chatId: number) {
  const channel = `tg_chat_${chatId}`;
  const messages = await dbHandle.db
    .select({ id: schema.telegramMessages.id, external: schema.telegramMessages.externalMessageId })
    .from(schema.telegramMessages)
    .innerJoin(schema.telegramSources, eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id))
    .where(eq(schema.telegramSources.channelIdentifier, channel));
  const ids = messages.map((m) => m.id);
  const signals = ids.length ? await dbHandle.db.select({ id: schema.signals.id }).from(schema.signals).where(inArray(schema.signals.telegramMessageId, ids)) : [];
  const validations = signals.length ? await dbHandle.db.select({ id: schema.signalValidations.id }).from(schema.signalValidations).where(inArray(schema.signalValidations.signalId, signals.map((s) => s.id))) : [];
  const events = await dbHandle.db
    .select({ type: schema.telegramMessageEvents.eventType })
    .from(schema.telegramMessageEvents)
    .innerJoin(schema.telegramSources, eq(schema.telegramMessageEvents.telegramSourceId, schema.telegramSources.id))
    .where(eq(schema.telegramSources.channelIdentifier, channel));
  return { messages: messages.length, signals: signals.length, validations: validations.length, deletions: events.filter((e) => e.type === "deleted_observed").length };
}

/** Runs the worker's outbox handler with the REAL pipeline (the test policy approves every chat). */
const work = (outboxId: string, options: { retryPolicy?: { baseMs: number; maxMs: number } } = {}) =>
  processSignalQueueJob({ id: `redis-${randomUUID()}`, data: { jobType: "telegram_outbox", outboxId }, attemptsMade: 0, opts: { attempts: 3 } } as never, undefined, dbHandle.db, {
    logger, analysisMarket: SYNTHETIC, outboxRetryPolicy: options.retryPolicy ?? FAST,
  });

/** The handler with an injected pipeline, clock and randomness, for deterministic failure/backoff assertions. */
const handle = (outboxId: string, runPipeline: () => Promise<void>, extra: { now?: Date; random?: () => number; retryPolicy?: { baseMs: number; maxMs: number } } = {}) =>
  processOutboxQueueJob({ id: "j", data: { jobType: "telegram_outbox", outboxId } } as never, dbHandle.db, {
    logger, runPipeline, workerId: "test-worker:1",
    ...(extra.now ? { now: () => extra.now as Date } : {}), ...(extra.random ? { random: extra.random } : {}), ...(extra.retryPolicy ? { retryPolicy: extra.retryPolicy } : {}),
  });

async function recordDirect(chatId: number, messageId: string, options: { maxAttempts?: number } = {}) {
  const result = await new PgIntakeOutbox(dbHandle.db).record({
    messageType: "message", intakeSource: "user_capture", sourceMessageId: messageId, channelId: `tg_chat_${chatId}`, receivedAt: new Date(), maxAttempts: options.maxAttempts ?? 8,
    payload: { jobType: "telegram_messages", providerName: "telegram-user-capture", note: "synthetic" },
  });
  owned.owned.add(result.id);
  return result.id;
}
const reconcile = (extra: { now?: Date; leaseMs?: number; graceMs?: number; redeliverAfterMs?: number } = {}) =>
  reconcileOutbox(dbHandle.db, {
    logger, queue: owned.queueFor(queue), graceMs: extra.graceMs ?? 0, redeliverAfterMs: extra.redeliverAfterMs ?? 60_000,
    ...(extra.leaseMs !== undefined ? { leaseMs: extra.leaseMs } : {}), ...(extra.now ? { now: () => extra.now as Date } : {}),
  });
const events = (name: string) => records.filter((r) => r.event === name);

describe("API -> outbox -> Redis -> worker -> downstream", () => {
  it("accepts a captured message durably, enqueues only the row id, and the worker completes it into the existing tables exactly once", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId(); const id = rand();
    const res = await post(live(chatId, [msg(id)]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    const row = await rowOf(chatId, String(id));
    expect(row).toMatchObject({ status: "PENDING", attemptCount: 0, maxAttempts: 8, messageType: "message", intakeSource: "user_capture", channelType: "telegram_chat" });
    expect(row.enqueuedAt).toBeInstanceOf(Date);
    expect((row.rawPayload as { telegram: { normalizedMessage: { rawText: string } } }).telegram.normalizedMessage.rawText).toBe(TEXT); // stored byte-for-byte
    const job = must(await jobFor(row.id));
    expect(job.name).toBe("telegram_outbox");
    expect(job.data).toEqual({ jobType: "telegram_outbox", outboxId: row.id }); // Redis carries NO message content
    expect(JSON.stringify(job.data)).not.toContain("RELIANCE");

    await work(row.id);
    expect(await refresh(row.id)).toMatchObject({ status: "COMPLETED", attemptCount: 1, lockedBy: null, lockedAt: null, lastError: null });
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
    expect(events("outbox.accepted")).toHaveLength(1);
    expect(events("outbox.enqueued")).toHaveLength(1);
    expect(events("outbox.claimed")).toHaveLength(1);
    expect(events("outbox.completed")).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(TEXT); // no message content in any structured log
    expect(JSON.stringify(records.filter((r) => r.event.startsWith("outbox.")))).not.toMatch(/BUY|RELIANCE|SL 2750/);
  });
});

describe("Redis loses the job or never gets it", () => {
  it("enqueue fails AFTER the durable write: still accepted (200), row stays recoverable, the reconciler enqueues it, the worker completes it once", async () => {
    const failing = { add: vi.fn().mockRejectedValue(Object.assign(new Error("redis down"), { code: "ECONNREFUSED" })) };
    const { post } = await makeApp({ telegramQueue: failing });
    const chatId = uniqueChatId(); const id = rand();
    const res = await post(live(chatId, [msg(id)]));
    expect(res.statusCode).toBe(200);
    const row = await rowOf(chatId, String(id));
    expect(row).toMatchObject({ status: "PENDING", enqueuedAt: null });
    expect(await jobFor(row.id)).toBeFalsy(); // Redis never saw it
    expect(events("outbox.enqueue_failed_but_durable")).toHaveLength(1);

    const summary = await reconcile();
    expect(summary.enqueued).toBeGreaterThanOrEqual(1);
    expect(events("outbox.reconciled").some((r) => r["outboxId"] === row.id && r["action"] === "re_enqueued")).toBe(true);
    expect(must(await jobFor(row.id)).data).toEqual({ jobType: "telegram_outbox", outboxId: row.id });
    await work(row.id);
    expect((await refresh(row.id)).status).toBe("COMPLETED");
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
  });

  it("an enqueued job that Redis later loses is re-enqueued after the redelivery window (stale PENDING); concurrent reconcilers still create exactly one Redis job", async () => {
    const chatId = uniqueChatId();
    const id = await recordDirect(chatId, String(rand()));
    await new PgIntakeOutbox(dbHandle.db).markEnqueued(id); // the API believed it had enqueued; the job is gone from Redis (never added in this test)
    expect((await reconcile()).enqueued).toBe(0); // within the window: left alone
    const later = new Date(Date.now() + 120_000);
    await Promise.all([reconcile({ now: later }), reconcile({ now: later }), reconcile({ now: later })]);
    const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    expect(jobs.filter((j) => j.id === `outbox-${id}-0`)).toHaveLength(1); // duplicate enqueue attempts collapse on the attempt-scoped job id
  });
});

describe("worker crash and duplicate delivery", () => {
  it("a row claimed by a worker that then died (PROCESSING, lease expired) is recovered by the reconciler and processed on a new attempt", async () => {
    const chatId = uniqueChatId(); const id = rand();
    const { post } = await makeApp();
    await post(live(chatId, [msg(id)]));
    const row = await rowOf(chatId, String(id));
    const claimed = must(await claimOutboxRow(dbHandle.db, row.id, "dead-worker:99"));
    expect(claimed).toMatchObject({ status: "PROCESSING", attemptCount: 1, lockedBy: "dead-worker:99" });
    await reconcile(); // lease still valid (5 min default): this row is not touched
    expect(await refresh(row.id)).toMatchObject({ status: "PROCESSING", lockedBy: "dead-worker:99" });

    await new Promise((r) => setTimeout(r, 20));
    const summary = await reconcile({ leaseMs: 10 }); // the lease (10 ms here) has expired in real time, so the recovered row is due immediately
    expect(summary.leasesRecovered).toBeGreaterThanOrEqual(1); // (the shared test database may hold other tests' orphaned leases too)
    expect(await refresh(row.id)).toMatchObject({ status: "FAILED", lastError: "lease_expired", lockedBy: null, lockedAt: null });
    expect(must(await jobFor(row.id, 1)).data).toEqual({ jobType: "telegram_outbox", outboxId: row.id }); // attempt-scoped id: not blocked by the retained attempt-0 job
    await work(row.id);
    expect(await refresh(row.id)).toMatchObject({ status: "COMPLETED", attemptCount: 2 });
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
  });

  it("a worker whose lease was reclaimed cannot complete the row (lease lost); the replay is idempotent", async () => {
    const chatId = uniqueChatId();
    const id = await recordDirect(chatId, String(rand()));
    const first = must(await claimOutboxRow(dbHandle.db, id, "slow-worker:1"));
    await reconcile({ now: new Date(Date.now() + 10 * 60_000) }); // lease expires -> FAILED
    const second = must(await claimOutboxRow(dbHandle.db, id, "fast-worker:2", new Date(Date.now() + 10 * 60_000)));
    expect(second.attemptCount).toBe(first.attemptCount + 1);
    const { completeOutboxRow } = await import("../../../packages/ingestion/src/index");
    expect(await completeOutboxRow(dbHandle.db, id, "slow-worker:1")).toBe(false); // not the lock holder
    expect(await completeOutboxRow(dbHandle.db, id, "fast-worker:2")).toBe(true);
  });

  it("a duplicate Redis job (same row, different job id) is a harmless no-op: no second claim, no second attempt, no duplicate downstream rows", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId(); const id = rand();
    await post(live(chatId, [msg(id)]));
    const row = await rowOf(chatId, String(id));
    await queue.add("telegram_outbox", { jobType: "telegram_outbox", outboxId: row.id }, { jobId: `dup-${randomUUID()}` });
    await Promise.all([work(row.id), work(row.id)]); // delivered twice, even concurrently
    expect(await refresh(row.id)).toMatchObject({ status: "COMPLETED", attemptCount: 1 });
    await work(row.id); // and once more after completion
    expect(await refresh(row.id)).toMatchObject({ status: "COMPLETED", attemptCount: 1 });
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
    expect(events("outbox.claim_skipped").length).toBeGreaterThanOrEqual(2);
    expect(events("outbox.claimed")).toHaveLength(1);
  });

  it("replaying the stored payload through the pipeline again (queue dedupe lost) creates no duplicate messages, signals or validations", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId(); const id = rand();
    await post(live(chatId, [msg(id)]));
    const row = await rowOf(chatId, String(id));
    await work(row.id);
    for (let i = 0; i < 2; i++) await processTelegramQueueJob({ id: `replay-${i}`, data: row.rawPayload, attemptsMade: 0, opts: { attempts: 3 } } as never, undefined, dbHandle.db, { analysisMarket: SYNTHETIC });
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
  });
});

describe("duplicate API delivery, edits and deletions", () => {
  it("the same message delivered twice (and live then history) is one outbox row and one downstream record", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId(); const id = rand();
    expect((await post(live(chatId, [msg(id), msg(id)]))).json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect((await post(live(chatId, [msg(id)]))).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const history = { ...live(chatId, [msg(id)]), captureMethod: "api_history", importBatch: { batchId: "0b9f2c3e-7d41-4a8e-9a55-6f1d2c3b4a5e", lowestMessageId: 1, lowestMessageDate: 1_700_000_000 } };
    expect((await post(history)).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const rows = await rowsFor(chatId);
    expect(rows).toHaveLength(1);
    const jobs = (await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"])).filter((j) => j.id === `outbox-${must(rows[0]).id}-0`);
    expect(jobs).toHaveLength(1);
    await work(must(rows[0]).id);
    expect(await counts(chatId)).toMatchObject({ messages: 1, signals: 1, validations: 1 });
  });

  it("an edit and a deletion are their own durable, auditable rows; the original is untouched; duplicates of each collapse; reprocessing adds nothing", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId(); const id = rand();
    const date = nowSeconds() - 200;
    await post(live(chatId, [{ id, date, text: TEXT }]));
    await post(live(chatId, [{ id, date, editDate: nowSeconds() - 100, text: `${TEXT} (edited)` }]));
    await post(deletion(chatId, [id]));
    // duplicates of all three
    await post(live(chatId, [{ id, date, text: TEXT }]));
    await post(deletion(chatId, [id]));
    const rows = await rowsFor(chatId);
    expect(rows.map((r) => r.messageType).sort()).toEqual(["deletion", "edit", "message"]);
    const original = must(rows.find((r) => r.messageType === "message"));
    const edit = must(rows.find((r) => r.messageType === "edit"));
    expect(original.sourceMessageId).toBe(String(id));
    expect(edit.sourceMessageId).not.toBe(String(id)); // a revision has its own identity
    expect(must(rows.find((r) => r.messageType === "deletion")).sourceMessageId).toMatch(/^del-[0-9a-f]{12}$/);

    for (const r of rows) await work(r.id);
    for (const r of rows) await work(r.id); // second delivery of everything
    expect((await rowsFor(chatId)).every((r) => r.status === "COMPLETED" && r.attemptCount === 1)).toBe(true);
    const c = await counts(chatId);
    expect(c.messages).toBe(2); // original + the edit revision, each stored once, none overwritten
    expect(c.deletions).toBe(1); // the deletion is recorded as its own observation, once
    expect(c.signals).toBeGreaterThanOrEqual(1);
  });
});

describe("retry with backoff, dead letter", () => {
  it("failures are retried with exponential backoff and jitter bounds; a retry is not claimable before it is due", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()));
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    const boom = () => Promise.reject(Object.assign(new Error("secret row values here"), { code: "TRANSIENT_X" }));
    const policy = { baseMs: 1000, maxMs: 60_000 };

    expect(await handle(id, boom, { now: t0, random: () => 1, retryPolicy: policy })).toBe("retry_scheduled");
    let row = await refresh(id);
    expect(row).toMatchObject({ status: "FAILED", attemptCount: 1, lastError: "TRANSIENT_X", lockedBy: null, enqueuedAt: null });
    expect(row.availableAt.getTime()).toBe(t0.getTime() + 1000);
    expect(row.lastError).not.toContain("secret"); // an error CODE, never the message
    expect(await handle(id, async () => undefined, { now: new Date(t0.getTime() + 500) })).toBe("not_claimable"); // before available_at
    expect((await refresh(id)).attemptCount).toBe(1);

    const t1 = new Date(t0.getTime() + 1000);
    await handle(id, boom, { now: t1, random: () => 1, retryPolicy: policy });
    row = await refresh(id);
    expect(row.attemptCount).toBe(2);
    expect(row.availableAt.getTime()).toBe(t1.getTime() + 2000); // doubled

    const t2 = new Date(t1.getTime() + 2000);
    await handle(id, boom, { now: t2, random: () => 0, retryPolicy: policy }); // minimum jitter = half
    expect((await refresh(id)).availableAt.getTime()).toBe(t2.getTime() + 2000); // 4000 * 0.5
    expect(events("outbox.retry_scheduled")).toHaveLength(3);
    expect(JSON.stringify(records)).not.toContain("secret row values");
  });

  it("after max_attempts the row is DEAD_LETTER with a structured safety event; it is kept, terminal, and never reprocessed or re-enqueued", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()), { maxAttempts: 2 });
    const boom = () => Promise.reject(new Error("nope"));
    const t0 = new Date("2030-02-01T00:00:00.000Z");
    expect(await handle(id, boom, { now: t0, retryPolicy: FAST })).toBe("retry_scheduled");
    expect(await handle(id, boom, { now: new Date(t0.getTime() + 60_000), retryPolicy: FAST })).toBe("dead_lettered");
    expect(await refresh(id)).toMatchObject({ status: "DEAD_LETTER", attemptCount: 2, lastError: "Error", lockedBy: null });
    const dead = events("safety.outbox.dead_lettered");
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ level: "error", outboxId: id, attempt: 2, permanent: false });
    expect(await handle(id, async () => undefined, { now: new Date(t0.getTime() + 3_600_000) })).toBe("not_claimable");
    await reconcile({ now: new Date(t0.getTime() + 7_200_000) });
    expect(await jobFor(id, 2)).toBeFalsy(); // a dead-lettered row is never re-enqueued
    expect(await jobFor(id, 0)).toBeFalsy();
    await expect(dbHandle.db.update(schema.telegramIntakeOutbox).set({ lastError: "x" }).where(eq(schema.telegramIntakeOutbox.id, id))).rejects.toThrow(); // terminal
  });

  it("permanent invalid input dead-letters at once (no pointless retries)", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()));
    expect(await handle(id, () => Promise.reject(new UnrecoverableError("bad payload")))).toBe("dead_lettered");
    expect(await refresh(id)).toMatchObject({ status: "DEAD_LETTER", attemptCount: 1 });
    expect(events("safety.outbox.dead_lettered")[0]).toMatchObject({ permanent: true });
  });

  it("a reconciler that finds an expired lease on the LAST attempt dead-letters the row instead of retrying forever", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()), { maxAttempts: 1 });
    must(await claimOutboxRow(dbHandle.db, id, "dead-worker:7"));
    const summary = await reconcile({ now: new Date(Date.now() + 10 * 60_000) });
    expect(summary.deadLettered).toBeGreaterThanOrEqual(1);
    expect(await refresh(id)).toMatchObject({ status: "DEAD_LETTER", lastError: "lease_expired" });
    expect(events("safety.outbox.dead_lettered").some((r) => r["outboxId"] === id)).toBe(true);
  });
});

describe("runtime safety controls (fail closed)", () => {
  it("kill switch active: the API refuses new intake (503, no row), the worker does not claim, the reconciler does nothing", async () => {
    const { post } = await makeApp();
    const chatId = uniqueChatId();
    const id = await recordDirect(chatId, String(rand()));
    source.set({ KILL_SWITCH_ACTIVE: true });
    const res = await post(live(uniqueChatId(), [msg(rand())]));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "intake_paused", reason: "kill_switch_active" });
    await expect(handle(id, async () => undefined)).rejects.toBeInstanceOf(SafetyRefusalError);
    expect(await reconcile({ now: new Date(Date.now() + 10 * 60_000) })).toMatchObject({ skipped: "kill_switch_active", enqueued: 0, leasesRecovered: 0 });
    expect(await refresh(id)).toMatchObject({ status: "PENDING", attemptCount: 0, lockedBy: null });
    expect(events("outbox.reconcile_skipped")[0]).toMatchObject({ reason: "kill_switch_active" });
    source.set({ KILL_SWITCH_ACTIVE: false });
    expect(await handle(id, async () => undefined)).toBe("completed"); // processed once the switch is cleared
  });

  it("intake disabled alone behaves the same", async () => {
    const { post } = await makeApp();
    const id = await recordDirect(uniqueChatId(), String(rand()));
    source.set({ INTAKE_ENABLED: false });
    expect((await post(live(uniqueChatId(), [msg(rand())]))).json()).toMatchObject({ reason: "intake_disabled" });
    await expect(handle(id, async () => undefined)).rejects.toBeInstanceOf(SafetyRefusalError);
    expect(await reconcile()).toMatchObject({ skipped: "intake_disabled" });
    expect((await refresh(id)).attemptCount).toBe(0);
  });

  it("unreadable runtime state: API 503, worker refuses, reconciler idle (state_unavailable)", async () => {
    const { post } = await makeApp();
    const id = await recordDirect(uniqueChatId(), String(rand()));
    source.failWith(new Error("database unreachable"));
    const res = await post(live(uniqueChatId(), [msg(rand())]));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "state_unavailable" });
    await expect(handle(id, async () => undefined)).rejects.toBeInstanceOf(SafetyRefusalError);
    expect(await reconcile()).toMatchObject({ skipped: "state_unavailable" });
    expect((await refresh(id)).attemptCount).toBe(0);
  });

  it("a safety refusal AFTER the claim returns the attempt: the row goes back to PENDING and the refusal can never dead-letter it", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()), { maxAttempts: 1 });
    await expect(handle(id, () => Promise.reject(new SafetyRefusalError("intake", "kill_switch_active", "test.op")))).rejects.toBeInstanceOf(SafetyRefusalError);
    expect(await refresh(id)).toMatchObject({ status: "PENDING", attemptCount: 0, lockedBy: null });
    expect(events("outbox.released")).toHaveLength(1);
  });

  it("database unavailable at intake: nothing is acknowledged and nothing is enqueued (503)", async () => {
    const dead = createBoundedDb({ connectionString: "postgresql://twins_ci:x@127.0.0.1:1/twins_ci", max: 1, idleTimeoutMillis: 1000, connectionTimeoutMillis: 300 });
    const add = vi.fn();
    const { post } = await makeApp({ telegramQueue: { add }, intakeOutbox: new PgIntakeOutbox(dead.db) });
    const res = await post(live(uniqueChatId(), [msg(rand())]));
    expect(res.statusCode).toBe(503);
    expect(add).not.toHaveBeenCalled();
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    await dead.close().catch(() => undefined);
  });
});

describe("database guards (migration 0012)", () => {
  it("identity and payload are immutable, illegal transitions and deletes are refused, terminal rows never change", async () => {
    const id = await recordDirect(uniqueChatId(), String(rand()));
    const t = schema.telegramIntakeOutbox;
    const upd = (set: Partial<OutboxRow>) => dbHandle.db.update(t).set(set as never).where(eq(t.id, id));
    await expect(upd({ rawPayload: { tampered: true } })).rejects.toThrow();
    await expect(upd({ sourceMessageId: "other" })).rejects.toThrow();
    await expect(upd({ maxAttempts: 99 })).rejects.toThrow();
    await expect(upd({ status: "COMPLETED", completedAt: new Date() })).rejects.toThrow(); // PENDING -> COMPLETED is not a transition
    await expect(dbHandle.db.delete(t).where(eq(t.id, id))).rejects.toThrow();
    await expect(upd({ status: "BOGUS" })).rejects.toThrow(); // check constraint
    expect((await refresh(id)).status).toBe("PENDING");
    must(await claimOutboxRow(dbHandle.db, id, "w:1"));
    await handle(id, async () => undefined).catch(() => undefined);
    const triggers = await dbHandle.pool.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.telegram_intake_outbox'::regclass and not tgisinternal order by tgname");
    expect(triggers.rows).toEqual([{ tgname: "telegram_intake_outbox_guard", tgenabled: "A" }, { tgname: "telegram_intake_outbox_no_truncate", tgenabled: "A" }]);
  });

  it("(sanity) the identity unique index is the idempotency rule", async () => {
    const chatId = uniqueChatId(); const mid = String(rand());
    const a = await recordDirect(chatId, mid);
    const second = await new PgIntakeOutbox(dbHandle.db).record({ messageType: "message", intakeSource: "bot_webhook", sourceMessageId: mid, channelId: `tg_chat_${chatId}`, receivedAt: new Date(), payload: { x: 1 } });
    expect(second).toMatchObject({ id: a, created: false });
    const sameIdOtherType = await new PgIntakeOutbox(dbHandle.db).record({ messageType: "edit", intakeSource: "bot_webhook", sourceMessageId: mid, channelId: `tg_chat_${chatId}`, receivedAt: new Date(), payload: { x: 1 } });
    expect(sameIdOtherType.created).toBe(true);
    owned.owned.add(sameIdOtherType.id);
    expect(await dbHandle.db.select({ id: schema.telegramIntakeOutbox.id }).from(schema.telegramIntakeOutbox).where(and(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`), eq(schema.telegramIntakeOutbox.sourceMessageId, mid)))).toHaveLength(2);
  });
});
