/**
 * Shared harness for R0B runtime integration tests. Real Redis + PostgreSQL,
 * a unique test-owned queue per harness, synthetic market data only.
 * Cleanup touches only resources this harness created.
 */
import { requireTestDatabaseUrl, requireTestRedisUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { getTableName } from "drizzle-orm";
import { createStructuredLogger, type StructuredLogger } from "../../../packages/shared/src/index";
import { buildApp } from "../../support/apiWithTestPolicy";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { and, eq } from "drizzle-orm";
import { type SignalQueueJobPayload } from "../../../services/worker/src/index";
import { startOutboxReconciler } from "../../../services/worker/src/outbox";
import { readOutboxRow } from "../../../packages/ingestion/src/index";
import { createOwnedOutbox } from "../../support/ownedOutbox";
import { processSignalQueueJob } from "../../support/workerWithTestPolicy";
import {
  marketDataProviders,
  YAHOO_PROVIDER_NAME,
  type MarketDataProvider,
} from "../../../adapters/market/src/index";
import type { Db } from "../../../packages/database/src/index";

export const DATABASE_URL =
  requireTestDatabaseUrl();
export const REDIS_URL = requireTestRedisUrl();
export const TEST_API_KEY = "test-twins-api-key-r0b";
export const TEST_WEBHOOK_SECRET = "test-telegram-secret-r0b";

const SYNTHETIC_SOURCE = "r0b-synthetic";
export const syntheticMarketProvider: MarketDataProvider = {
  providerName: YAHOO_PROVIDER_NAME,
  async getHistoricalBars(request) {
    return [
      {
        instrument: request.instrument,
        source: SYNTHETIC_SOURCE,
        timeframe: "1d",
        observedAt: new Date(Date.now() - 60 * 60 * 1000),
        open: 2800,
        high: 2820,
        low: 2790,
        close: 2810,
        volume: 100000,
      },
    ];
  },
  async getLatestQuote() {
    return null;
  },
  async getHealth() {
    return {
      providerName: YAHOO_PROVIDER_NAME,
      providerType: "market",
      status: "healthy",
      checkedAt: new Date(),
    };
  },
};

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface Harness {
  queueName: string;
  db: Db;
  queue: Queue;
  app: Awaited<ReturnType<typeof buildApp>>;
  /** Number of processor invocations per BullMQ job id, and (for durable-intake jobs) per business key `tg-<channel>-<message id>`. */
  invocations: Map<string, number>;
  /** The durable outbox row of a message accepted through the API. */
  outboxRow(channelIdentifier: string, sourceMessageId: string): Promise<typeof schema.telegramIntakeOutbox.$inferSelect | undefined>;
  /** Waits until the message's outbox row is COMPLETED (fast reconciler retries included). */
  waitCompleted(channelIdentifier: string, sourceMessageId: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  /** Keys remaining under this harness's own queue prefix (SCAN, never KEYS *). */
  residualKeys(): Promise<string[]>;
}

/** Test seam: wraps a db so the first `times` inserts into `table` throw an injected error. */
export function failFirstInserts(db: Db, table: string, times = 1): Db {
  let left = times;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "insert" && typeof value === "function") {
        return (t: Parameters<Db["insert"]>[0]) => {
          if (left > 0 && getTableName(t) === table) {
            left -= 1;
            throw new Error("injected transient failure (test seam)");
          }
          return (value as (x: unknown) => unknown).call(target, t);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;
}

export async function createHarness(opts: {
  /** Optional db wrapper (e.g. injected-failure seam) used by the worker only. */
  workerDb?: (db: Db) => Db;
  /** Optional structured-log capture injected into BOTH the API and the worker. */
  logger?: StructuredLogger;
}): Promise<Harness> {
  const queueName = `r0b_test_${randomUUID().replace(/-/g, "")}`;
  const dbHandle: BoundedDbHandle = createBoundedDb({
    url: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
  });
  await dbHandle.db.execute("SELECT 1");
  marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);

  const producerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const workerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const inspectRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const queue = new Queue(queueName, { connection: producerRedis });
  await queue.waitUntilReady();

  const invocations = new Map<string, number>();
  const workerDb = opts.workerDb ? opts.workerDb(dbHandle.db) : dbHandle.db;
  const worker = new Worker<SignalQueueJobPayload>(
    queueName,
    async (job: Job<SignalQueueJobPayload>) => {
      const id = String(job.id);
      invocations.set(id, (invocations.get(id) ?? 0) + 1);
      const outboxId = (job.data as { outboxId?: unknown } | undefined)?.outboxId;
      if (typeof outboxId === "string") {
        const row = await readOutboxRow(workerDb, outboxId);
        if (row) {
          const key = `tg-${row.channelId}-${row.sourceMessageId}`;
          invocations.set(key, (invocations.get(key) ?? 0) + 1);
        }
      }
      await processSignalQueueJob(job, undefined, workerDb, {
        outboxRetryPolicy: { baseMs: 50, maxMs: 200 }, // fast retries; production default is 5 s base
        ...(opts.logger ? { logger: opts.logger } : {}),
        // The harness's market provider writes SYNTHETIC bars; name that source/context so the analysis uses them and never depends on
        // real (Yahoo) bars that may be sitting in a shared database and ageing past the freshness window.
        analysisMarket: { source: SYNTHETIC_SOURCE, timeframe: "1d", context: "synthetic" },
      });
    },
    { connection: workerRedis, concurrency: 1 },
  );
  await worker.waitUntilReady();

  // The production reconciler, with test-speed intervals: it is what re-enqueues retried (FAILED) rows.
  // Each harness's reconciler may only enqueue the rows ITS OWN API accepted (see tests/support/ownedOutbox.ts).
  const owned = createOwnedOutbox(dbHandle.db);
  const reconciler = startOutboxReconciler(dbHandle.db, {
    logger: opts.logger ?? createStructuredLogger(() => undefined),
    queue: owned.queueFor(queue),
    intervalMs: 100,
    graceMs: 100,
    redeliverAfterMs: 5000,
  });

  const app = await buildApp({
    apiKey: TEST_API_KEY,
    telegramWebhookSecret: TEST_WEBHOOK_SECRET,
    telegramQueue: queue,
    intakeOutbox: owned.outbox,
    db: dbHandle.db,
    ...(opts.logger ? { structuredLogger: opts.logger } : {}),
  });

  async function residualKeys(): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await inspectRedis.scan(cursor, "MATCH", `bull:${queueName}:*`, "COUNT", 200);
      cursor = next;
      found.push(...keys);
    } while (cursor !== "0");
    return found;
  }

  return {
    queueName,
    db: dbHandle.db,
    queue,
    app,
    invocations,
    residualKeys,
    async outboxRow(channelIdentifier, sourceMessageId) {
      const [row] = await dbHandle.db
        .select()
        .from(schema.telegramIntakeOutbox)
        .where(and(eq(schema.telegramIntakeOutbox.channelId, channelIdentifier), eq(schema.telegramIntakeOutbox.sourceMessageId, sourceMessageId)));
      return row;
    },
    async waitCompleted(channelIdentifier, sourceMessageId, timeoutMs = 20_000) {
      await waitFor(async () => {
        const [row] = await dbHandle.db
          .select({ status: schema.telegramIntakeOutbox.status })
          .from(schema.telegramIntakeOutbox)
          .where(and(eq(schema.telegramIntakeOutbox.channelId, channelIdentifier), eq(schema.telegramIntakeOutbox.sourceMessageId, sourceMessageId)));
        return row?.status === "COMPLETED" ? true : undefined;
      }, timeoutMs, `outbox row ${channelIdentifier}/${sourceMessageId} to complete`);
    },
    async close() {
      reconciler.stop();
      const steps: Array<[string, () => Promise<unknown>]> = [
        ["api", () => app.close()],
        ["worker", () => worker.close()],
        ["queueObliterate", () => queue.obliterate({ force: true })], // test-owned queue only
        ["queue", () => queue.close()],
        ["producerRedis", () => producerRedis.quit()],
        ["workerRedis", () => workerRedis.quit()],
        ["db", () => dbHandle.close()],
      ];
      const failures: string[] = [];
      for (const [name, fn] of steps) {
        try {
          await fn();
        } catch (err) {
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        const left = await residualKeys();
        if (left.length > 0) failures.push(`residual redis keys: ${left.length} (${left.slice(0, 3).join(", ")})`);
      } catch (err) {
        failures.push(`residualCheck: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await inspectRedis.quit();
      } catch (err) {
        failures.push(`inspectRedis: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (failures.length > 0) throw new Error(`Teardown failures: ${failures.join("; ")}`);
    },
  };
}

/** A unique negative chat.id per test channel (chat.id is the canonical channel identity). */
export function uniqueChatId(): number {
  return -(1_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

export function telegramWebhookPayload(updateId: number, messageId: number, channelUsername: string, chatId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "channel", username: channelUsername },
      text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
    },
  };
}

export const webhookHeaders = {
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
};

/** Narrowing helper for tests (fails with a clear message instead of a non-null assertion). */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}
