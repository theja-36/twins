type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../apps/api/src/index"; // the REAL buildApp: explicit policies, no allow-all wrapper
import { INTERNAL_INGEST_BODY_LIMIT, INTERNAL_INGEST_PATH } from "../../../apps/api/src/internalIngest";
import { MAX_MESSAGES_PER_CALL } from "../../../apps/api/src/internalIngestValidation";
import { createTelegramIntakePolicy, normalizeRawUpdate, revisionExternalId } from "../../../adapters/telegram/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const API_KEY = "internal-test-api-key-0123456789";
const WEBHOOK_SECRET = "internal-test-webhook-secret-0123";
const TOKEN = "cap-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEF";
const CHAT_ID = -1001000000001; // synthetic
const OTHER = -1002000000002;
const CANARY = "CANARY-CHANNEL-TEXT-91ac";
const nowSeconds = () => Math.floor(Date.now() / 1000);

function fakeQueue() {
  const jobs = new Map<string, { name: string; data: Loose; opts: Loose }>();
  return {
    jobs,
    add: vi.fn(async (name: string, data: Loose, opts: Loose) => { jobs.set(opts.jobId, { name, data, opts }); return { id: opts.jobId }; }),
    getJob: vi.fn(async (id: string) => (jobs.has(id) ? { id } : undefined)),
  };
}

async function make(options: Record<string, unknown> = {}) {
  const queue = fakeQueue();
  const records: LogRecord[] = [];
  const app = await buildApp({
    apiKey: API_KEY,
    telegramWebhookSecret: WEBHOOK_SECRET,
    telegramQueue: queue as never,
    telegramIntakePolicy: createTelegramIntakePolicy({ allowedChatIds: String(CHAT_ID) }),
    structuredLogger: createStructuredLogger((r) => records.push(r)),
    captureIngestToken: TOKEN,
    ...options,
  } as never);
  const post = (body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) =>
    app.inject({
      method: "POST",
      url: INTERNAL_INGEST_PATH,
      headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}), ...headers },
      payload: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, queue, records, post };
}

const msg = (id: number, over: Record<string, unknown> = {}) => ({ id, date: nowSeconds() - 100, text: `${CANARY} BUY NIFTY 24500 CE ${id}`, ...over });
const live = (messages: unknown[], over: Record<string, unknown> = {}) => ({ schemaVersion: 1, captureMethod: "api_live", event: "message", chat: { id: CHAT_ID, type: "channel", title: "Test" }, messages, ...over });
const history = (messages: unknown[], over: Record<string, unknown> = {}) => live(messages, { captureMethod: "api_history", importBatch: { batchId: "0b9f2c3e-7d41-4a8e-9a55-6f1d2c3b4a5e", lowestMessageId: 1, lowestMessageDate: 1_700_000_000 }, ...over });
const del = (ids: unknown[], over: Record<string, unknown> = {}) => ({ schemaVersion: 1, captureMethod: "api_live", event: "delete", chat: { id: CHAT_ID, type: "channel" }, deletedMessageIds: ids, ...over });

describe("the endpoint exists only when configured", () => {
  it("is absent without a token (404) and never queues anything", async () => {
    const { post, queue } = await make({ captureIngestToken: undefined });
    const previous = process.env["TWINS_CAPTURE_INGEST_TOKEN"];
    delete process.env["TWINS_CAPTURE_INGEST_TOKEN"];
    try {
      const { post: post2, queue: queue2 } = await make({ captureIngestToken: "" });
      expect((await post2(live([msg(1)]))).statusCode).toBe(404);
      expect(queue2.add).not.toHaveBeenCalled();
    } finally { if (previous !== undefined) process.env["TWINS_CAPTURE_INGEST_TOKEN"] = previous; }
    expect(queue.add).not.toHaveBeenCalled();
    expect(typeof post).toBe("function");
  });
  it("refuses to start with an unusable token, without echoing it", async () => {
    const bad = ["short", "x".repeat(31), "x".repeat(257), `${"x".repeat(40)} y`, `${"x".repeat(40)}\n`, "é".repeat(40), "tab\t".padEnd(40, "x")];
    for (const token of bad) {
      const error = await make({ captureIngestToken: token }).then(() => undefined, (e: unknown) => e as Error);
      expect(error?.message, JSON.stringify(token)).toMatch(/TWINS_CAPTURE_INGEST_TOKEN/);
      expect(error?.message ?? "").not.toContain(token.trim() || "~~none~~");
    }
    // equal to the API key (webhook secret differs) and equal to the webhook secret (API key differs): each is refused on its own
    for (const token of [API_KEY, WEBHOOK_SECRET]) {
      expect(token.length).toBeGreaterThanOrEqual(32); // so only the "must differ" rule can be what refuses it
      const error = await make({ captureIngestToken: token }).then(() => undefined, (e: unknown) => e as Error);
      expect(error?.message).toMatch(/must differ from TWINS_API_KEY and TELEGRAM_WEBHOOK_SECRET/);
      expect(error?.message ?? "").not.toContain(token);
    }
  });
  it("refuses to start with malformed caps", async () => {
    for (const bad of [{ requestsPerMinute: 0 }, { liveMessagesPerHour: -1 }, { historyMessagesPerDay: 1.5 }, { liveMessagesPerHour: 1e9 }]) {
      await expect(make({ captureCaps: bad })).rejects.toThrow(/TWINS_CAPTURE_MAX_/);
    }
  });
});

