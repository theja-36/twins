import { readFileSync } from "node:fs";
import { KiteClient, RateLimiter, Session, type Clock } from "../../../packages/kite/src/index";

export const API_KEY = "testkey12345";
export const API_SECRET = "testsecret67890";
export const REQUEST_TOKEN = "reqtok1234567890";
export const ACCESS_TOKEN = "acc_token_0123456789abcdef";
export const csv = (): string => readFileSync(new URL("../../fixtures/kite/instruments.synthetic.csv", import.meta.url), "utf8");

export interface Call { url: string; init: RequestInit }
export function fakeFetch(responses: Array<Response | Error | ((c: Call) => Response)>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const f = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const ok = (data: unknown): Response => json({ status: "success", data });

export function instantClock(): Clock & { t: number; sleeps: number[] } {
  const c = { t: 1_000_000, sleeps: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; } };
  return c;
}
export function clientWith(responses: Parameters<typeof fakeFetch>[0], over: Partial<ConstructorParameters<typeof KiteClient>[0]> = {}): { client: KiteClient; session: Session; calls: Call[] } {
  const { fetch: f, calls } = fakeFetch(responses);
  const session = new Session(() => new Date("2026-11-02T04:00:00Z"));
  const client = new KiteClient({ apiKey: API_KEY, apiSecret: API_SECRET, session, fetch: f, limiter: new RateLimiter(instantClock()), ...over });
  return { client, session, calls };
}
