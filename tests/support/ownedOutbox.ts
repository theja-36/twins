import type { Queue } from "bullmq";
import { PgIntakeOutbox, type IntakeOutbox } from "../../packages/ingestion/src/index";
import type { Db } from "../../packages/database/src/index";

/**
 * Test isolation for the durable outbox. Test databases are shared and long-lived, so the production reconciler (which correctly works on ALL due
 * rows) would pick up rows left by other tests or earlier runs and hand them to this test's worker. Each test therefore wraps its API's outbox to
 * remember the rows it accepted and gives its reconciler a queue that only enqueues those. Production has one queue and no such wrapper.
 */
export function createOwnedOutbox(db: Db) {
  const owned = new Set<string>();
  const pg = new PgIntakeOutbox(db);
  const outbox: IntakeOutbox = {
    async record(input) {
      const result = await pg.record(input);
      owned.add(result.id);
      return result;
    },
    markEnqueued: (id) => pg.markEnqueued(id),
  };
  const queueFor = (queue: Pick<Queue, "add">): Pick<Queue, "add"> =>
    ({
      add: (name: string, data: { outboxId?: string }, options: Parameters<Queue["add"]>[2]) =>
        data.outboxId && owned.has(data.outboxId) ? queue.add(name, data as never, options) : Promise.reject(new Error("row belongs to another test")),
    }) as unknown as Pick<Queue, "add">;
  return { outbox, queueFor, owned };
}
