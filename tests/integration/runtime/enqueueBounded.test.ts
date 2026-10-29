/**
 * T6 with REAL ioredis + BullMQ against the test Redis, through a test-owned in-process TCP forwarder that the
 * test can cut and restore. This observes "healthy -> connection lost -> restored" for the HTTP producer
 * without stopping any container or touching the Redis server.
 * NOT a Redis outage drill: the Redis server never goes down; only this test's own network path does.
 * Uses a unique test-owned queue (obliterated at the end); no shared queue is used.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "../../support/apiWithTestPolicy";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { and, eq } from "drizzle-orm";
import { createBoundedDb, schema } from "../../../packages/database/src/index";
import { reconcileOutbox } from "../../../services/worker/src/outbox";
import { DATABASE_URL, REDIS_URL, TEST_API_KEY, TEST_WEBHOOK_SECRET, telegramWebhookPayload, uniqueChatId, waitFor, webhookHeaders, must } from "./harness";

const target = new URL(REDIS_URL);

class Forwarder {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  port = 0;
  async start(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
      this.sockets.add(client); this.sockets.add(upstream);
      client.pipe(upstream); upstream.pipe(client);
      const drop = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on("error", drop); upstream.on("error", drop); client.on("close", drop); upstream.on("close", drop);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
    this.port = (server.address() as net.AddressInfo).port;
  }
  async cut(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

describe("HTTP producer against real ioredis/BullMQ, with a cut-and-restore network path (controlled; not an outage drill)", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => { for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* reported by assertions */ } } });

  it("202 when healthy; while the path is down the update is still acknowledged promptly BECAUSE it is durable; the reconciler enqueues it once the path returns, with exactly one job", async () => {
    const fwd = new Forwarder();
    await fwd.start();
    const queueName = `r0b_test_enqbound_${randomUUID().replace(/-/g, "")}`;
    const producer = new Redis({ host: "127.0.0.1", port: fwd.port, maxRetriesPerRequest: 3 });
    producer.on("error", () => undefined); // expected while the path is cut; asserted through behaviour, not logs
    const queue = new Queue(queueName, { connection: producer });
    const direct = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    const directQueue = new Queue(queueName, { connection: direct }); // independent view of the real queue
    const records: LogRecord[] = [];
    const dbHandle = createBoundedDb({ url: DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
    cleanup.push(() => dbHandle.close());
    const app = await buildApp({
      apiKey: TEST_API_KEY, telegramWebhookSecret: TEST_WEBHOOK_SECRET, db: dbHandle.db, logger: false, enqueueTimeoutMs: 800,
      telegramQueue: queue, structuredLogger: createStructuredLogger((r) => records.push(r)),
    });
    cleanup.push(async () => {
      await app.close(); await queue.close(); await producer.quit().catch(() => producer.disconnect());
      await directQueue.obliterate({ force: true }); await directQueue.close(); await direct.quit();
      await fwd.cut().catch(() => undefined);
    });
    const post = async (updateId: number, messageId: number, chatId: number) => {
      const t0 = Date.now();
      const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload: JSON.stringify(telegramWebhookPayload(updateId, messageId, "enqbound", chatId)) });
      return { res, ms: Date.now() - t0 };
    };
    const chatId = uniqueChatId();

    // 1. healthy
    const ok = await post(1, 101, chatId);
    expect(ok.res.statusCode).toBe(202);
    const [first] = await dbHandle.db.select().from(schema.telegramIntakeOutbox).where(and(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`), eq(schema.telegramIntakeOutbox.sourceMessageId, "101")));
    expect(await directQueue.getJob(`outbox-${must(first).id}-0`)).toBeDefined();

    // 2. path cut after a previously healthy connection: the message is durable in PostgreSQL, so it is acknowledged; Redis never saw it
    await fwd.cut();
    const down = await post(2, 102, chatId);
    expect(down.res.statusCode).toBe(202);
    expect(down.ms).toBeLessThan(2500); // bound 800 ms + scheduling; not indefinite
    const failedButDurable = must(records.find((r) => r.event === "outbox.enqueue_failed_but_durable"));
    console.log(JSON.stringify({ observedWhilePathDown: { event: failedButDurable.event, ms: down.ms } }));
    expect(JSON.stringify(records)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED at|redis:\/\//);
    const [row] = await dbHandle.db.select().from(schema.telegramIntakeOutbox).where(and(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`), eq(schema.telegramIntakeOutbox.sourceMessageId, "102")));
    expect(row).toMatchObject({ status: "PENDING", enqueuedAt: null, attemptCount: 0 });
    expect(await directQueue.getJob(`outbox-${must(row).id}-0`)).toBeUndefined(); // nothing could have reached Redis

    // 3. path restored: ioredis reconnects by itself; the production reconciler (grace 0 for the test) enqueues the durable row; client retries are idempotent duplicates
    await fwd.start(fwd.port);
    await waitFor(async () => (producer.status === "ready" ? true : undefined), 20_000, "producer reconnect");
    const summary = await reconcileOutbox(dbHandle.db, { logger: createStructuredLogger((r) => records.push(r)), queue: directQueue, graceMs: 0 });
    expect(summary.enqueued).toBeGreaterThanOrEqual(1);
    const retried = await post(2, 102, chatId);
    expect(retried.res.statusCode).toBe(202);
    const again = await post(2, 102, chatId); // a further client retry
    expect(again.res.statusCode).toBe(202);
    const jobs = await directQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    expect(jobs.filter((j) => j.id === `outbox-${must(row).id}-0`)).toHaveLength(1); // never two jobs for one update
    expect(await dbHandle.db.select().from(schema.telegramIntakeOutbox).where(and(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`), eq(schema.telegramIntakeOutbox.sourceMessageId, "102")))).toHaveLength(1);
  }, 90_000);
});
