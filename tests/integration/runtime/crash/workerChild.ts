/**
 * Dedicated child worker process for the crash/recovery test. Runs the REAL queue handler
 * (`processSignalQueueJob`, i.e. the durable-outbox claim + the unchanged pipeline) against the guarded twins_ci database and the test Redis, on a
 * test-owned queue passed as `--queue=<name>`.
 *
 *   --mode=crash    holds BEFORE the first INSERT into `signals` (after the message row is committed;
 *                   the pipeline has no explicit transactions, every statement autocommits), tells the
 *                   parent over IPC, then blocks forever so the parent can SIGKILL this exact pid.
 *   --mode=recover  plain worker (the replacement).
 *
 * TEST-ONLY BullMQ settings (documented, not production values): lockDuration 3000 ms,
 * stalledInterval 1000 ms, maxStalledCount 1 (BullMQ default). Production settings are untouched.
 * Synthetic market data only. Logs are JSON lines on stdout. IPC: {type:'ready'|'checkpoint'|'closed'}.
 */
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { getTableName } from "drizzle-orm";
import { createBoundedDb, type Db } from "../../../../packages/database/src/index";
import { createStructuredLogger } from "../../../../packages/shared/src/index";
import { configureRuntimeState, pgStateSource } from "../../../../packages/runtime-state/src/index";
import { type SignalQueueJobPayload } from "../../../../services/worker/src/index";
import { processSignalQueueJob } from "../../../support/workerWithTestPolicy";
import { marketDataProviders, YAHOO_PROVIDER_NAME } from "../../../../adapters/market/src/index";
import { syntheticMarketProvider } from "../harness";

export const CRASH_CHECKPOINT = "message_committed_before_signal_insert";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`missing --${name}=...`);
  return hit.slice(name.length + 3);
}

function assertSafeTarget(): void {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://missing");
  const redis = new URL(process.env.REDIS_URL ?? "redis://missing");
  const loop = new Set(["127.0.0.1", "localhost"]);
  if (process.env.TWINS_CI !== "1" || process.env.LIVE_TRADING !== "false") throw new Error("unsafe environment (need TWINS_CI=1, LIVE_TRADING=false)");
  if (!loop.has(db.hostname) || db.pathname !== "/twins_ci" || decodeURIComponent(db.username) !== "twins_ci") throw new Error("refusing: DATABASE_URL is not the twins_ci test target");
  if (!loop.has(redis.hostname) || redis.port !== "16379") throw new Error("refusing: REDIS_URL is not the test Redis");
}

/** Holds (forever) the first awaited INSERT into `table` after reporting the checkpoint. */
function holdBeforeFirstInsert(db: Db, table: string, onHold: () => void): Db {
  let held = false;
  const wrap = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then" && !held) {
          return () => {
            held = true;
            onHold();
            return new Promise<never>(() => undefined); // never settles: the parent kills this process here
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          const r = (v as (...x: unknown[]) => unknown).apply(target, a);
          return r && typeof r === "object" ? wrap(r as object) : r;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "insert" && typeof v === "function") {
        return (t: Parameters<Db["insert"]>[0]) => {
          const builder = (v as (x: unknown) => object).call(target, t);
          return getTableName(t) === table && !held ? wrap(builder) : builder;
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Db;
}

async function main(): Promise<void> {
  assertSafeTarget();
  const queueName = arg("queue");
  const mode = arg("mode");
  if (mode !== "crash" && mode !== "recover") throw new Error("--mode must be crash|recover");
  if (!queueName.startsWith("r0b_test_")) throw new Error("refusing: queue is not test-owned");

  marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);
  const dbHandle = createBoundedDb({ url: process.env.DATABASE_URL ?? "", max: 5, idleTimeoutMillis: 10000 });
  // Like the production worker, this process reads the REAL database-backed safety state (fail closed if it cannot): an unconfigured process would refuse every job.
  configureRuntimeState({ source: pgStateSource(dbHandle.pool) });
  const logger = createStructuredLogger((r) => process.stdout.write(JSON.stringify({ ...r, childMode: mode, childPid: process.pid }) + "\n"));
  const db =
    mode === "crash"
      ? holdBeforeFirstInsert(dbHandle.db, "signals", () => process.send?.({ type: "checkpoint", name: CRASH_CHECKPOINT, pid: process.pid }))
      : dbHandle.db;

  const redis = new Redis(process.env.REDIS_URL ?? "", { maxRetriesPerRequest: null });
  const worker = new Worker<SignalQueueJobPayload>(
    queueName,
    async (job: Job<SignalQueueJobPayload>) => processSignalQueueJob(job, undefined, db, { logger, outboxRetryPolicy: { baseMs: 50, maxMs: 200 } }),
    { connection: redis, concurrency: 1, lockDuration: 3000, stalledInterval: 1000, maxStalledCount: 1 },
  );
  await worker.waitUntilReady();
  process.send?.({ type: "ready", pid: process.pid, mode });

  process.on("message", (m: { type?: string }) => {
    if (m?.type !== "shutdown") return;
    void (async () => {
      await worker.close();
      await redis.quit();
      await dbHandle.close();
      process.send?.({ type: "closed" }, () => process.exit(0));
    })();
  });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ event: "child.fatal", errorName: err instanceof Error ? err.name : "Error" }));
  process.exit(1);
});
