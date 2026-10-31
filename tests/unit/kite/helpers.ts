import { readFileSync } from "node:fs";
import { parseInstrumentsCsv } from "../../../packages/kite/src/index";
import { DEFAULT_AGENT_RULES } from "../../../packages/agents/src/index";
import { getFullQuotes, KiteClient, loadKiteWiringConfig, RateLimiter, restSource, Session, type Clock, type QuoteSource } from "../../../packages/kite/src/index";

export const API_KEY = "testkey12345";
export const API_SECRET = "testsecret67890";
export const REQUEST_TOKEN = "reqtok1234567890";
export const ACCESS_TOKEN = "acc_token_0123456789abcdef";
export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/kite/${name}`, import.meta.url), "utf8"));
export const catalog = () => parseInstrumentsCsv(csv());
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
export function clientWith(responses: Parameters<typeof fakeFetch>[0], over: Partial<ConstructorParameters<typeof KiteClient>[0]> = {}): { client: KiteClient; session: Session; calls: Call[]; clock: ReturnType<typeof instantClock> } {
  const { fetch: f, calls } = fakeFetch(responses);
  const session = new Session(() => new Date("2026-11-02T04:00:00Z"));
  const clock = instantClock();
  const client = new KiteClient({ apiKey: API_KEY, apiSecret: API_SECRET, session, fetch: f, limiter: new RateLimiter(clock), clock, maxRetries: 0, ...over });
  return { client, session, calls, clock };
}

export const NOW_MS = Date.parse("2026-11-02T10:16:00.000Z");
const quotesData = (): Record<string, unknown> => ({ ...((fixture("b-quotes.json") as { data: Record<string, unknown> }).data) });

/** A REST source over the b-quotes fixture, fetched through the real client (fake fetch). `drop` removes keys from the response; `edit` changes entries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rest(o: { drop?: string[]; edit?: (d: Record<string, any>) => void; maxAgeMs?: number; now?: number } = {}): Promise<QuoteSource> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = quotesData() as Record<string, any>;
  for (const k of o.drop ?? []) delete data[k];
  o.edit?.(data);
  const { client, session } = clientWith([ok(data)]);
  session.setToken(ACCESS_TOKEN);
  const batch = await getFullQuotes(client, catalog().instruments, () => new Date("2026-11-02T10:16:00.000Z"));
  return restSource(batch, { now: () => o.now ?? NOW_MS, maxAgeMs: o.maxAgeMs ?? 60_000, futureToleranceMs: WIRING.futureToleranceMs });
}

/** The validated wiring configuration with every default (product rules + unapproved placeholders). */
export const WIRING = loadKiteWiringConfig(DEFAULT_AGENT_RULES, {});
