import type { CorrelationId, UserId } from "./ids";
import type { EventType } from "./events";

/** Background-job conventions (ADR-006): one envelope, one idempotency-key rule, one retry policy shape. The queue itself stays BullMQ. */
export const QUEUES = ["ingestion", "classification", "research", "opportunity-scan", "risk", "simulation", "decision", "execution", "monitoring", "learning", "notifications"] as const;
export type QueueName = (typeof QUEUES)[number];
export interface RetryPolicy { attempts: number; backoffMs: number; maxBackoffMs: number }
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, backoffMs: 1_000, maxBackoffMs: 300_000 };
/** Execution jobs are never retried blindly: a repeated order submission is worse than a missed one. */
export const EXECUTION_RETRY: RetryPolicy = { attempts: 1, backoffMs: 0, maxBackoffMs: 0 };
export const retryFor = (q: QueueName): RetryPolicy => (q === "execution" ? EXECUTION_RETRY : DEFAULT_RETRY);

export interface JobEnvelope<T = unknown> { queue: QueueName; type: EventType; idempotencyKey: string; correlationId: CorrelationId; userId: UserId | null; payload: T }
/** Same inputs, same key: a replayed event can never create a second job. */
export function idempotencyKey(type: EventType, subjectId: string, version = 1): string { return `${type}:${subjectId}:v${version}`; }
export function backoffDelay(p: RetryPolicy, attempt: number): number { return Math.min(p.maxBackoffMs, p.backoffMs * 2 ** Math.max(0, attempt - 1)); }
