import type { StructuredLogger } from "@twins/shared";

export interface StartCounter {
  /** Increment `key` and (re)start its expiry; returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * Crash/restart-loop detection without a supervisor: every process start increments a counter that expires after `windowSeconds`; the third start
 * inside the window raises `process.restart_loop` (-> CRITICAL alert). Best effort: if the counter store is down the start is simply not counted.
 */
export async function recordProcessStart(counter: StartCounter, service: string, logger: StructuredLogger, options: { threshold?: number; windowSeconds?: number } = {}): Promise<number> {
  const threshold = options.threshold ?? 3;
  const windowSeconds = options.windowSeconds ?? 600;
  try {
    const n = await counter.incr(`twins:starts:${service}`, windowSeconds);
    if (n >= threshold) logger.error("process.restart_loop", { service, restarts: n, windowSeconds });
    return n;
  } catch {
    return 0;
  }
}
