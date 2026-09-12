import { describe, expect, it } from "vitest";
import { withRetry } from "../../../packages/shared/src/retry";

describe("withRetry", () => {
  it("returns on the first success without retrying", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries a retryable error up to maxAttempts then throws", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("transient");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          isRetryable: () => true,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow("transient");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]); // exponential backoff, one fewer sleep than attempts
  });

  it("does not retry when isRetryable returns false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        { maxAttempts: 5, isRetryable: () => false },
      ),
    ).rejects.toThrow("permanent");
    expect(calls).toBe(1);
  });

  it("succeeds on a later attempt after transient failures", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "recovered";
      },
      { maxAttempts: 5, isRetryable: () => true, sleep: async () => {} },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });
});
