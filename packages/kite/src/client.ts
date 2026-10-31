import { classify, rateClassOf } from "./allowlist";
import { KiteError } from "./errors";
import { RateLimiter, systemClock, type Clock } from "./rateLimit";
import { redact } from "./redact";
import { computeChecksum, Session } from "./session";

const PRODUCTION_BASE = "https://api.kite.trade";
const REQUEST_TOKEN = /^[A-Za-z0-9]{8,64}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export interface KiteClientOptions {
  apiKey: string;
  /** Needed only for the request_token exchange. */
  apiSecret?: string;
  session: Session;
  fetch?: typeof fetch;
  /** Tests only: a loopback http URL. Anything else must be the production host. */
  baseUrl?: string;
  limiter?: RateLimiter;
  timeoutMs?: number;
  maxBytes?: number;
  /** Retries for SAFE READS only (GET), for network errors, timeouts, 5xx and 429. Default 2; 0 disables. Never applied to the token exchange. */
  maxRetries?: number;
  /** First back-off in ms (doubles each retry; a Retry-After header is honoured, capped at 5 s). */
  backoffMs?: number;
  clock?: Clock;
}

const RETRYABLE = new Set(["NETWORK", "TIMEOUT", "SERVER_ERROR", "RATE_LIMITED"]);
const MAX_RETRY_WAIT_MS = 5000;
const TEST_CREDENTIAL = /^test/i;

type Query = Record<string, string | number | readonly (string | number)[]>;

