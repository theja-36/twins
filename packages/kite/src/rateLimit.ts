import type { RateClass } from "./allowlist";

/** Documented Kite Connect limits: quote 1 req/s, historical 3 req/s, everything else 10 req/s. Spacing is deliberately conservative. */
export const RATE_PER_SECOND: Record<RateClass, number> = { quote: 1, historical: 3, default: 10 };

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Serialises callers per class and spaces them by 1000/rate ms. Deterministic under an injected clock. */
export class RateLimiter {
  private readonly next: Record<RateClass, number> = { quote: 0, historical: 0, default: 0 };
  private readonly chain: Record<RateClass, Promise<void>> = { quote: Promise.resolve(), historical: Promise.resolve(), default: Promise.resolve() };
  constructor(private readonly clock: Clock = systemClock, private readonly rates: Record<RateClass, number> = RATE_PER_SECOND) {}

  acquire(cls: RateClass): Promise<void> {
    const run = this.chain[cls].then(async () => {
      const wait = this.next[cls] - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.next[cls] = this.clock.now() + 1000 / this.rates[cls];
    });
    this.chain[cls] = run.catch(() => undefined);
    return run;
  }
}
