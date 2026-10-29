import { randomUUID } from "node:crypto";
import type { IntakeOutbox, OutboxEntryInput, OutboxRecordResult, OutboxStatus } from "../../packages/ingestion/src/index";

/**
 * Test-owned in-memory IntakeOutbox for API unit tests that run without a database. It follows the same identity rule as the table
 * (channel + source message id + message type is unique), so duplicate deliveries behave like the real thing. Never used outside tests.
 */
export interface MemoryOutboxEntry extends OutboxEntryInput {
  id: string;
  status: OutboxStatus;
  attemptCount: number;
  enqueued: boolean;
}

export function memoryOutbox(options: { failRecord?: boolean } = {}) {
  const entries = new Map<string, MemoryOutboxEntry>();
  const outbox: IntakeOutbox & { entries: Map<string, MemoryOutboxEntry>; list: () => MemoryOutboxEntry[]; failRecord: boolean } = {
    entries,
    failRecord: options.failRecord === true,
    list: () => [...entries.values()],
    async record(input): Promise<OutboxRecordResult> {
      if (outbox.failRecord) throw Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" });
      const key = `${input.channelId}|${input.sourceMessageId}|${input.messageType}`;
      const existing = entries.get(key);
      if (existing) return { id: existing.id, created: false, status: existing.status, attemptCount: existing.attemptCount };
      const entry: MemoryOutboxEntry = { ...input, id: randomUUID(), status: "PENDING", attemptCount: 0, enqueued: false };
      entries.set(key, entry);
      return { id: entry.id, created: true, status: "PENDING", attemptCount: 0 };
    },
    async markEnqueued(id) {
      for (const e of entries.values()) if (e.id === id) e.enqueued = true;
    },
  };
  return outbox;
}