export class KiteClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly clock: Clock;

  constructor(private readonly o: KiteClientOptions) {
    const base = o.baseUrl ?? PRODUCTION_BASE;
    if (base !== PRODUCTION_BASE && !/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(base)) throw new KiteError("CONFIG");
    // a loopback transport (tests) must never receive real credentials: only obviously-fake ones are accepted there
    if (base !== PRODUCTION_BASE && (!TEST_CREDENTIAL.test(o.apiKey) || (o.apiSecret !== undefined && !TEST_CREDENTIAL.test(o.apiSecret)))) throw new KiteError("CONFIG");
    this.maxRetries = Math.min(Math.max(o.maxRetries ?? 2, 0), 5);
    this.backoffMs = o.backoffMs ?? 250;
    this.clock = o.clock ?? systemClock;
    this.base = base;
    this.doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.limiter = o.limiter ?? new RateLimiter();
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
  }

  /** GET a read-only endpoint and return `data` of a `{status:"success"}` envelope. */
  async getJson<T = unknown>(path: string, query: Query = {}): Promise<T> {
    const body = await this.send("GET", path, query);
    const parsed = this.parseEnvelope(body);
    return parsed.data as T;
  }

  /** GET a read-only endpoint that returns text (the instruments CSV). */
  async getText(path: string, query: Query = {}): Promise<string> {
    return this.send("GET", path, query, true);
  }

  /** Asks the SERVER whether the held token works. The only way a session becomes "verified". */
  async verifySession(): Promise<void> {
    await this.getJson("/user/profile");
    this.o.session.markVerified();
  }

  /** The documented exchange: POST /session/token with api_key, request_token, checksum. The one authentication exception to the read-only rule. */
  async exchangeRequestToken(requestToken: string): Promise<void> {
    if (!this.o.apiSecret || !REQUEST_TOKEN.test(requestToken)) throw new KiteError("CONFIG");
    const form = new URLSearchParams({ api_key: this.o.apiKey, request_token: requestToken, checksum: computeChecksum(this.o.apiKey, requestToken, this.o.apiSecret) });
    const body = await this.send("POST", "/session/token", {}, false, form.toString(), [requestToken, this.o.apiSecret]);
    const data = this.parseEnvelope(body).data as { access_token?: unknown; api_key?: unknown } | null;
    const token = data?.access_token;
    if (typeof token !== "string" || !ACCESS_TOKEN.test(token) || (data?.api_key !== undefined && data.api_key !== this.o.apiKey)) throw new KiteError("AUTH_FAILED");
    this.o.session.setToken(token); // unverified until a server call succeeds
  }

  private parseEnvelope(text: string): { data: unknown } {
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new KiteError("MALFORMED_RESPONSE"); }
    const env = json as { status?: unknown; data?: unknown } | null;
    if (!env || typeof env !== "object" || env.status !== "success" || !("data" in env)) throw new KiteError("MALFORMED_RESPONSE");
    return { data: env.data };
  }

  private async send(method: string, path: string, query: Query, text = false, body?: string, extraSecrets: readonly string[] = []): Promise<string> {
    const kind = classify(method, path); // refuses before anything else happens
    if (kind === "auth") return this.once(kind, method, path, query, text, body, extraSecrets); // the token exchange is never retried
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(kind, method, path, query, text, body, extraSecrets);
      } catch (e) {
        // authentication failures (SESSION_INVALID, NO_SESSION) and every non-transient error stop immediately
        if (!(e instanceof KiteError) || !RETRYABLE.has(e.code) || attempt >= this.maxRetries) throw e;
        const wait = Math.min(e.detail.retryAfterMs ?? this.backoffMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
        await this.clock.sleep(wait);
        if (this.o.session.state().status === "invalid") throw new KiteError("SESSION_INVALID"); // invalidated by a concurrent call while waiting
      }
    }
  }

  private async once(kind: "read" | "auth", method: string, path: string, query: Query, text: boolean, body: string | undefined, extraSecrets: readonly string[]): Promise<string> {
    const headers: Record<string, string> = { "X-Kite-Version": "3", Accept: text ? "text/csv, application/json" : "application/json" };
    if (kind === "read") {
      const token = this.o.session.usableToken();
      if (!token) throw new KiteError(this.o.session.state().status === "invalid" ? "SESSION_INVALID" : "NO_SESSION");
      headers["Authorization"] = `token ${this.o.apiKey}:${token}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    const secrets = [...this.o.session.secrets(), this.o.apiKey, ...(this.o.apiSecret ? [this.o.apiSecret] : []), ...extraSecrets];

    await this.limiter.acquire(rateClassOf(path));
    let res: Response;
    try {
      res = await this.doFetch(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new KiteError((e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "NETWORK");
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) throw new KiteError("RESPONSE_TOO_LARGE", { status: res.status });
    const raw = await res.text().catch(() => { throw new KiteError("NETWORK"); });
    if (raw.length > this.maxBytes) throw new KiteError("RESPONSE_TOO_LARGE", { status: res.status });

    if (res.ok && !(text && raw.trimStart().startsWith("{"))) return raw;
    // error path (also an HTTP-200 JSON body where a CSV was expected)
    let errorType: string | undefined;
    let message: string | undefined;
    try {
      const j = JSON.parse(raw) as { status?: unknown; error_type?: unknown; message?: unknown };
      if (typeof j.error_type === "string") errorType = j.error_type.slice(0, 40);
      if (typeof j.message === "string") message = redact(j.message, secrets);
      if (res.ok && j.status !== "error") throw new KiteError("MALFORMED_RESPONSE", { status: res.status });
    } catch (e) { if (e instanceof KiteError) throw e; }
    const retryAfter = Number(res.headers.get("retry-after"));
    const detail = { status: res.status, ...(errorType ? { errorType } : {}), ...(message ? { serverMessage: message } : {}), ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
    if (kind === "auth") throw new KiteError("AUTH_FAILED", detail);
    if (res.status === 403 || errorType === "TokenException") { this.o.session.markInvalid(); throw new KiteError("SESSION_INVALID", detail); }
    if (res.status === 429) throw new KiteError("RATE_LIMITED", detail);
    if (res.status >= 500 || errorType === "NetworkException" || errorType === "GeneralException") throw new KiteError("SERVER_ERROR", detail);
    if (res.status >= 400) throw new KiteError("BAD_REQUEST", detail);
    throw new KiteError("MALFORMED_RESPONSE", detail);
  }
}
