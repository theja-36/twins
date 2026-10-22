/**
 * Explicitly configured HTTPS transport for the GDELT DOC article-list endpoint. It is NOT created, registered or enabled
 * anywhere by default: a caller must construct it and pass it to GdeltNewsAdapter. It fetches only the fixed DOC API
 * endpoint on the allowlisted host - never an article page.
 *
 * Safety properties (all enforced here, tested offline):
 *  - https only, host must be in the fixed allowlist, validated BEFORE any request;
 *  - query parameters are URL-encoded by URLSearchParams;
 *  - redirects are never followed (a 3xx is a failure);
 *  - one overall timeout covers connect, headers AND body reading;
 *  - the body is read as a stream and abandoned the moment it exceeds the byte bound (Content-Length is checked first);
 *  - bounded retry with exponential backoff for 429/5xx/network errors, honouring Retry-After up to a cap;
 *  - errors and logs never contain the query, the URL, headers or any response body.
 * The DOC API parameter names used (query, mode, format, maxrecords, sort, startdatetime) and their value spellings (mode=ArtList, format=JSON, sort=DateDesc, startdatetime=YYYYMMDDHHMMSS) follow the official DOC 2.0
 * documentation page. They are UNVERIFIED against a real response: the one real check ended in an HTTP 429.
 */
import { withRetry } from "@twins/shared";
import { ProviderDataError, ProviderRateLimitError, ProviderUnavailableError } from "@twins/types";
import { GDELT_PROVIDER_NAME, type GdeltTransport } from "./gdelt.js";

export const GDELT_DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_ALLOWED_HOSTS: readonly string[] = ["api.gdeltproject.org"];
export const GDELT_HARD_MAX_RECORDS = 250;

export interface GdeltHttpTransportOptions {
  /** Defaults to the official DOC endpoint. Must be https and on the allowlist. */
  endpoint?: string;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Retry-After longer than this is not waited for; the call fails instead. */
  maxRetryAfterMs?: number;
  /** Injectable for tests (mock or loopback-rewriting fetch). Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const gdeltDateTime = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

class RetryableHttp extends ProviderUnavailableError {}
class RateLimited extends ProviderRateLimitError {}

export function createGdeltHttpTransport(options: GdeltHttpTransportOptions = {}): GdeltTransport {
  const endpoint = new URL(options.endpoint ?? GDELT_DOC_ENDPOINT);
  const allowed = options.allowedHosts ?? GDELT_ALLOWED_HOSTS;
  if (endpoint.protocol !== "https:") throw new Error("GDELT transport: the endpoint must be https");
  if (endpoint.username || endpoint.password) throw new Error("GDELT transport: credentials in the endpoint are not allowed");
  if (!allowed.includes(endpoint.hostname)) throw new Error(`GDELT transport: host "${endpoint.hostname}" is not on the allowlist`);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxResponseBytes ?? 5_000_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = options.now ?? (() => Date.now());

  async function once(request: { query: string; since?: Date | undefined; maxRecords: number }): Promise<{ status: number; bodyText: string }> {
    const url = new URL(endpoint.toString());
    url.searchParams.set("query", request.query);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "JSON");
    url.searchParams.set("sort", "DateDesc");
    url.searchParams.set("maxrecords", String(Math.min(Math.max(1, Math.floor(request.maxRecords)), GDELT_HARD_MAX_RECORDS)));
    if (request.since) url.searchParams.set("startdatetime", gdeltDateTime(request.since));
    // Re-validate the final URL: query parameters can never change scheme or host, but this is checked rather than assumed.
    if (url.protocol !== "https:" || !allowed.includes(url.hostname)) throw new ProviderDataError(GDELT_PROVIDER_NAME, "refusing a request outside the allowlist");

    let res: Response;
    try {
      res = await fetchFn(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new RetryableHttp(GDELT_PROVIDER_NAME, timedOut ? `request timed out after ${timeoutMs}ms` : "network error", cause);
    }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => undefined); throw new ProviderDataError(GDELT_PROVIDER_NAME, "redirect refused (redirects are not followed)"); }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      throw new RateLimited(GDELT_PROVIDER_NAME, parseRetryAfterMs(res.headers.get("retry-after"), nowMs()));
    }
    if (res.status >= 500) { await res.body?.cancel().catch(() => undefined); throw new RetryableHttp(GDELT_PROVIDER_NAME, `HTTP ${res.status}`); }
    if (res.status < 200 || res.status >= 300) { await res.body?.cancel().catch(() => undefined); throw new ProviderUnavailableError(GDELT_PROVIDER_NAME, `HTTP ${res.status}`); }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel().catch(() => undefined); throw new ProviderDataError(GDELT_PROVIDER_NAME, `declared response size exceeds the ${maxBytes}-byte bound`); }
    if (!res.body) return { status: res.status, bodyText: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new ProviderDataError(GDELT_PROVIDER_NAME, `response exceeded the ${maxBytes}-byte bound while streaming; remaining bytes were not read`); }
        chunks.push(value);
      }
    } catch (cause) {
      if (cause instanceof ProviderDataError) throw cause;
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new RetryableHttp(GDELT_PROVIDER_NAME, timedOut ? `request timed out after ${timeoutMs}ms while reading` : "network error while reading", cause);
    }
    return { status: res.status, bodyText: new TextDecoder("utf-8").decode(Buffer.concat(chunks)) };
  }

  return async (request) => {
    let lastRetryAfterMs = 0;
    const { result } = await withRetry(
      async () => {
        try {
          return await once(request);
        } catch (err) {
          lastRetryAfterMs = err instanceof RateLimited ? err.retryAfterMs ?? 0 : 0;
          throw err;
        }
      },
      {
        maxAttempts,
        baseDelayMs,
        // A Retry-After beyond the cap is not waited for: the failure surfaces instead.
        isRetryable: (e) => (e instanceof RetryableHttp) || (e instanceof RateLimited && (e.retryAfterMs ?? 0) <= maxRetryAfterMs),
        sleep: (ms) => sleep(Math.max(ms, lastRetryAfterMs)),
      },
    );
    return result;
  };
}
