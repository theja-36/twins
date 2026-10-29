import { describeErrorSafely, type StructuredLogger } from "@twins/shared";
import type { IntakeOutbox, OutboxEntryInput } from "@twins/ingestion";

/**
 * Durable acceptance of one Telegram intake entry (Stage 2 / Task 2).
 *
 * Order is fixed: (1) write the outbox row to PostgreSQL, (2) only then try to enqueue a lightweight Redis job that carries the row id.
 * A failure of step 1 is NOT an acceptance (the caller answers 503 and the sender retries; fail closed). A failure of step 2 is NOT a failure
 * of the request: the message is already durable and the worker's reconciler re-enqueues it, so the caller still answers success.
 * Logs carry ids, counts and codes only, never message content.
 */
export class IntakeStoreUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "INTAKE_STORE_UNAVAILABLE";
  constructor() {
    super("Service Unavailable"); // generic on purpose; never carries the underlying error text
    this.name = "IntakeStoreUnavailableError";
  }
}

export type IntakeEnqueue = (outboxId: string, attemptCount: number, deadlineMs: number) => Promise<void>;

export interface IntakeSubmitResult {
  outcome: "accepted" | "duplicate";
  outboxId: string;
  /** true when the Redis job for the current attempt was accepted; false means the reconciler will enqueue it. */
  enqueued: boolean;
}

export interface IntakeService {
  submit(entry: OutboxEntryInput, deadlineMs: number, log: StructuredLogger): Promise<IntakeSubmitResult>;
}

export function createIntakeService(deps: { outbox: IntakeOutbox; enqueue: IntakeEnqueue }): IntakeService {
  return {
    async submit(entry, deadlineMs, log) {
      let record;
      try {
        record = await deps.outbox.record(entry);
      } catch (error) {
        log.error("outbox.persist_failed", { ...describeErrorSafely(error), channelId: entry.channelId, messageType: entry.messageType });
        throw new IntakeStoreUnavailableError();
      }
      const fields = { outboxId: record.id, messageType: entry.messageType, channelId: entry.channelId, intakeSource: entry.intakeSource };
      log.info(record.created ? "outbox.accepted" : "outbox.duplicated", { ...fields, status: record.status });

      // A duplicate delivery of a row that is already finished or in flight needs no new Redis job.
      const needsJob = record.status === "PENDING" || record.status === "FAILED";
      if (!needsJob) return { outcome: record.created ? "accepted" : "duplicate", outboxId: record.id, enqueued: false };
      try {
        await deps.enqueue(record.id, record.attemptCount, deadlineMs);
        await deps.outbox.markEnqueued(record.id).catch((error: unknown) => log.warn("outbox.mark_enqueued_failed", { ...fields, ...describeErrorSafely(error) }));
        log.info("outbox.enqueued", { ...fields, attempt: record.attemptCount });
        return { outcome: record.created ? "accepted" : "duplicate", outboxId: record.id, enqueued: true };
      } catch (error) {
        log.warn("outbox.enqueue_failed_but_durable", { ...fields, ...describeErrorSafely(error) });
        return { outcome: record.created ? "accepted" : "duplicate", outboxId: record.id, enqueued: false };
      }
    },
  };
}
