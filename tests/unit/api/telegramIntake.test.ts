import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../apps/api/src/index"; // the REAL buildApp: no test-wide allow-all policy here
import { createTelegramIntakePolicy } from "../../../adapters/telegram/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const API_KEY = "intake-test-api-key";
const SECRET = "intake-test-webhook-secret";
const APPROVED = -1001234567890;
const OTHER = -1009999999999;
const TEXT = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";

const approvedOnly = () => createTelegramIntakePolicy({ allowedChatIds: String(APPROVED) });

async function make(policy?: ReturnType<typeof createTelegramIntakePolicy>) {
  const add = vi.fn().mockResolvedValue({ id: "fake" });
  const records: LogRecord[] = [];
  const app = await buildApp({
    apiKey: API_KEY,
    telegramWebhookSecret: SECRET,
    telegramQueue: { add },
    structuredLogger: createStructuredLogger((r) => records.push(r)),
    ...(policy ? { telegramIntakePolicy: policy } : {}),
  });
  const post = (payload: unknown, secret: string | null = SECRET) =>
    app.inject({ method: "POST", url: "/webhooks/telegram", headers: { "content-type": "application/json", ...(secret !== null ? { "x-telegram-bot-api-secret-token": secret } : {}) }, payload: payload as never });
  return { app, add, records, post };
}
const msg = (chatId: unknown, extra: Record<string, unknown> = {}) => ({ message_id: 77, date: 1_700_000_000, chat: { id: chatId, type: "channel", username: "someone" }, text: TEXT, ...extra });

