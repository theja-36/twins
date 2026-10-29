import { hostname } from "node:os";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { assertIntakeEnabled, evaluateSafety, SafetyRefusalError } from "@twins/runtime-state";
import { describeErrorSafely, type StructuredLogger } from "@twins/shared";
import {
  claimOutboxRow,
  completeOutboxRow,
  failOutboxRow,
  findRedeliverableOutboxRows,
  OUTBOX_JOB_ID,
  OUTBOX_QUEUE_JOB_NAME,
  PgIntakeOutbox,
  readOutboxRow,
  recoverExpiredLeases,
  releaseOutboxRow,
  type Db,
  type RetryPolicy,
  type OutboxRow,
} from "@twins/ingestion";

/**
 * Worker side of the durable intake outbox (Stage 2 / Task 2). The Redis job carries only the outbox row id; the payload is always read from
 * PostgreSQL. A row is claimed atomically (so a duplicate or replayed Redis job is a harmless no-op), processed by the unchanged existing
 * pipeline (which is idempotent: unique indexes + deterministic keys), and then completed, retried with backoff + jitter, or dead-lettered.
 * Logs carry ids, counts and codes only, never message content.
 */
export const WORKER_ID = `${hostname().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}:${process.pid}`;

export interface OutboxJobPayload {
  jobType: typeof OUTBOX_QUEUE_JOB_NAME;
  outboxId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboxHandlerOptions {
  logger: StructuredLogger;
  /** Runs the existing pipeline for the stored payload (a job-shaped wrapper around the row's raw_payload). */
  runPipeline: (pseudoJob: Job, outboxRow: OutboxRow) => Promise<void>;
  workerId?: string;
  random?: () => number;
  now?: () => Date;
  /** Backoff for failed attempts (tests inject a fast one). Default: 5 s base, doubling, capped at 15 min, with jitter. */
  retryPolicy?: RetryPolicy;
}

export type OutboxJobOutcome = "completed" | "not_claimable" | "retry_scheduled" | "dead_lettered" | "lease_lost";

export async function processOutboxQueueJob(job: Pick<Job<OutboxJobPayload>, "data" | "id">, db: Db, options: OutboxHandlerOptions): Promise<OutboxJobOutcome> {
  const outboxId = job.data?.outboxId;
  if (typeof outboxId !== "string" || !UUID.test(outboxId)) throw new UnrecoverableError("outbox job without a valid outboxId (permanent invalid input)");
  // Safety boundary BEFORE the claim: while intake is disabled / the kill switch is active / the state is unreadable the row is not touched (fail closed).
  // The intake gate around the queue handler returns the job to the queue without consuming an attempt.
  await assertIntakeEnabled("worker.outbox_job");

  const workerId = options.workerId ?? WORKER_ID;
  const now = options.now;
  const row = await claimOutboxRow(db, outboxId, workerId, now?.());
  if (!row) {
    const existing = await readOutboxRow(db, outboxId);
    options.logger.info("outbox.claim_skipped", { outboxId, status: existing?.status ?? "missing", reason: existing ? "not_claimable" : "unknown_row" });
    return "not_claimable";
  }
  const log = options.logger.child({ outboxId, messageType: row.messageType, channelId: row.channelId, ...(row.correlationId ? { correlationId: row.correlationId } : {}) });
  log.info("outbox.claimed", { attempt: row.attemptCount, maxAttempts: row.maxAttempts, lockedBy: workerId });

  const pseudoJob = { id: `outbox-${row.id}`, data: row.rawPayload, attemptsMade: row.attemptCount - 1, opts: { attempts: row.maxAttempts } } as unknown as Job;
  try {
    await options.runPipeline(pseudoJob, row);
  } catch (error) {
    if (error instanceof SafetyRefusalError) {
      // Not a failure: give the attempt back so the refusal can never dead-letter a captured message.
      await releaseOutboxRow(db, row.id, workerId);
      log.warn("outbox.released", { reason: error.reason });
      throw error;
    }
    const permanent = error instanceof UnrecoverableError;
    const failure = await failOutboxRow(db, row, workerId, error, { permanent, ...(options.retryPolicy ? { policy: options.retryPolicy } : {}), ...(options.random ? { random: options.random } : {}), ...(now ? { now: now() } : {}) });
    if (!failure) {
      log.warn("outbox.lease_lost", { phase: "failure" });
      return "lease_lost";
    }
    if (failure.status === "DEAD_LETTER") {
      // The safety event for an unprocessable message: it is kept (never deleted) and needs an operator.
      log.error("safety.outbox.dead_lettered", { attempt: failure.attemptCount, permanent, ...describeErrorSafely(error) });
      return "dead_lettered";
    }
    log.warn("outbox.retry_scheduled", { attempt: failure.attemptCount, nextAvailableAt: failure.nextAvailableAt?.toISOString(), ...describeErrorSafely(error) });
    return "retry_scheduled";
  }
  const done = await completeOutboxRow(db, row.id, workerId, now?.());
  if (!done) {
    // The reconciler reclaimed the row while it was being processed. The pipeline is idempotent, so the replay cannot duplicate anything.
    log.warn("outbox.lease_lost", { phase: "completion" });
    return "lease_lost";
  }
  log.info("outbox.completed", { attempt: row.attemptCount });
  return "completed";
}

export interface ReconcilerOptions {
  logger: StructuredLogger;
  queue: Pick<Queue, "add">;
  /** A PROCESSING row older than this is presumed orphaned by a dead worker. Must exceed the longest legitimate processing time. */
  leaseMs?: number;
  /** A never-enqueued due row is left alone for this long, so the API's own enqueue can finish first. */
  graceMs?: number;
  /** An enqueued row that is still due after this long is re-enqueued (the Redis job is presumed lost). */
  redeliverAfterMs?: number;
  batchSize?: number;
  now?: () => Date;
}

export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_REDELIVER_AFTER_MS = 60_000;

export interface ReconcileSummary {
  skipped?: string;
  leasesRecovered: number;
  deadLettered: number;
  enqueued: number;
  enqueueFailed: number;
}

/**
 * One reconciliation pass. Does nothing at all while intake is disabled, the kill switch is active or the state is unreadable. Safe to run in
 * several processes at once: leases are recovered with one atomic UPDATE and a re-enqueue uses the attempt-scoped job id, so a duplicate is ignored.
 */
export async function reconcileOutbox(db: Db, options: ReconcilerOptions): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { leasesRecovered: 0, deadLettered: 0, enqueued: 0, enqueueFailed: 0 };
  const refusal = await evaluateSafety("intake", "worker.outbox_reconciler");
  if (refusal) {
    options.logger.warn("outbox.reconcile_skipped", { reason: refusal.reason });
    return { ...summary, skipped: refusal.reason };
  }
  const now = options.now?.() ?? new Date();
  for (const lease of await recoverExpiredLeases(db, now, options.leaseMs ?? DEFAULT_LEASE_MS)) {
    if (lease.status === "DEAD_LETTER") {
      summary.deadLettered += 1;
      options.logger.error("safety.outbox.dead_lettered", { outboxId: lease.id, attempt: lease.attemptCount, errorCode: "lease_expired" });
    } else {
      summary.leasesRecovered += 1;
      options.logger.warn("outbox.reconciled", { outboxId: lease.id, action: "lease_expired", attempt: lease.attemptCount });
    }
  }
  const due = await findRedeliverableOutboxRows(db, now, {
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    redeliverAfterMs: options.redeliverAfterMs ?? DEFAULT_REDELIVER_AFTER_MS,
    limit: options.batchSize ?? 100,
  });
  for (const row of due) {
    try {
      await options.queue.add(OUTBOX_QUEUE_JOB_NAME, { jobType: OUTBOX_QUEUE_JOB_NAME, outboxId: row.id } satisfies OutboxJobPayload, {
        jobId: OUTBOX_JOB_ID(row.id, row.attemptCount),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      });
      await new PgIntakeOutbox(db).markEnqueued(row.id);
      summary.enqueued += 1;
      options.logger.info("outbox.reconciled", { outboxId: row.id, action: "re_enqueued", attempt: row.attemptCount });
    } catch (error) {
      summary.enqueueFailed += 1;
      options.logger.warn("outbox.reconcile_enqueue_failed", { outboxId: row.id, ...describeErrorSafely(error) });
    }
  }
  return summary;
}

/** Runs reconcileOutbox on an interval until stopped. A failing pass is logged and the next one still runs. */
export function startOutboxReconciler(db: Db, options: ReconcilerOptions & { intervalMs?: number }): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reconcileOutbox(db, options)
      .catch((error: unknown) => options.logger.error("outbox.reconcile_failed", describeErrorSafely(error)))
      .finally(() => { running = false; });
  }, options.intervalMs ?? 10_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
