/**
 * T6: bounded producer behaviour of the webhook enqueue. Controlled dependencies only (a closed loopback port
 * for "Redis never ready"; fakes with BullMQ's jobId semantics). NOT an infrastructure outage drill.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENQUEUE_TIMEOUT_MS,
  buildApp,
  isDependencyUnavailable,
  resolveEnqueueTimeoutMs,
} from "../../../apps/api/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const API_KEY = "bound-api-key-77";
const SECRET = "bound-secret-31";
const headers = { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET };
const update = (id = 5) => ({ update_id: id, message: { message_id: id, date: 1700000000, chat: { id: -100777, type: "channel" }, text: "BUY X @ 10 SL 9 TGT 12" } });
const GENERIC_503 = { statusCode: 503, error: "Service Unavailable", message: "Service Unavailable" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function app(queue: unknown, enqueueTimeoutMs = 300) {
  const records: LogRecord[] = [];
  const instance = await buildApp({
    apiKey: API_KEY, telegramWebhookSecret: SECRET, db: {} as never, logger: false, enqueueTimeoutMs,
    ...(queue ? { telegramQueue: queue as never } : {}),
    structuredLogger: createStructuredLogger((r) => records.push(r)),
  });
  const post = async (payload = update()) => {
    const t0 = Date.now();
    const res = await instance.inject({ method: "POST", url: "/webhooks/telegram", headers, payload: JSON.stringify(payload) });
    return { res, ms: Date.now() - t0 };
  };
  return { instance, records, post };
}
const events = (r: LogRecord[]) => r.map((x) => x.event);

describe("bound configuration (fail-closed)", () => {
  it("defaults to 3000 ms and accepts 250-30000", () => {
    expect(resolveEnqueueTimeoutMs(undefined, undefined)).toBe(DEFAULT_ENQUEUE_TIMEOUT_MS);
    expect(DEFAULT_ENQUEUE_TIMEOUT_MS).toBe(3000);
    expect(resolveEnqueueTimeoutMs(undefined, "1500")).toBe(1500);
    expect(resolveEnqueueTimeoutMs(250, "9999")).toBe(250); // explicit option wins over env
    expect(resolveEnqueueTimeoutMs(30000, undefined)).toBe(30000);
  });
  it.each([[100, undefined], [99_999, undefined], [Number.NaN, undefined], [undefined, "abc"], [undefined, "-5"]])(
    "rejects out-of-range or non-numeric values (%s / %s) at startup",
    async (opt, env) => {
      expect(() => resolveEnqueueTimeoutMs(opt, env)).toThrow(/TWINS_ENQUEUE_TIMEOUT_MS/);
    },
  );
  it("buildApp refuses to start with an invalid bound", async () => {
    await expect(buildApp({ apiKey: API_KEY, telegramWebhookSecret: SECRET, db: {} as never, logger: false, enqueueTimeoutMs: 10, telegramQueue: { add: vi.fn() } as never })).rejects.toThrow(/between 250 and 30000/);
  });
});

describe("connectivity classification", () => {
  it.each([
    [Object.assign(new Error("x"), { name: "MaxRetriesPerRequestError" }), true],
    [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), true],
    [Object.assign(new Error("Connection is closed."), {}), true],
    [new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })], "x"), true],
    [new Error("some programming error"), false],
    [Object.assign(new Error("x"), { code: "ENQUEUE_FAILED" }), false],
    ["string", false], [null, false],
  ])("%#", (err, expected) => expect(isDependencyUnavailable(err)).toBe(expected));
});

describe("Redis never becomes ready (real client + BullMQ queue against a closed local port)", () => {
  it("every valid webhook gets a prompt generic 503 (nothing submitted), never 202 and never a hang; shutdown is bounded", async () => {
    const saved = process.env["REDIS_URL"];
    process.env["REDIS_URL"] = "redis://127.0.0.1:1";
    let ctx: Awaited<ReturnType<typeof app>> | undefined;
    try {
      ctx = await app(undefined, 400);
      const results = await Promise.all([ctx.post(update(1)), ctx.post(update(2)), ctx.post(update(3))]);
      for (const { res, ms } of results) {
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual(GENERIC_503);
        expect(ms).toBeLessThan(1500); // bound 400 ms + scheduling, nowhere near indefinite
      }
      const bodies = results.map((r) => r.res.body).join("");
      for (const leak of ["ECONNREFUSED", "127.0.0.1", "redis://"]) expect(bodies).not.toContain(leak); // clients learn nothing
      const logs = JSON.stringify(ctx.records);
      for (const leak of ["127.0.0.1", "redis://", "connect ECONN"]) expect(logs).not.toContain(leak); // logs: no host/URL/message text
      const redisErrors = ctx.records.filter((x) => x.event === "api.redis.error");
      expect(redisErrors.length).toBeGreaterThanOrEqual(1); // diagnostics are recorded (rate-limited), as codes only
      const allowed = new Set(["ts", "level", "event", "service", "errorCode", "errorName", "suppressedSinceLast"]);
      for (const r of redisErrors) expect(Object.keys(r).every((k) => allowed.has(k))).toBe(true);
      expect(ctx.records.filter((r) => r.event === "webhook.enqueue.unavailable" && r["submission"] === "not_attempted")).toHaveLength(3);
      expect(events(ctx.records)).not.toContain("webhook.enqueue.succeeded");
      // auth/body protections still hold in this state
      const unauth = await ctx.instance.inject({ method: "POST", url: "/webhooks/telegram", headers: { "content-type": "application/json" }, payload: "{bad" });
      expect(unauth.statusCode).toBe(403);
    } finally {
      if (saved === undefined) delete process.env["REDIS_URL"]; else process.env["REDIS_URL"] = saved;
      const t0 = Date.now();
      if (ctx) await ctx.instance.close();
      expect(Date.now() - t0).toBeLessThan(6000); // owned queue/client closed within the grace period, then forced down
    }
  }, 30_000);
});

describe("Redis unavailable after a previously healthy connection (controlled queue behaviour)", () => {
  it("connectivity errors -> generic 503 'failed_unconfirmed'; other errors stay 500; no underlying text is exposed", async () => {
    const conn = vi.fn().mockRejectedValue(Object.assign(new Error("Connection is closed. host=10.9.8.7 password=CANARYREDIS"), { name: "Error" }));
    const a = await app({ add: conn });
    const { res } = await a.post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(GENERIC_503);
    expect(a.records.find((r) => r.event === "webhook.enqueue.unavailable")).toMatchObject({ submission: "failed_unconfirmed", statusCode: 503 });
    expect(JSON.stringify(a.records) + res.body).not.toContain("CANARYREDIS");

    const bug = await app({ add: vi.fn().mockRejectedValue(new TypeError("programming error CANARYBUG")) });
    const b = await bug.post();
    expect(b.res.statusCode).toBe(500);
    expect(b.res.body).not.toContain("CANARYBUG");
  });

  it("a hung submission is bounded: generic 503 within the bound, outcome recorded as UNKNOWN, late completion logged (the call is not cancelled)", async () => {
    let finish!: (v: unknown) => void;
    const add = vi.fn(() => new Promise((r) => { finish = r; }));
    const a = await app({ add }, 300);
    const { res, ms } = await a.post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(GENERIC_503);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1200);
    expect(a.records.find((r) => r.event === "webhook.enqueue.outcome_unknown")).toMatchObject({ submission: "timed_out_unconfirmed", boundMs: 300 });
    expect(events(a.records)).not.toContain("webhook.enqueue.late_completion");
    finish({ id: "late" }); // the underlying enqueue completes AFTER the 503
    await sleep(20);
    expect(a.records.find((r) => r.event === "webhook.enqueue.late_completion")).toMatchObject({ outcome: "succeeded" });
  });
});

describe("healthy path", () => {
  it("202 only after the queue confirmed, with the unchanged job options (worker retry policy is not the HTTP policy)", async () => {
    const add = vi.fn().mockResolvedValue({ id: "ok" });
    const a = await app({ add });
    const { res, ms } = await a.post();
    expect(res.statusCode).toBe(202);
    expect(ms).toBeLessThan(250);
    const [, , opts] = add.mock.calls[0] as [string, unknown, { jobId: string; attempts: number; backoff: unknown }];
    expect(opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    expect(opts.jobId).toBe("tg-tg_chat_-100777-5");
  });
  it("the best-effort duplicate lookup cannot turn a confirmed submission into a hang or a failure", async () => {
    const a = await app({ add: vi.fn().mockResolvedValue({ id: "ok" }), getJob: vi.fn(() => new Promise(() => undefined)) }, 600);
    const { res, ms } = await a.post();
    expect(res.statusCode).toBe(202);
    expect(ms).toBeLessThan(1500);
    expect(a.records.find((r) => r.event === "webhook.enqueue.link_lookup_failed")).toBeDefined();
  });
});

describe("ambiguous submission outcome: retry is safe because the job id is deterministic", () => {
  it("timed-out first request (job created LATER) + client retry -> exactly one job; the retry gets 202", async () => {
    // Fake with BullMQ's documented semantics: add() with an existing jobId returns the existing job, never a second one.
    const jobs = new Map<string, unknown>();
    let delayFirst = true;
    const add = vi.fn(async (_name: string, data: unknown, opts: { jobId: string }) => {
      if (delayFirst) { delayFirst = false; await sleep(700); } // slower than the 300 ms bound; still completes
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data);
      return { id: opts.jobId };
    });
    const a = await app({ add, getJob: async (id: string) => (jobs.has(id) ? { id, data: jobs.get(id) } : undefined) }, 300);
    const first = await a.post();
    expect(first.res.statusCode).toBe(503); // outcome unknown at this moment: jobs.size is still 0 here
    expect(jobs.size).toBe(0);
    await sleep(600); // the abandoned submission now completes by itself
    expect(jobs.size).toBe(1);
    expect(a.records.find((r) => r.event === "webhook.enqueue.late_completion")).toMatchObject({ outcome: "succeeded" });
    const retry = await a.post();
    expect(retry.res.statusCode).toBe(202);
    const again = await a.post();
    expect(again.res.statusCode).toBe(202);
    expect(jobs.size).toBe(1); // never a second job for the same update
    expect(new Set(add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).size).toBe(1);
  });
});