const ENV_KEYS = ["TWINS_TELEGRAM_ALLOWED_CHAT_IDS", "TWINS_TELEGRAM_OPTIONS_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("approved-chat gate in the webhook", () => {
  it("accepts all four supported update kinds from an approved chat (202, one job each)", async () => {
    const { post, add } = await make(approvedOnly());
    const updates: Array<[string, Record<string, unknown>]> = [
      ["message", { update_id: 1, message: msg(APPROVED) }],
      ["channel_post", { update_id: 2, channel_post: msg(APPROVED, { message_id: 78 }) }],
      ["edited_message", { update_id: 3, edited_message: msg(APPROVED, { message_id: 79, edit_date: 1_700_000_100 }) }],
      ["edited_channel_post", { update_id: 4, edited_channel_post: msg(APPROVED, { message_id: 80, edit_date: 1_700_000_100 }) }],
    ];
    for (const [kind, update] of updates) {
      const r = await post(update);
      expect(r.statusCode, kind).toBe(202);
    }
    expect(add).toHaveBeenCalledTimes(4);
  });

  it("an unapproved chat is acknowledged as ignored, creates NO job, for all four update kinds", async () => {
    const { post, add, records } = await make(approvedOnly());
    const updates: Array<[string, Record<string, unknown>]> = [
      ["message", { update_id: 11, message: msg(OTHER) }],
      ["channel_post", { update_id: 12, channel_post: msg(OTHER) }],
      ["edited_message", { update_id: 13, edited_message: msg(OTHER, { edit_date: 1_700_000_100 }) }],
      ["edited_channel_post", { update_id: 14, edited_channel_post: msg(OTHER, { edit_date: 1_700_000_100 }) }],
    ];
    for (const [kind, update] of updates) {
      const r = await post(update);
      expect(r.statusCode, kind).toBe(200);
      expect(r.json(), kind).toEqual({ status: "ignored", reason: "not accepted" });
    }
    expect(add).not.toHaveBeenCalled();
    const rejected = records.filter((r) => r.event === "webhook.intake.chat_rejected");
    expect(rejected).toHaveLength(4);
    expect(rejected.map((r) => r["updateKind"])).toEqual(["message", "channel_post", "edited_message", "edited_channel_post"]);
    expect(rejected.every((r) => r["reason"] === "chat_not_approved" && r["chatId"] === String(OTHER) && r["chatType"] === "channel")).toBe(true);
  });

  it("rejection logs carry minimal metadata only: never the text, the sender, the secret or the raw update", async () => {
    const { post, records } = await make(approvedOnly());
    await post({ update_id: 21, message: msg(OTHER, { text: "SECRET-TEXT-12345 buy", from: { id: 4242, username: "private_person", first_name: "Private" } }) });
    const dump = JSON.stringify(records);
    for (const forbidden of ["SECRET-TEXT-12345", "private_person", "Private", "4242", SECRET, API_KEY, "someone"]) expect(dump, forbidden).not.toContain(forbidden);
    const rec = records.find((r) => r.event === "webhook.intake.chat_rejected");
    expect(Object.keys(rec ?? {}).filter((k) => !["ts", "level", "event", "service", "requestId", "correlationId", "correlationSource"].includes(k)).sort()).toEqual(["approvedChats", "chatId", "chatType", "reason", "statusCode", "updateKind"]);
  });

  it("with the default policy (variable unset) NO chat is accepted", async () => {
    delete process.env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"];
    const { post, add } = await make(); // no injected policy: read from the environment
    const r = await post({ update_id: 31, message: msg(APPROVED) });
    expect(r.statusCode).toBe(200);
    expect(add).not.toHaveBeenCalled();
    process.env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"] = "   ";
    const second = await make();
    expect((await second.post({ update_id: 32, message: msg(APPROVED) })).statusCode).toBe(200);
    expect(second.add).not.toHaveBeenCalled();
  });

  it("the environment variable approves exactly the listed chats", async () => {
    process.env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"] = `${APPROVED}`;
    const { post, add } = await make();
    expect((await post({ update_id: 41, message: msg(APPROVED) })).statusCode).toBe(202);
    expect((await post({ update_id: 42, message: msg(OTHER) })).statusCode).toBe(200);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a malformed allowlist makes the API refuse to start (it never narrows, ignores or widens)", async () => {
    for (const raw of ["*", "all", "12abc", `${APPROVED},,${OTHER}`, "0"]) {
      process.env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"] = raw;
      const err = await make().then(() => undefined, (e: unknown) => e as Error);
      expect(err?.message, raw).toMatch(/invalid Telegram intake configuration/);
      expect(err?.message, raw).not.toContain(raw);
    }
    process.env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"] = String(APPROVED);
    process.env["TWINS_TELEGRAM_OPTIONS_ONLY"] = "yes";
    await expect(make()).rejects.toThrow(/OPTIONS_ONLY must be exactly/);
  });

  it("approval follows the message that would be ingested: a decoy approved chat in a lower-precedence field cannot smuggle an unapproved chat in", async () => {
    const { post, add } = await make(approvedOnly());
    // `message` (unapproved) wins the selection, so this is rejected even though edited_message names an approved chat.
    const r1 = await post({ update_id: 51, message: msg(OTHER), edited_message: msg(APPROVED, { edit_date: 1_700_000_100 }) });
    expect(r1.json()).toEqual({ status: "ignored", reason: "not accepted" });
    // The reverse: the approved chat is the one selected and ingested.
    const r2 = await post({ update_id: 52, message: msg(APPROVED), edited_message: msg(OTHER, { edit_date: 1_700_000_100 }) });
    expect(r2.statusCode).toBe(202);
    expect(add).toHaveBeenCalledTimes(1);
    const job = add.mock.calls[0]?.[1] as { telegram: { normalizedMessage: { chatId: string } } };
    expect(job.telegram.normalizedMessage.chatId).toBe(String(APPROVED));
  });

  it("unusable chat ids are never approved (string id, float, zero, missing chat)", async () => {
    const { post, add, records } = await make(approvedOnly());
    for (const chat of [{ id: String(APPROVED), type: "channel" }, { id: 1.5, type: "channel" }, { id: 0, type: "channel" }, { type: "channel" }, null]) {
      const r = await post({ update_id: 61, message: { message_id: 1, date: 1, chat, text: TEXT } });
      expect(r.statusCode).toBe(200);
    }
    expect(add).not.toHaveBeenCalled();
    expect(records.filter((r) => r["reason"] === "chat_id_unusable").length).toBe(5);
  });

  it("updates without an ingestible message stay ignored and enqueue nothing", async () => {
    const { post, add } = await make(approvedOnly());
    expect((await post({ update_id: 71, callback_query: { id: "x" } })).json()).toMatchObject({ status: "ignored" });
    expect((await post({ update_id: 72, my_chat_member: { chat: { id: APPROVED } } })).statusCode).toBe(200);
    expect((await post({ update_id: 73, message: { message_id: 1, date: 1, chat: { id: APPROVED, type: "channel" } } })).json()).toEqual({ status: "ignored", reason: "no text content" });
    expect(add).not.toHaveBeenCalled();
  });

  it("the webhook secret is still required first, whatever the chat", async () => {
    const { post, add } = await make(approvedOnly());
    expect((await post({ update_id: 81, message: msg(APPROVED) }, "wrong")).statusCode).toBe(403);
    expect((await post({ update_id: 82, message: msg(APPROVED) }, null)).statusCode).toBe(403);
    expect(add).not.toHaveBeenCalled();
  });
});
