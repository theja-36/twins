/**
 * Webhook auth/parser/logging boundary and queue-selection tests (F1 remediation).
 * Canary strings are planted in bodies, secrets and error messages; no captured log line (framework pino
 * output AND the structured event log) and no response body may contain them. Rejected requests must
 * have no enqueue side effect.
 */
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../apps/api/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const API_KEY = "boundary-api-key-9d2";
const SECRET = "boundary-secret-4e1";
const GOOD = { update_id: 7, message: { message_id: 3, date: 1700000000, chat: { id: -100123, type: "channel" }, text: "BUY X @ 10 SL 9 TGT 12" } };
const H = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });
const authed = H({ "x-telegram-bot-api-secret-token": SECRET });

async function setup(addImpl?: () => Promise<unknown>) {
  const pinoLines: string[] = [];
  const records: LogRecord[] = [];
  const add = vi.fn(addImpl ?? (async () => ({ id: "test-owned-fake-job" })));
  const app = await buildApp({
    apiKey: API_KEY,
    telegramWebhookSecret: SECRET,
    telegramQueue: { add } as never,
    db: {} as never,
    logger: { level: "trace", stream: { write: (l: string) => pinoLines.push(l) } } as never,
    structuredLogger: createStructuredLogger((r) => records.push(r)),
  });
  const everything = (...responses: string[]) => [...pinoLines, JSON.stringify(records), ...responses].join("\n");
  return { app, add, pinoLines, records, everything };
}
const post = (app: Awaited<ReturnType<typeof setup>>["app"], headers: Record<string, string>, payload: string | object) =>
  app.inject({ method: "POST", url: "/webhooks/telegram", headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

describe("webhook secret is checked before the body is parsed", () => {
  const MALFORMED = '{"update_id": 1, "x": CANARYBODY-7f3a91 }';

  it.each([
    ["missing secret", H()],
    ["wrong secret", H({ "x-telegram-bot-api-secret-token": "WRONGSECRET-CANARY-55" })],
  ])("%s + malformed JSON -> 403 (body never parsed), no enqueue, nothing leaked", async (_l, headers) => {
    const { app, add, everything } = await setup();
    const res = await post(app, headers, MALFORMED);
    expect(res.statusCode).toBe(403); // would be 400 if the body had been parsed first
    expect(res.json()).toEqual({ error: "Forbidden" });
    expect(add).not.toHaveBeenCalled();
    const all = everything(res.body);
    for (const c of ["CANARYBODY", "WRONGSECRET-CANARY", SECRET]) expect(all).not.toContain(c);
  });

  it("missing/wrong secret + schema-invalid or prototype-poisoned bodies are still 403 and not enqueued", async () => {
    const { app, add } = await setup();
    for (const body of ['{"hello":"x"}', '{"update_id":1,"__proto__":{"polluted":true}}', ""]) {
      expect((await post(app, H(), body)).statusCode).toBe(403);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("valid secret + malformed JSON -> 400 with a fixed message; no body fragment in responses or ANY log; no enqueue", async () => {
    const { app, add, everything, pinoLines } = await setup();
    const res = await post(app, authed, MALFORMED);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, code: "TWINS_MALFORMED_BODY", message: "Malformed or unsupported JSON body" });
    expect(add).not.toHaveBeenCalled();
    expect(pinoLines.length).toBeGreaterThan(0); // the framework logger really was capturing
    expect(everything(res.body)).not.toContain("CANARYBODY");
    expect(everything(res.body)).not.toContain(SECRET);
  });

  it("valid secret + schema-invalid body (type mismatch with a canary value) -> 400 without echoing values", async () => {
    const { app, add, everything } = await setup();
    const res = await post(app, authed, { update_id: "CANARYTYPE-88" });
    expect(res.statusCode).toBe(400);
    expect(add).not.toHaveBeenCalled();
    expect(everything(res.body)).not.toContain("CANARYTYPE");
  });

  it("valid secret + prototype-poisoning body is rejected (stock parser protection preserved) without echo", async () => {
    const { app, add, everything } = await setup();
    const res = await post(app, authed, '{"update_id":1,"__proto__":{"CANARYPROTO":true}}');
    expect(res.statusCode).toBe(400);
    expect(add).not.toHaveBeenCalled();
    expect(everything(res.body)).not.toContain("CANARYPROTO");
  });

  it("valid secret + valid body still enqueues and returns 202 (control)", async () => {
    const { app, add } = await setup();
    const res = await post(app, authed, GOOD);
    expect(res.statusCode).toBe(202);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("body-size protection is preserved: authenticated > 1 MB -> 413; unauthenticated > 1 MB -> 403 without reading it", async () => {
    const { app, add, everything } = await setup();
    const big = JSON.stringify({ update_id: 1, pad: "CANARYBIG".repeat(130_000) });
    const a = await post(app, authed, big);
    expect(a.statusCode).toBe(413);
    const u = await post(app, H(), big);
    expect(u.statusCode).toBe(403);
    expect(add).not.toHaveBeenCalled();
    expect(everything(a.body, u.body)).not.toContain("CANARYBIG");
  });

  it("an unexpected handler error (e.g. a database/queue error whose message holds data) -> generic 500 and the message is never logged", async () => {
    const { app, everything } = await setup(async () => { throw Object.assign(new Error("insert failed: row (password=CANARYERR-99)"), { code: "ENQUEUE_FAILED" }); });
    const res = await post(app, authed, GOOD);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" });
    expect(everything(res.body)).not.toContain("CANARYERR");
  });
});

describe("queue selection is explicit (no NODE_ENV stub)", () => {
  it("NODE_ENV=test without an injected queue does NOT acknowledge-and-discard: with an unreachable real Redis a valid request gets a generic 503, never 202", async () => {
    expect(process.env["NODE_ENV"]).toBe("test");
    const savedRedis = process.env["REDIS_URL"];
    process.env["REDIS_URL"] = "redis://127.0.0.1:1"; // closed local port; nothing is contacted beyond loopback
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      app = await buildApp({ apiKey: API_KEY, telegramWebhookSecret: SECRET, db: {} as never, logger: false, enqueueTimeoutMs: 400 });
      const res = await post(app as never, authed, GOOD);
      // With the producer bound the unreachable real queue now answers promptly with a generic 503; a stub would have answered 202.
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ statusCode: 503, error: "Service Unavailable", message: "Service Unavailable" });
    } finally {
      if (savedRedis === undefined) delete process.env["REDIS_URL"]; else process.env["REDIS_URL"] = savedRedis;
      if (app) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]);
    }
  }, 30_000);
});
