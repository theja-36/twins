import { Worker, type Job } from "bullmq";
import type { StructuredLogger } from "@twins/shared";
import { SafetyRefusalError } from "@twins/runtime-state";

/** How long the worker stops taking jobs after a safety refusal (BullMQ then retries the waiting job). */
export const INTAKE_PAUSE_MS = 5000;

export interface IntakeGateOptions {
  pauseMs?: number;
  logger?: StructuredLogger;
}

/**
 * Wraps a queue handler so a SAFETY REFUSAL (intake disabled, kill switch active, state unreadable) is never a job failure.
 *
 * Without this, a refusal thrown inside the handler would consume one of the job's attempts; three refusals during an outage or a pause
 * would dead-letter a captured message and lose it. BullMQ's documented mechanism is used instead: the worker is rate-limited for
 * `pauseMs` and the job is moved back to "waiting" WITHOUT consuming an attempt (Worker.RateLimitError). Every other error is rethrown
 * unchanged, so normal attempts/backoff apply to real failures.
 */
export function withIntakeGate<T>(
  handler: (job: Job<T>) => Promise<void>,
  getWorker: () => Pick<Worker, "rateLimit"> | null,
  options: IntakeGateOptions = {},
): (job: Job<T>) => Promise<void> {
  const pauseMs = options.pauseMs ?? INTAKE_PAUSE_MS;
  return async (job) => {
    try {
      await handler(job);
    } catch (error) {
      if (!(error instanceof SafetyRefusalError)) throw error;
      options.logger?.warn("worker.intake.paused", { reason: error.reason, operation: error.operation, jobId: job.id, pauseMs });
      const worker = getWorker();
      if (!worker) throw error; // no worker handle (tests that call the handler directly): surface the refusal
      await worker.rateLimit(pauseMs);
      throw Worker.RateLimitError();
    }
  };
}
