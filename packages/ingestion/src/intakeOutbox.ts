import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";

/**
 * Durable intake outbox (table `telegram_intake_outbox`). The API writes a row BEFORE it acknowledges a message; Redis carries only the row id;
 * the worker claims the row atomically, processes it idempotently and marks it COMPLETED; failures are retried with exponential backoff and
 * jitter until `max_attempts`, then the row is DEAD_LETTER (kept, never deleted). A reconciler re-enqueues rows whose Redis job was lost.
 * Nothing in this module reads or logs message content: errors are stored as a code/class name only.
 */
export type OutboxStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DEAD_LETTER";
export type OutboxMessageType = "message" | "edit" | "deletion";
export type OutboxIntakeSource = "bot_webhook" | "user_capture";

export const OUTBOX_QUEUE_JOB_NAME = "telegram_outbox";
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;

export interface OutboxEntryInput {
  messageType: OutboxMessageType;
  intakeSource: OutboxIntakeSource;
  sourceMessageId: string;
  channelId: string;
  authorId?: string | null;
  /** The job payload the worker processes (jobType telegram_messages | telegram_events). */
  payload: Record<string, unknown>;
  correlationId?: string | undefined;
  receivedAt: Date;
  maxAttempts?: number;
}

export interface OutboxRecordResult {
  id: string;
  /** false: an identical entry already existed (duplicate delivery); nothing was written. */
  created: boolean;
  status: OutboxStatus;
  attemptCount: number;
}

export type OutboxRow = typeof schema.telegramIntakeOutbox.$inferSelect;

/** The seam the API uses; tests may inject a clearly test-owned in-memory implementation. */
export interface IntakeOutbox {
  record(input: OutboxEntryInput): Promise<OutboxRecordResult>;
  markEnqueued(id: string): Promise<void>;
}

export const OUTBOX_JOB_ID = (id: string, attemptCount: number): string => `outbox-${id}-${attemptCount}`;

const sha12 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

/** Class name or code only, at most 200 characters; an error message may embed row values and is never stored. */
export function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(code)) return code;
  const name = error instanceof Error ? error.name : "NonError";
  return name.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "Error";
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
}
export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseMs: 5_000, maxMs: 900_000 };