describe("authentication happens before the body is read", () => {
  it("rejects missing, wrong, empty, wrong-scheme and borrowed credentials with 401 and queues nothing", async () => {
    const { post, queue } = await make();
    const body = live([msg(1)]);
    const cases: Array<[string, Record<string, string>, string | null]> = [
      ["no header", {}, null], ["wrong token", {}, "wrong".padEnd(40, "z")], ["empty bearer", { authorization: "Bearer " }, null],
      ["basic scheme", { authorization: `Basic ${TOKEN}` }, null], ["token without scheme", { authorization: TOKEN }, null],
      ["two tokens", { authorization: `Bearer ${TOKEN} ${TOKEN}` }, null], ["the API key", {}, API_KEY], ["the webhook secret", {}, WEBHOOK_SECRET],
      ["token plus trailing char", {}, `${TOKEN}x`], ["token prefix", {}, TOKEN.slice(0, -1)],
    ];
    for (const [name, headers, token] of cases) {
      const res = await post(body, headers, token);
      expect(res.statusCode, name).toBe(401);
      expect(res.json(), name).toEqual({ error: "Unauthorized" });
    }
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
  });
  it("an unauthenticated caller never gets its body parsed or size-checked (invalid JSON and an oversized body both give 401)", async () => {
    const { post, queue } = await make();
    expect((await post("{not json", {}, null)).statusCode).toBe(401);
    expect((await post("x".repeat(INTERNAL_INGEST_BODY_LIMIT + 10), {}, "nope".padEnd(40, "z"))).statusCode).toBe(401);
    expect(queue.add).not.toHaveBeenCalled();
  });
  it("refuses any request that came through a proxy, even with a valid token (404, nothing queued)", async () => {
    const { post, queue, records } = await make();
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "via", "X-Forwarded-For"]) {
      const res = await post(live([msg(1)]), { [header]: "203.0.113.9" });
      expect(res.statusCode, header).toBe(404);
    }
    expect(queue.add).not.toHaveBeenCalled();
    expect(records.filter((r) => r["reason"] === "proxy_header").length).toBe(8);
  });
  it("the existing bearer and webhook credentials do not open the internal route and the internal token does not open the others", async () => {
    const { app } = await make();
    const claims = await app.inject({ method: "GET", url: "/options-claims/2a11fc86-eaa1-4e72-be4a-016be3e2d365", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(claims.statusCode).toBe(401);
    const hook = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TOKEN }, payload: "{}" });
    expect(hook.statusCode).toBe(403);
  });
  it("the Bot API webhook keeps working unchanged next to the internal route", async () => {
    const { app, queue } = await make();
    const res = await app.inject({
      method: "POST", url: "/webhooks/telegram",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: JSON.stringify({ update_id: 9, channel_post: { message_id: 7, date: nowSeconds() - 10, chat: { id: CHAT_ID, type: "channel" }, text: "hello" } }),
    });
    expect(res.statusCode).toBe(202);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((queue.add.mock.calls[0]?.[1] as Loose).telegram.capture).toBeUndefined(); // the bot path carries no capture provenance
  });
});

