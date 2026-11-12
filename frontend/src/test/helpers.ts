import type { BffConfig } from "@/bff/config";
import { WindowCounter } from "@/bff/throttle";

export const ORIGIN = "https://desk.example.test";
export const TOKEN = `tws_${"A".repeat(43)}`;
export const CSRF = "B".repeat(43);
export const cfgHost = (o: Partial<BffConfig> = {}): BffConfig => ({ apiBase: "http://api.invalid:3000", cookieMode: "host", publicOrigin: ORIGIN, trustProxyHeader: "x-forwarded-for", gallery: false, ...o });
export const cfgDev = (o: Partial<BffConfig> = {}): BffConfig => ({ apiBase: "http://api.invalid:3000", cookieMode: "dev", publicOrigin: null, trustProxyHeader: null, gallery: false, ...o });
export const counters = () => ({ attempts: new WindowCounter({ max: 30, windowMs: 600_000 }), failures: new WindowCounter({ max: 5, windowMs: 600_000 }) });

export interface Seen { url: string; method: string; headers: Record<string, string>; body: string | null }
/** A fetch double that records every upstream call and answers from a queue (or a function). */
export function fakeFetch(answer: (u: Seen) => { status: number; body?: unknown } | Error) {
  const seen: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const s: Seen = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null }; seen.push(s);
    const a = answer(s); if (a instanceof Error) throw a;
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? null), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, seen };
}
export const USER = { id: "u-1", email: "trader@example.test", displayName: "Alex", role: "TRADER" as const, isActive: true };
export const ADMIN = { ...USER, id: "u-2", email: "admin@example.test", role: "ADMIN" as const };
export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
export function get(path: string, headers: Record<string, string> = {}): Request { return new Request(`${ORIGIN}${path}`, { method: "GET", headers }); }
export const sessionCookie = `__Host-twins_session=${TOKEN}; __Host-twins_csrf=${CSRF}`;
export const devCookie = `twins_session=${TOKEN}; twins_csrf=${CSRF}`;
export function setCookies(res: Response): string[] { return res.headers.getSetCookie(); }
