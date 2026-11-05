/**
 * The ONLY way the provider exporters touch the network. A fetcher is bound to an allow-list of https hosts, spaces its requests (providers publish rate limits), retries 429 / 5xx a
 * bounded number of times honouring Retry-After, refuses redirects, caps the response size and the time, and NEVER puts the URL (which can carry an API key) into an error: errors carry a
 * fixed code and, for HTTP, the status.
 */
export type FetchErrorCode = "bad_url" | "not_https" | "host_not_allowed" | "redirect" | "rate_limited" | "http_error" | "too_large" | "timeout" | "network";
export class ProviderFetchError extends Error {
  constructor(readonly code: FetchErrorCode, readonly status?: number) { super(status === undefined ? code : `${code}:${status}`); this.name = "ProviderFetchError"; }
}

export interface FetcherOptions {
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Minimum time between the START of two requests (the provider's published limit). */
  minIntervalMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** A Retry-After longer than this is not waited for: the call fails with `rate_limited`. */
  maxRetryAfterMs?: number;
  userAgent?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export type Fetcher = (url: string) => Promise<string>;

export function createRateGate(minIntervalMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): () => Promise<void> {
  let next = 0;
  return async () => {
    const t = now();
    const start = Math.max(t, next);
    next = start + minIntervalMs;
    if (start > t) await sleep(start - t);
  };
}

const retryAfterMs = (h: string | null, nowMs: number): number | undefined => {
  if (!h) return undefined;
  if (/^\d{1,6}$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
};

export function createFetcher(o: FetcherOptions): Fetcher {
  const timeoutMs = o.timeoutMs ?? 15_000, maxBytes = o.maxBytes ?? 5_000_000, maxAttempts = Math.max(1, o.maxAttempts ?? 3), baseDelayMs = o.baseDelayMs ?? 500, maxRetryAfterMs = o.maxRetryAfterMs ?? 30_000;
  const fetchFn = o.fetchFn ?? globalThis.fetch, now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gate = createRateGate(o.minIntervalMs ?? 0, now, sleep);
  const headers = { "user-agent": o.userAgent ?? "twins-provider-exporter/1 (read-only data export)", accept: "application/json, text/csv;q=0.9, */*;q=0.1" };

  async function once(url: string): Promise<{ status: number; body: string; retryAfter: number | undefined }> {
    await gate();
    let res: Response;
    try { res = await fetchFn(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new ProviderFetchError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network"); }
    const ra = retryAfterMs(res.headers.get("retry-after"), now());
    if (res.status >= 300 && res.status < 400) throw new ProviderFetchError("redirect", res.status);
    if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status, body: "", retryAfter: ra }; }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new ProviderFetchError("too_large"); }
    const reader = res.body?.getReader();
    if (!reader) return { status: 200, body: await res.text(), retryAfter: ra };
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new ProviderFetchError("too_large"); }
        chunks.push(value);
      }
    } catch (e) { if (e instanceof ProviderFetchError) throw e; throw new ProviderFetchError("network"); }
    return { status: 200, body: new TextDecoder().decode(Buffer.concat(chunks)), retryAfter: ra };
  }

  return async (rawUrl: string): Promise<string> => {
    let u: URL;
    try { u = new URL(rawUrl); } catch { throw new ProviderFetchError("bad_url"); }
    if (u.protocol !== "https:") throw new ProviderFetchError("not_https");
    if (u.username || u.password || u.port !== "" || !o.allowedHosts.includes(u.hostname)) throw new ProviderFetchError("host_not_allowed");
    let last: ProviderFetchError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const r = await once(rawUrl);
        if (r.status === 200) return r.body;
        if (r.status === 429) {
          last = new ProviderFetchError("rate_limited", 429);
          if (attempt === maxAttempts || (r.retryAfter !== undefined && r.retryAfter > maxRetryAfterMs)) throw last;
          await sleep(r.retryAfter ?? Math.max(baseDelayMs * 2 ** attempt, o.minIntervalMs ?? 0));
          continue;
        }
        if (r.status >= 500) { last = new ProviderFetchError("http_error", r.status); if (attempt === maxAttempts) throw last; await sleep(baseDelayMs * 2 ** (attempt - 1)); continue; }
        throw new ProviderFetchError("http_error", r.status);
      } catch (e) {
        if (e instanceof ProviderFetchError && (e.code === "network" || e.code === "timeout") && attempt < maxAttempts) { last = e; await sleep(baseDelayMs * 2 ** (attempt - 1)); continue; }
        throw e;
      }
    }
    throw last ?? new ProviderFetchError("network");
  };
}
