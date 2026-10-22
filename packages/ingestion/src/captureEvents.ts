import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";

/**
 * Append-only observations about Telegram messages captured through the User API (table `telegram_message_events`).
 * Nothing here ever updates or removes a stored message: a deletion observed in Telegram is just one more row. Only a
 * SHA-256 of the text is stored (never the text) and the metadata type below cannot carry content.
 */
export type CaptureEventType = "seen" | "edited_observed" | "deleted_observed";
export type EventCaptureMethod = "api_live" | "api_history";

/** Content-free metadata. Deliberately a closed shape: no free-form fields. */
export interface CaptureEventMeta {
  importBatchId?: string;
  clientObservedAt?: string;
  firstSeenEdited?: boolean;
}

export interface CaptureEventInput {
  telegramSourceId: string;
  /** NULL when the event concerns a message TWINS never stored (e.g. a deletion of an unknown id). */
  telegramMessageId?: string | null;
  /** The ORIGINAL Telegram message id (not a revision id). */
  externalMessageId: string;
  eventType: CaptureEventType;
  captureMethod: EventCaptureMethod;
  observedAt: Date;
  sourceEditDate?: Date | null;
  /** Full lowercase hex SHA-256 of the text at this revision. */
  contentSha256?: string | null;
  meta?: CaptureEventMeta;
}

const HEX64 = /^[0-9a-f]{64}$/;

function cleanMeta(meta: CaptureEventMeta | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (meta?.importBatchId) out["importBatchId"] = meta.importBatchId.slice(0, 64);
  if (meta?.clientObservedAt) out["clientObservedAt"] = meta.clientObservedAt.slice(0, 40);
  if (meta?.firstSeenEdited !== undefined) out["firstSeenEdited"] = meta.firstSeenEdited === true;
  return out;
}

/** `<source>:<message id>:<event type>:<edit date unix or 0>:<hash12 or 0>`: one `seen` and one `deleted_observed` per message. */
export function buildEventKey(input: Pick<CaptureEventInput, "telegramSourceId" | "externalMessageId" | "eventType" | "sourceEditDate" | "contentSha256">): string {
  const edit = input.sourceEditDate ? Math.floor(input.sourceEditDate.getTime() / 1000) : 0;
  const hash = input.contentSha256 ? input.contentSha256.slice(0, 12) : "0";
  return `${input.telegramSourceId}:${input.externalMessageId}:${input.eventType}:${edit}:${hash}`;
}

/** Inserts one event; returns true if it was new, false if an event with the same idempotency key already existed. */
export async function recordCaptureEvent(db: Db, input: CaptureEventInput): Promise<boolean> {
  if (input.contentSha256 != null && !HEX64.test(input.contentSha256)) throw new Error("contentSha256 must be 64 lowercase hex characters");
  const [row] = await db
    .insert(schema.telegramMessageEvents)
    .values({
      telegramSourceId: input.telegramSourceId,
      telegramMessageId: input.telegramMessageId ?? null,
      externalMessageId: input.externalMessageId,
      eventType: input.eventType,
      captureMethod: input.captureMethod,
      observedAt: input.observedAt,
      sourceEditDate: input.sourceEditDate ?? null,
      contentSha256: input.contentSha256 ?? null,
      rawMeta: cleanMeta(input.meta),
      idempotencyKey: buildEventKey(input),
    })
    .onConflictDoNothing({ target: schema.telegramMessageEvents.idempotencyKey })
    .returning({ id: schema.telegramMessageEvents.id });
  return row !== undefined;
}

export interface DeletionSummary {
  recorded: number;
  duplicates: number;
  /** Deleted ids for which no stored message exists (the event is recorded with a NULL message reference). */
  unknownMessages: number;
}

/** Records `deleted_observed` for each id. Reads (never writes) `telegram_messages` to link the stored original, if any. */
export async function recordDeletionEvents(
  db: Db,
  input: { telegramSourceId: string; messageIds: string[]; captureMethod: EventCaptureMethod; observedAt: Date; meta?: CaptureEventMeta },
): Promise<DeletionSummary> {
  const ids = [...new Set(input.messageIds)];
  const summary: DeletionSummary = { recorded: 0, duplicates: 0, unknownMessages: 0 };
  if (ids.length === 0) return summary;
  const stored = await db
    .select({ id: schema.telegramMessages.id, externalMessageId: schema.telegramMessages.externalMessageId })
    .from(schema.telegramMessages)
    .where(and(eq(schema.telegramMessages.telegramSourceId, input.telegramSourceId), inArray(schema.telegramMessages.externalMessageId, ids)));
  const byExternalId = new Map(stored.map((row) => [row.externalMessageId, row.id]));
  for (const id of ids) {
    const messageRowId = byExternalId.get(id) ?? null;
    if (messageRowId === null) summary.unknownMessages += 1;
    const inserted = await recordCaptureEvent(db, {
      telegramSourceId: input.telegramSourceId,
      telegramMessageId: messageRowId,
      externalMessageId: id,
      eventType: "deleted_observed",
      captureMethod: input.captureMethod,
      observedAt: input.observedAt,
      ...(input.meta ? { meta: input.meta } : {}),
    });
    if (inserted) summary.recorded += 1;
    else summary.duplicates += 1;
  }
  return summary;
}
