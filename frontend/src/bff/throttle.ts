/**
 * Per-IP login throttling in memory (one frontend instance; documented limit). The backend locks per EMAIL after 5 failures, which lets anyone lock a known user out;
 * this throttle limits how fast ONE source can try, so a single client cannot exhaust an account's attempts alone. Responses to the browser stay neutral.
 * Bounded: the table never holds more than `maxKeys` entries (oldest evicted), so it cannot be used to exhaust memory.
 */
export interface Limit { max: number; windowMs: number }
export class WindowCounter {
  private readonly hits = new Map<string, { n: number; start: number }>();
  constructor(private readonly limit: Limit, private readonly maxKeys = 10_000, private readonly now: () => number = Date.now) {}
  private fresh(key: string): { n: number; start: number } | undefined { const h = this.hits.get(key); if (h && this.now() - h.start >= this.limit.windowMs) { this.hits.delete(key); return undefined; } return h; }
  /** true when the key may proceed (and counts this attempt). */
  hit(key: string): boolean {
    const h = this.fresh(key);
    if (!h) { if (this.hits.size >= this.maxKeys) { const oldest = this.hits.keys().next().value; if (oldest !== undefined) this.hits.delete(oldest); } this.hits.set(key, { n: 1, start: this.now() }); return true; }
    h.n += 1; return h.n <= this.limit.max;
  }
  blocked(key: string): boolean { const h = this.fresh(key); return !!h && h.n >= this.limit.max; }
  reset(key: string): void { this.hits.delete(key); }
  size(): number { return this.hits.size; }
}
/** The address the TRUSTED proxy reports (rightmost entry = the one the proxy added); anything malformed collapses into one shared bucket. */
export function clientKey(req: Request, header: string | null): string {
  if (!header) return "shared";
  const v = req.headers.get(header); if (!v) return "shared";
  const last = v.split(",").pop()?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : "shared";
}
export const loginAttempts = new WindowCounter({ max: 30, windowMs: 10 * 60_000 });
export const loginFailures = new WindowCounter({ max: 5, windowMs: 10 * 60_000 });