/** Exponential backoff with jitter: min(max, base * 2^(attempt-1)) scaled by a random factor in [0.5, 1.0]. `attempt` is the attempt that just failed (1-based). */
export function computeRetryDelayMs(attempt: number, random: () => number = Math.random, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

export function buildMessageOutboxInput(args: {
  intakeSource: OutboxIntakeSource;
  normalized: { channelIdentifier: string; externalMessageId: string; editDate?: Date | string | null | undefined };
  payload: Record<string, unknown>;
  correlationId?: string | undefined;
  receivedAt: Date;
}): OutboxEntryInput {
  return {
    messageType: args.normalized.editDate ? "edit" : "message",
    intakeSource: args.intakeSource,
    sourceMessageId: args.normalized.externalMessageId,
    channelId: args.normalized.channelIdentifier,
    payload: args.payload,
    correlationId: args.correlationId,
    receivedAt: args.receivedAt,
  };
}

export function buildDeletionOutboxInput(args: {
  intakeSource: OutboxIntakeSource;
  channelIdentifier: string;
  messageIds: string[];
  payload: Record<string, unknown>;
  correlationId?: string | undefined;
  receivedAt: Date;
}): OutboxEntryInput {
  const ids = [...new Set(args.messageIds)].sort();
  return {
    messageType: "deletion",
    intakeSource: args.intakeSource,
    sourceMessageId: `del-${sha12(ids.join(","))}`,
    channelId: args.channelIdentifier,
    payload: args.payload,
    correlationId: args.correlationId,
    receivedAt: args.receivedAt,
  };
}

const table = schema.telegramIntakeOutbox;

export class PgIntakeOutbox implements IntakeOutbox {
  constructor(private readonly db: Db) {}

  async record(input: OutboxEntryInput): Promise<OutboxRecordResult> {
    const [inserted] = await this.db
      .insert(table)
      .values({
        messageType: input.messageType,
        intakeSource: input.intakeSource,
        sourceMessageId: input.sourceMessageId,
        channelId: input.channelId,
        authorId: input.authorId ?? null,
        rawPayload: input.payload,
        correlationId: input.correlationId ?? null,
        receivedAt: input.receivedAt,
        maxAttempts: input.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS,
      })
      .onConflictDoNothing({ target: [table.channelId, table.sourceMessageId, table.messageType] })
      .returning({ id: table.id, status: table.status, attemptCount: table.attemptCount });
    if (inserted) return { id: inserted.id, created: true, status: inserted.status as OutboxStatus, attemptCount: inserted.attemptCount };
    const [existing] = await this.db
      .select({ id: table.id, status: table.status, attemptCount: table.attemptCount })
      .from(table)
      .where(and(eq(table.channelId, input.channelId), eq(table.sourceMessageId, input.sourceMessageId), eq(table.messageType, input.messageType)));
    if (!existing) throw new Error("outbox row neither inserted nor found");
    return { id: existing.id, created: false, status: existing.status as OutboxStatus, attemptCount: existing.attemptCount };
  }

  async markEnqueued(id: string): Promise<void> {
    await this.db
      .update(table)
      .set({ enqueuedAt: new Date() })
      .where(and(eq(table.id, id), inArray(table.status, ["PENDING", "FAILED"])));
  }
}

/** Atomic claim: exactly one caller moves a due PENDING/FAILED row to PROCESSING and increments attempt_count. Returns undefined when not claimable. */
export async function claimOutboxRow(db: Db, id: string, workerId: string, now?: Date): Promise<OutboxRow | undefined> {
  // The database clock decides by default: available_at is written by the database (default now()), so a skewed application clock must not make a fresh row unclaimable.
  const at = now ?? sql`now()`;
  const [row] = await db
    .update(table)
    .set({ status: "PROCESSING", lockedAt: at, lockedBy: workerId, attemptCount: sql`${table.attemptCount} + 1` })
    .where(and(eq(table.id, id), inArray(table.status, ["PENDING", "FAILED"]), lte(table.availableAt, at)))
    .returning();
  return row;
}

export async function readOutboxRow(db: Db, id: string): Promise<OutboxRow | undefined> {
  const [row] = await db.select().from(table).where(eq(table.id, id));
  return row;
}

/** PROCESSING -> COMPLETED, only for the worker that holds the lock. false: the lease was lost (e.g. reclaimed by the reconciler). */
export async function completeOutboxRow(db: Db, id: string, workerId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(table)
    .set({ status: "COMPLETED", completedAt: now, lockedAt: null, lockedBy: null, lastError: null })
    .where(and(eq(table.id, id), eq(table.status, "PROCESSING"), eq(table.lockedBy, workerId)))
    .returning({ id: table.id });
  return rows.length === 1;
}

export interface OutboxFailureResult {
  status: "FAILED" | "DEAD_LETTER";
  attemptCount: number;
  nextAvailableAt?: Date;
}

/** PROCESSING -> FAILED (retry scheduled with backoff + jitter) or DEAD_LETTER (attempts exhausted, or `permanent`). */
export async function failOutboxRow(
  db: Db,
  row: Pick<OutboxRow, "id" | "attemptCount" | "maxAttempts">,
  workerId: string,
  error: unknown,
  options: { permanent?: boolean; now?: Date; random?: () => number; policy?: RetryPolicy } = {},
): Promise<OutboxFailureResult | undefined> {
  const now = options.now ?? new Date();
  const dead = options.permanent === true || row.attemptCount >= row.maxAttempts;
  const nextAvailableAt = dead ? undefined : new Date(now.getTime() + computeRetryDelayMs(row.attemptCount, options.random, options.policy));
  const rows = await db
    .update(table)
    .set({
      status: dead ? "DEAD_LETTER" : "FAILED",
      lastError: safeErrorCode(error),
      lockedAt: null,
      lockedBy: null,
      ...(nextAvailableAt ? { availableAt: nextAvailableAt, enqueuedAt: null } : {}),
    })
    .where(and(eq(table.id, row.id), eq(table.status, "PROCESSING"), eq(table.lockedBy, workerId)))
    .returning({ attemptCount: table.attemptCount });
  const updated = rows[0];
  if (!updated) return undefined;
  return { status: dead ? "DEAD_LETTER" : "FAILED", attemptCount: updated.attemptCount, ...(nextAvailableAt ? { nextAvailableAt } : {}) };
}

/** A safety refusal after the claim (intake paused / kill switch) is not a failure: PROCESSING -> PENDING and the attempt is given back. */
export async function releaseOutboxRow(db: Db, id: string, workerId: string): Promise<boolean> {
  const rows = await db
    .update(table)
    .set({ status: "PENDING", lockedAt: null, lockedBy: null, attemptCount: sql`${table.attemptCount} - 1`, enqueuedAt: null })
    .where(and(eq(table.id, id), eq(table.status, "PROCESSING"), eq(table.lockedBy, workerId)))
    .returning({ id: table.id });
  return rows.length === 1;
}

export interface ExpiredLease {
  id: string;
  status: "FAILED" | "DEAD_LETTER";
  attemptCount: number;
}

/** PROCESSING rows whose lease expired (the worker died): FAILED and immediately due again, or DEAD_LETTER when attempts are exhausted. */
export async function recoverExpiredLeases(db: Db, now: Date, leaseMs: number): Promise<ExpiredLease[]> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const rows = await db
    .update(table)
    .set({
      status: sql`case when ${table.attemptCount} >= ${table.maxAttempts} then 'DEAD_LETTER' else 'FAILED' end`,
      lastError: "lease_expired",
      lockedAt: null,
      lockedBy: null,
      availableAt: now,
      enqueuedAt: null,
    })
    .where(and(eq(table.status, "PROCESSING"), lte(table.lockedAt, cutoff)))
    .returning({ id: table.id, status: table.status, attemptCount: table.attemptCount });
  return rows.map((r) => ({ id: r.id, status: r.status as "FAILED" | "DEAD_LETTER", attemptCount: r.attemptCount }));
}

/** Due rows that need a (re-)enqueue: never enqueued for this attempt (after a short grace) or enqueued so long ago that the Redis job must be presumed lost. */
export async function findRedeliverableOutboxRows(
  db: Db,
  now: Date,
  options: { graceMs: number; redeliverAfterMs: number; limit: number },
): Promise<Array<{ id: string; attemptCount: number }>> {
  const graceCutoff = new Date(now.getTime() - options.graceMs);
  const redeliverCutoff = new Date(now.getTime() - options.redeliverAfterMs);
  return db
    .select({ id: table.id, attemptCount: table.attemptCount })
    .from(table)
    .where(
      and(
        inArray(table.status, ["PENDING", "FAILED"]),
        lte(table.availableAt, now),
        or(and(isNull(table.enqueuedAt), lte(table.availableAt, graceCutoff)), lte(table.enqueuedAt, redeliverCutoff)),
      ),
    )
    .orderBy(table.availableAt)
    .limit(options.limit);
}
