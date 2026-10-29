import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../support/apiWithTestPolicy";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { memoryOutbox } from "../../support/memoryOutbox";

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
  const outbox = memoryOutbox();
  const app = await buildApp({
    apiKey: API_KEY,
    telegramWebhookSecret: SECRET,
    intakeOutbox: outbox, telegramQueue: queue as never,
    structuredLogger: createStructuredLogger((r) => records.push(r)),
  });
  return { app, records, outbox };
}
const events = (records: LogRecord[]) => records.map((r) => r.event);

describe("webhook correlation logging", () => {
  it("accepted intake: generates ids, logs milestones and puts correlation metadata in the durable outbox payload", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records, outbox } = await setup({ add });
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    expect(res.statusCode).toBe(202);
    expect(events(records)).toEqual(["webhook.intake.accepted", "outbox.accepted", "outbox.enqueued", "webhook.enqueue.succeeded"]);
    const [name, redisData, opts] = add.mock.calls[0] as [string, { outboxId: string }, { jobId: string }];
    const entry = must(outbox.list()[0]);
    const data = entry.payload as { correlation: { correlationId: string; requestId: string; receivedAt: string } };
    expect(name).toBe("telegram_outbox");
    expect(redisData).toEqual({ jobType: "telegram_outbox", outboxId: entry.id }); // Redis carries only the row id
    const accepted = must(records[0]);
    expect(accepted["correlationId"]).toBe(data.correlation.correlationId);
    expect(accepted["requestId"]).toBe(data.correlation.requestId);
    expect(accepted["correlationSource"]).toBe("generated");
    expect(data.correlation.requestId).toMatch(/^req_/);
    // the business key (channel + revision identity) is distinct from the correlation id; the Redis job id is attempt-scoped
    expect(accepted["jobId"]).toBe("tg-tg_chat_-1001234567890-10");
    expect(accepted["jobId"]).not.toContain(data.correlation.correlationId);
    expect(opts.jobId).toBe(`outbox-${entry.id}-0`);
    expect(entry).toMatchObject({ channelId: "tg_chat_-1001234567890", sourceMessageId: "10", messageType: "message", intakeSource: "bot_webhook" });
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

  it("a redelivered update deduplicates onto the existing outbox row: its payload and correlation stay the first request's", async () => {
    const add = vi.fn().mockResolvedValue({ id: "x" });
    const { app, records, outbox } = await setup({ add });
    await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ "x-correlation-id": "corr_first-request-1" }), payload: update() });
    records.length = 0;
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers({ "x-correlation-id": "corr_second-request-2" }), payload: update() });
    expect(res.statusCode).toBe(202);
    expect(outbox.list()).toHaveLength(1);
    expect((outbox.list()[0]?.payload as { correlation: { correlationId: string } }).correlation.correlationId).toBe("corr_first-request-1");
    const dup = must(records.find((r) => r.event === "webhook.enqueue.deduplicated"));
    expect(dup["correlationId"]).toBe("corr_second-request-2"); // this request's own id is logged but did not become the row's
    expect(events(records)).toContain("outbox.duplicated");
    expect(events(records)).not.toContain("webhook.enqueue.succeeded");
    expect(add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).toHaveLength(2);
    expect(new Set(add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).size).toBe(1); // same attempt-scoped Redis job id: BullMQ ignores the repeat
  });

  it("an enqueue failure AFTER the durable write is acknowledged (202) and logged with a safe code; the row stays recoverable", async () => {
    const add = vi.fn().mockRejectedValue(Object.assign(new Error("connection string password=CANARY"), { code: "ENQUEUE_FAILED" }));
    const { app, records, outbox } = await setup({ add });
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: headers(), payload: update() });
    expect(res.statusCode).toBe(202);
    const failed = must(records.find((r) => r.event === "outbox.enqueue_failed_but_durable"));
    expect(failed).toMatchObject({ errorCode: "ENQUEUE_FAILED" });
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0]?.enqueued).toBe(false);
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
