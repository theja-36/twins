/**
 * Bounded retry with exponential backoff for transient provider failures
 * (spec section 45). Retries are capped - a failing provider must
 * eventually surface as a recorded failure, never retry forever and
 * never silently become an empty success (spec section 45: "Do not
 * convert a failed provider request into an empty successful result").
 */
export interface RetryOptions {
  /** Total attempts including the first, e.g. 3 = 1 try + 2 retries. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Doubles each subsequent attempt. Default 200. */
  baseDelayMs?: number;
  /** Decides whether a given error is worth retrying. Default: only transient provider errors. */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const isRetryable = options.isRetryable ?? (() => false);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const attemptsRemaining = maxAttempts - attempt;
      if (attemptsRemaining <= 0 || !isRetryable(error)) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  // Unreachable, but keeps TypeScript's control-flow analysis happy.
  throw lastError;
}