describe("approved-chat gate", () => {
  it("rejects a chat that is not approved (403) for messages and deletions, queueing nothing", async () => {
    const { post, queue, records } = await make();
    for (const body of [live([msg(1)], { chat: { id: OTHER, type: "channel" } }), history([msg(1)], { chat: { id: OTHER, type: "channel" } }), del([5], { chat: { id: OTHER, type: "channel" } })]) {
      const res = await post(body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "chat_not_approved" });
    }
    expect(queue.add).not.toHaveBeenCalled();
    const rejected = records.filter((r) => r.event === "capture.ingest.rejected" && r["reason"] === "chat_not_approved");
    expect(rejected).toHaveLength(3);
    expect(rejected[0]).toMatchObject({ chatId: String(OTHER), statusCode: 403 });
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });
  it("an empty allowlist approves nothing", async () => {
    const { post, queue } = await make({ telegramIntakePolicy: createTelegramIntakePolicy({}) });
    expect((await post(live([msg(1)]))).statusCode).toBe(403);
    expect(queue.add).not.toHaveBeenCalled();
  });
  it("an unusable chat id never passes (the schema rejects what the policy would also refuse)", async () => {
    const { post, queue } = await make();
    for (const id of ["-1001000000001", 1.5, 0, null, true]) {
      const res = await post(live([msg(1)], { chat: { id, type: "channel" } }));
      expect([400, 403], String(id)).toContain(res.statusCode);
    }
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe("payload validation (strict; nothing is queued on any failure)", () => {
  const cases: Array<[string, () => unknown, RegExp?]> = [
    ["body is an array", () => [], /body/],
    ["unknown top-level field", () => live([msg(1)], { extra: 1 }), /unknown field/],
    ["unknown message field", () => live([msg(1, { sender: "x" })]), /unknown field/],
    ["schemaVersion 2", () => live([msg(1)], { schemaVersion: 2 }), /schemaVersion/],
    ["unsupported captureMethod", () => live([msg(1)], { captureMethod: "bot_webhook" }), /captureMethod/],
    ["unknown event", () => live([msg(1)], { event: "edit" }), /event/],
    ["history without importBatch", () => live([msg(1)], { captureMethod: "api_history" }), /importBatch/],
    ["live with importBatch", () => live([msg(1)], { importBatch: { batchId: "0b9f2c3e-7d41-4a8e-9a55-6f1d2c3b4a5e", lowestMessageId: 1, lowestMessageDate: 1_700_000_000 } }), /importBatch/],
    ["bad batch id", () => history([msg(1)], { importBatch: { batchId: "nope", lowestMessageId: 1, lowestMessageDate: 1_700_000_000 } }), /batchId/],
    ["101 messages", () => live(Array.from({ length: MAX_MESSAGES_PER_CALL + 1 }, (_, i) => msg(i + 1))), /messages/],
    ["no messages", () => live([]), /messages/],
    ["text too long", () => live([msg(1, { text: "a".repeat(20_001) })]), /text/],
    ["text not a string", () => live([msg(1, { text: 5 })]), /text/],
    ["chat type private", () => live([msg(1)], { chat: { id: CHAT_ID, type: "private" } }), /chat\.type/],
    ["messages with event delete", () => del([1], { messages: [msg(1)] }), /not allowed/],
    ["deletedMessageIds with event message", () => live([msg(1)], { deletedMessageIds: [1] }), /not allowed/],
    ["delete without ids", () => del([]), /deletedMessageIds/],
    ["101 deleted ids", () => del(Array.from({ length: 101 }, (_, i) => i + 1)), /deletedMessageIds/],
    ["non-integer id", () => live([msg(1.5)]), /id/],
    ["negative id", () => live([msg(-3)]), /id/],
    ["date far in the future", () => live([msg(1, { date: nowSeconds() + 10 * 86400 })]), /date/],
    ["date implausibly old", () => live([msg(1, { date: 5 })]), /date/],
    ["editDate before date", () => live([msg(1, { date: nowSeconds() - 50, editDate: nowSeconds() - 500 })]), /editDate/],
    ["entities too many", () => live([msg(1, { entities: Array.from({ length: 501 }, () => ({ type: "bold", offset: 0, length: 1 })) })]), /entities/],
    ["entity unknown field", () => live([msg(1, { entities: [{ type: "bold", offset: 0, length: 1, x: 1 }] })]), /unknown field/],
    ["media unknown field", () => live([msg(1, { media: { kind: "photo", url: "http://x" } })]), /unknown field/],
    ["hasProtectedContent not boolean", () => live([msg(1, { hasProtectedContent: "yes" })]), /hasProtectedContent/],
    ["clientObservedAt not a time", () => live([msg(1)], { clientObservedAt: "soon" }), /clientObservedAt/],
    ["views negative", () => live([msg(1, { views: -1 })]), /views/],
  ];
  for (const [name, build, expected] of cases) {
    it(`rejects: ${name}`, async () => {
      const { post, queue, records } = await make();
      const res = await post(build());
      expect(res.statusCode).toBe(400);
      const json = res.json() as { error: string; problems: string[] };
      expect(json.error).toBe("Invalid payload");
      if (expected) expect(json.problems.join("\n")).toMatch(expected);
      expect(json.problems.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(json)).not.toContain(CANARY); // problems name paths and rules, never values
      expect(queue.add).not.toHaveBeenCalled();
      expect(JSON.stringify(records)).not.toContain(CANARY);
    });
  }
  it("rejects a body over the 2 MB cap with 413 and malformed JSON with 400, queueing nothing", async () => {
    const { post, queue } = await make();
    expect((await post("y".repeat(INTERNAL_INGEST_BODY_LIMIT + 1024))).statusCode).toBe(413);
    expect((await post("{broken")).statusCode).toBe(400);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe("accepted traffic", () => {
  it("queues one job per text message with the Bot API job id format and preserves the text byte-for-byte", async () => {
    const { post, queue } = await make();
    const text = `  ${CANARY}\r\n BUY NIFTY 24500 CE ‮  `;
    const res = await post(live([msg(837678, { text, entities: [{ type: "bold", offset: 0, length: 3 }] }), msg(837679, { text: undefined, media: { kind: "photo", size: 10 } })]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, ignored: 1, rejected: [] });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] as [string, Loose, Loose];
    expect(name).toBe("telegram_messages");
    expect(opts).toMatchObject({ jobId: `tg-tg_chat_${CHAT_ID}-837678`, attempts: 3 });
    expect(data.jobType).toBe("telegram_messages");
    expect(data.providerName).toBe("telegram-user-capture");
    expect(data.telegram.normalizedMessage).toMatchObject({ channelIdentifier: `tg_chat_${CHAT_ID}`, chatId: String(CHAT_ID), externalMessageId: "837678", rawText: text });
    expect(data.telegram.capture).toMatchObject({ captureMethod: "api_live" });
    expect(Date.parse(data.telegram.capture.observedAt)).toBeGreaterThan(Date.now() - 5000);
    expect(data.telegram.capture.importedAt).toBeUndefined();
    expect(data.correlation.correlationId).toBeTruthy();
  });
  it("the API does not classify content: equity-style text is queued (the worker's options-only gate decides)", async () => {
    const { post, queue } = await make();
    expect((await post(live([msg(1, { text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900" })]))).statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
  it("an edit is keyed by the shared revision identity, identical to the Bot API's for the same edit", async () => {
    const { post, queue } = await make();
    const editDate = nowSeconds() - 20;
    const date = nowSeconds() - 100;
    const text = "edited BUY NIFTY 24600 CE";
    await post(live([{ id: 42, date, editDate, text }]));
    const bot = normalizeRawUpdate({ update_id: 1, edited_channel_post: { message_id: 42, date, edit_date: editDate, chat: { id: CHAT_ID, type: "channel" }, text } });
    const expectedId = revisionExternalId("42", editDate, text);
    expect(bot?.externalMessageId).toBe(expectedId);
    expect(queue.add.mock.calls[0]?.[2]).toMatchObject({ jobId: `tg-tg_chat_${CHAT_ID}-${expectedId}` });
    expect((queue.add.mock.calls[0]?.[1] as Loose).telegram.normalizedMessage).toMatchObject({ originMessageId: "42", externalMessageId: expectedId });
  });
  it("duplicates are idempotent: the same message twice, and live then history, create ONE job", async () => {
    const { post, queue } = await make();
    expect((await post(live([msg(10), msg(10)]))).json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect((await post(live([msg(10)]))).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const second = await post(history([msg(10), msg(11)]));
    expect(second.json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(queue.add).toHaveBeenCalledTimes(2); // ids 10 and 11 only
    const history11 = queue.jobs.get(`tg-tg_chat_${CHAT_ID}-11`)?.data as Loose;
    expect(history11.telegram.capture.captureMethod).toBe("api_history");
    expect(Date.parse(history11.telegram.capture.importedAt)).toBe(Date.parse(history11.telegram.capture.observedAt));
    expect(history11.telegram.capture.importBatchId).toBe("0b9f2c3e-7d41-4a8e-9a55-6f1d2c3b4a5e");
  });
  it("a deletion becomes ONE telegram_events job with sorted unique ids; repeating it is a duplicate; no message job is created", async () => {
    const { post, queue } = await make();
    const res = await post(del([30, 10, 20, 10], { clientObservedAt: "2026-10-22T12:00:00Z" }));
    expect(res.json()).toEqual({ accepted: 3, duplicates: 0, ignored: 0, rejected: [] });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] as [string, Loose, Loose];
    expect(name).toBe("telegram_events");
    expect(data).toMatchObject({ jobType: "telegram_events", events: { kind: "delete", channelIdentifier: `tg_chat_${CHAT_ID}`, chatId: String(CHAT_ID), messageIds: ["10", "20", "30"], capture: { captureMethod: "api_live", clientObservedAt: "2026-10-22T12:00:00Z" } } });
    expect(opts.jobId).toMatch(/^tg-events-del-tg_chat_-1001000000001-[0-9a-f]{12}$/);
    expect(JSON.stringify(data)).not.toMatch(/"text"|rawText/);
    expect((await post(del([20, 30, 10]))).json()).toMatchObject({ accepted: 0, duplicates: 3 });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe("caps", () => {
  it("hourly live cap: requests that would exceed it get 429 with Retry-After and queue nothing", async () => {
    const { post, queue } = await make({ captureCaps: { liveMessagesPerHour: 3 } });
    expect((await post(live([msg(1), msg(2)]))).statusCode).toBe(200);
    const res = await post(live([msg(3), msg(4)]));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(res.json()).toMatchObject({ reason: "volume_cap" });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect((await post(live([msg(5)]))).statusCode).toBe(200); // still fits (3 of 3)
    expect((await post(del([1]))).statusCode).toBe(429);       // deletions count against the same live window
  });
  it("daily history cap is separate from the live cap", async () => {
    const { post, queue } = await make({ captureCaps: { historyMessagesPerDay: 2, liveMessagesPerHour: 100 } });
    expect((await post(history([msg(1), msg(2), msg(3)]))).statusCode).toBe(429);
    expect(queue.add).not.toHaveBeenCalled();
    expect((await post(history([msg(1), msg(2)]))).statusCode).toBe(200);
    expect((await post(live([msg(9)]))).statusCode).toBe(200);
  });
  it("request-rate cap counts only authenticated requests", async () => {
    const { post } = await make({ captureCaps: { requestsPerMinute: 2 } });
    for (let i = 0; i < 6; i += 1) expect((await post(live([msg(100 + i)]), {}, "bad".padEnd(40, "z"))).statusCode).toBe(401);
    expect((await post(live([msg(1)]))).statusCode).toBe(200);
    expect((await post(live([msg(2)]))).statusCode).toBe(200);
    const res = await post(live([msg(3)]));
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("queue failures and log hygiene", () => {
  it("a Redis outage becomes a generic 503 that leaks nothing", async () => {
    const queue = fakeQueue();
    queue.getJob.mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED redis://:secret@host ${CANARY}`), { code: "ECONNREFUSED" }));
    const { post } = await make({ telegramQueue: queue });
    const res = await post(live([msg(1)]));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ message: "Service Unavailable" });
    expect(res.body).not.toMatch(/secret|ECONNREFUSED|redis/i);
    expect(res.body).not.toContain(CANARY);
  });
  it("an enqueue timeout is a 503 and an unexpected enqueue error a generic 500", async () => {
    const hanging = fakeQueue();
    hanging.add.mockImplementation(() => new Promise(() => undefined));
    const slow = await make({ telegramQueue: hanging, enqueueTimeoutMs: 250 });
    expect((await slow.post(live([msg(1)]))).statusCode).toBe(503);
    const broken = fakeQueue();
    broken.add.mockRejectedValue(new Error(`boom ${CANARY}`));
    const bad = await make({ telegramQueue: broken });
    const res = await bad.post(live([msg(1)]));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(CANARY);
  });
  it("logs contain ids, counts and reason codes only: never the text, the token, entities or the body", async () => {
    const { post, records } = await make();
    await post(live([msg(1, { entities: [{ type: "text_link", offset: 0, length: 1, url: `https://example.invalid/${CANARY}` }] })]));
    await post(live([msg(1)]), {}, "wrong".padEnd(40, "z"));
    await post(live([msg(2)], { chat: { id: OTHER, type: "channel" } }));
    await post(live([{ ...msg(3), bad: CANARY }]));
    const dump = JSON.stringify(records);
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain("wrong".padEnd(40, "z"));
    const accepted = records.find((r) => r.event === "capture.ingest.accepted");
    expect(accepted).toMatchObject({ captureMethod: "api_live", ingestEvent: "message", accepted: 1, statusCode: 200 });
  });
});
