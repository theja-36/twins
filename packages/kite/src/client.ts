import { classify, rateClassOf } from "./allowlist";
import { KiteError } from "./errors";
import { RateLimiter } from "./rateLimit";
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
}

type Query = Record<string, string | number | readonly (string | number)[]>;

export class KiteClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly o: KiteClientOptions) {
    const base = o.baseUrl ?? PRODUCTION_BASE;
    if (base !== PRODUCTION_BASE && !/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(base)) throw new KiteError("CONFIG");
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
    const detail = { status: res.status, ...(errorType ? { errorType } : {}), ...(message ? { serverMessage: message } : {}) };
    if (kind === "auth") throw new KiteError("AUTH_FAILED", detail);
    if (res.status === 403 || errorType === "TokenException") { this.o.session.markInvalid(); throw new KiteError("SESSION_INVALID", detail); }
    if (res.status === 429) throw new KiteError("RATE_LIMITED", detail);
    if (res.status >= 500 || errorType === "NetworkException" || errorType === "GeneralException") throw new KiteError("SERVER_ERROR", detail);
    if (res.status >= 400) throw new KiteError("BAD_REQUEST", detail);
    throw new KiteError("MALFORMED_RESPONSE", detail);
  }
}
