import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../support/apiWithTestPolicy";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const must = <T,>(v: T | undefined | null): T => { if (v === undefined || v === null) throw new Error("expected a value"); return v; };

const API_KEY = "test-api-key-CANARY-1";
const SECRET = "telegram-secret-CANARY-2";
const BODY_TEXT = "BUY CANARYSYMBOL @ 2800 SL 2750 TGT 2900";

function update(updateId = 1, messageId = 10) {
  return {
    update_id: updateId,
    message: { message_id: messageId, date: 1700000000, chat: { id: -1001234567890, type: "channel", username: "u" }, text: BODY_TEXT },
  };
}
const headers = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET, ...extra });

async function setup(queue: { add: ReturnType<typeof vi.fn>; getJob?: ReturnType<typeof vi.fn> }) {
  const records: LogRecord[] = [];
  const app = await buildApp({
    apiKey: API_KEY,
    telegramWebhookSecret: SECRET,
    telegramQueue: queue as never,
    structuredLogger: createStructuredLogger((r) => records.push(r)),
  });
  return { app, records };
}
const events = (records: LogRecord[]) => records.map((r) => r.event);

describe("webhook correlation logging", () => {
  it("accepted intake: generates ids, logs milestones and puts correlation metadata in the job payload", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records } = await setup({ add });
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    expect(res.statusCode).toBe(202);
    expect(events(records)).toEqual(["webhook.intake.accepted", "webhook.enqueue.succeeded"]);
    const [, data, opts] = add.mock.calls[0] as [string, { correlation: { correlationId: string; requestId: string; receivedAt: string } }, { jobId: string }];
    const accepted = must(records[0]);
    expect(accepted["correlationId"]).toBe(data.correlation.correlationId);
    expect(accepted["requestId"]).toBe(data.correlation.requestId);
    expect(accepted["correlationSource"]).toBe("generated");
    expect(data.correlation.requestId).toMatch(/^req_/);
    // job id is the business key, distinct from the correlation id
    expect(opts.jobId).toBe("tg-tg_chat_-1001234567890-10");
    expect(opts.jobId).not.toContain(data.correlation.correlationId);
    expect(accepted["jobId"]).toBe(opts.jobId);
  });

  it("ignores a client-supplied request-id header (request id stays server generated)", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records } = await setup({ add });
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ "request-id": "evil\ninjected" }), payload: update() });
    expect(must(records[0])["requestId"]).toMatch(/^req_/);
    expect(JSON.stringify(records)).not.toContain("injected");
  });

  it("accepts a valid client-supplied correlation id only AFTER authentication; bad ones are replaced", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records } = await setup({ add });
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ "x-correlation-id": "client-corr-12345" }), payload: update(1, 11) });
    expect(must(records.find((r) => r.event === "webhook.intake.accepted"))["correlationId"]).toBe("client-corr-12345");
    expect(must(records.find((r) => r.event === "webhook.intake.accepted"))["correlationSource"]).toBe("client-supplied");

    records.length = 0;
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ "x-correlation-id": "bad value with spaces\n" }), payload: update(2, 12) });
    expect(must(records[0])["correlationId"]).toMatch(/^corr_/);
    expect(must(records[0])["correlationSource"]).toBe("generated");

    records.length = 0; // unauthenticated: client id must not appear anywhere
    const rej = await app.inject({
      method: "POST", url: "/webhooks/telegram",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong-CANARY", "x-correlation-id": "client-corr-99999" },
      payload: update(3, 13),
    });
    expect(rej.statusCode).toBe(403);
    expect(events(records)).toEqual(["webhook.intake.rejected"]);
    expect(records[0]).toMatchObject({ reason: "invalid_secret", statusCode: 403 });
    expect(JSON.stringify(records)).not.toContain("client-corr-99999");
    expect(add).toHaveBeenCalledTimes(2); // rejected request enqueued nothing
  });

  it("duplicate request deduplicating onto an existing job links to that job instead of claiming its own ids", async () => {
    const first = { correlationId: "corr_first-request-1", requestId: "req_first", receivedAt: "2026-01-01T00:00:00.000Z" };
    const add = vi.fn().mockResolvedValue({ id: "tg-tg_chat_-1001234567890-10" });
    const getJob = vi.fn().mockResolvedValue({ id: "tg-tg_chat_-1001234567890-10", data: { correlation: first } });
    const { app, records } = await setup({ add, getJob });
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    expect(res.statusCode).toBe(202);
    const dup = must(records.find((r) => r.event === "webhook.enqueue.deduplicated"));
    expect(dup).toBeDefined();
    expect(dup["existingJobCorrelationId"]).toBe("corr_first-request-1");
    expect(dup["existingJobRequestId"]).toBe("req_first");
    expect(dup["correlationId"]).not.toBe("corr_first-request-1"); // this request's own id is logged but did not become the job's
    expect(events(records)).not.toContain("webhook.enqueue.succeeded");
  });

  it("legacy stored job without correlation metadata is still linked (id unknown)", async () => {
    const add = vi.fn().mockResolvedValue({ id: "j" });
    const getJob = vi.fn().mockResolvedValue({ id: "j", data: {} });
    const { app, records } = await setup({ add, getJob });
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    const dup = must(records.find((r) => r.event === "webhook.enqueue.deduplicated"));
    expect(dup["existingJobCorrelationId"]).toBeUndefined();
    expect(dup["jobId"]).toBe("tg-tg_chat_-1001234567890-10");
  });

  it("logs enqueue failure with a safe error code and rethrows (500)", async () => {
    const add = vi.fn().mockRejectedValue(Object.assign(new Error("connection string password=CANARY"), { code: "ENQUEUE_FAILED" }));
    const { app, records } = await setup({ add });
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    expect(res.statusCode).toBe(500);
    const failed = must(records.find((r) => r.event === "webhook.enqueue.failed"));
    expect(failed).toMatchObject({ errorCode: "ENQUEUE_FAILED", statusCode: 500 });
    expect(JSON.stringify(records)).not.toContain("CANARY");
  });

  it("invalid and ignored intakes are logged with codes; no body, secret or authorization header ever appears in any record", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records } = await setup({ add });
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ authorization: `Bearer ${API_KEY}` }), payload: update() });
    const noText = update(5, 50); delete (noText.message as { text?: string }).text;
    const r2 = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: noText });
    expect(r2.statusCode).toBe(200);
    expect(events(records)).toContain("webhook.intake.ignored");
    const all = JSON.stringify(records);
    for (const canary of [API_KEY, SECRET, "CANARYSYMBOL", "BUY CANARY", BODY_TEXT, "Bearer"]) expect(all).not.toContain(canary);
  });
});
