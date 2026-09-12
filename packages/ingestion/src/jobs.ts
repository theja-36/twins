import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { withRetry } from "@twins/shared";
import {
  ProviderRateLimitError,
  ProviderUnavailableError,
  type ProviderDomain,
} from "@twins/types";
import type { Db } from "./db";
import { recordProviderFailure, recordProviderSuccess } from "./providerHealth";

export interface IngestionJobParams<TResult> {
  jobType: string;
  queueName: string;
  providerName: string;
  providerType: ProviderDomain;
  payload?: unknown;
  maxAttempts?: number;
  /** Injectable for tests; defaults to a real timer via withRetry. */
  sleep?: (ms: number) => Promise<void>;
  execute: () => Promise<TResult>;
}

export interface IngestionJobOutcome<TResult> {
  jobId: string;
  status: "succeeded" | "failed";
  attempts: number;
  result?: TResult;
  error?: string;
}

const RETRYABLE = (error: unknown): boolean =>
  error instanceof ProviderUnavailableError || error instanceof ProviderRateLimitError;

/**
 * The "Ingestion Job" step of the pipeline (spec: External Provider ->
 * Provider Adapter -> Ingestion Job -> ... -> PostgreSQL). Records the
 * job's lifecycle in `jobs`, retries transient provider failures with
 * bounded backoff (spec section 45), and always records the outcome to
 * `provider_health` - a failure is recorded as a failure, never silently
 * turned into an empty success (spec section 45).
 */
export async function runIngestionJob<TResult extends Record<string, unknown>>(
  db: Db,
  params: IngestionJobParams<TResult>,
): Promise<IngestionJobOutcome<TResult>> {
  const [job] = await db
    .insert(schema.jobs)
    .values({
      jobType: params.jobType,
      queueName: params.queueName,
      status: "running",
      payload: params.payload,
      startedAt: new Date(),
    })
    .returning();
  if (!job) throw new Error("failed to create jobs row");

  const startedAt = Date.now();

  try {
    const { result, attempts } = await withRetry(params.execute, {
      maxAttempts: params.maxAttempts ?? 3,
      baseDelayMs: 200,
      isRetryable: RETRYABLE,
      sleep: params.sleep,
    });

    const latencyMs = Date.now() - startedAt;

    await db
      .update(schema.jobs)
      .set({
        status: "succeeded",
        result,
        attempts,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));

    await recordProviderSuccess(db, {
      providerName: params.providerName,
      providerType: params.providerType,
      latencyMs,
    });

    return { jobId: job.id, status: "succeeded", attempts, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = params.maxAttempts ?? 3;

    await db
      .update(schema.jobs)
      .set({
        status: "failed",
        error: message,
        attempts,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));

    await recordProviderFailure(db, {
      providerName: params.providerName,
      providerType: params.providerType,
      errorMessage: message,
      status: error instanceof ProviderRateLimitError ? "degraded" : "down",
    });

    return { jobId: job.id, status: "failed", attempts, error: message };
  }
}
