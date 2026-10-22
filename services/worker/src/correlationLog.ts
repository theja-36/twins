import { newCorrelationId, parseCorrelationContext, type LogFields } from "@twins/shared";

/** Minimal job shape needed for log context (real BullMQ jobs and test doubles both satisfy it). */
export interface LoggableJob {
  id?: string | undefined;
  data?: unknown;
  attemptsMade?: number;
  attemptsStarted?: number;
  opts?: { attempts?: number };
}

/**
 * Builds the per-job log context. The correlation id is the one CARRIED in the job payload
 * (so every retry of that job reuses it); legacy jobs queued without metadata (or with
 * malformed metadata) are still processed and get a worker-generated id, flagged as such.
 * `attempt` is the 1-based processing attempt (BullMQ attemptsStarted).
 */
export function buildJobLogContext(job: LoggableJob, fallbackCorrelationId?: string): LogFields {
  const data = job.data as
    | { correlation?: unknown; telegram?: { normalizedMessage?: { channelIdentifier?: unknown; externalMessageId?: unknown; originMessageId?: unknown } } }
    | undefined;
  const carried = parseCorrelationContext(data?.correlation);
  const msg = data?.telegram?.normalizedMessage;
  const attempt = job.attemptsStarted ?? (job.attemptsMade ?? 0) + 1;
  return {
    correlationId: carried?.correlationId ?? fallbackCorrelationId ?? newCorrelationId(),
    correlationOrigin: carried ? "job" : "worker-generated",
    ...(carried ? { intakeRequestId: carried.requestId, intakeReceivedAt: carried.receivedAt } : {}),
    jobId: job.id ?? "unknown",
    attempt,
    ...(job.opts?.attempts !== undefined ? { maxAttempts: job.opts.attempts } : {}),
    ...(typeof msg?.channelIdentifier === "string" ? { channelIdentifier: msg.channelIdentifier } : {}),
    ...(typeof msg?.externalMessageId === "string" ? { externalMessageId: msg.externalMessageId } : {}),
    ...(typeof msg?.originMessageId === "string" ? { originMessageId: msg.originMessageId } : {}),
  };
}
