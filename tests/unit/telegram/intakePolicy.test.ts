import { describe, expect, it } from "vitest";
import {
  MAX_ALLOWED_CHAT_IDS,
  TelegramPolicyConfigError,
  chatIdOfQueuedMessage,
  createTelegramIntakePolicy,
  describeUpdateChat,
  loadTelegramIntakePolicy,
  parseAllowedChatIds,
  parseOptionsOnly,
  selectUpdateMessage,
} from "../../../adapters/telegram/src/index";

describe("TWINS_TELEGRAM_ALLOWED_CHAT_IDS parsing (strict, fail-closed)", () => {
  it("missing, empty or whitespace-only approves NO chat", () => {
    for (const raw of [undefined, "", "   ", "\n\t "]) expect([...parseAllowedChatIds(raw)], JSON.stringify(raw)).toEqual([]);
    const p = createTelegramIntakePolicy({});
    expect(p.approvedChatCount).toBe(0);
    for (const id of ["123", "-1001234567890", 123, -1, "", null, undefined]) expect(p.isChatApproved(id as never)).toBe(false);
  });
  it("accepts canonical integer ids, trims whitespace around entries and de-duplicates", () => {
    expect([...parseAllowedChatIds("-1001234567890, 42 ,42,7")].sort()).toEqual(["-1001234567890", "42", "7"].sort());
    expect(createTelegramIntakePolicy({ allowedChatIds: "42,42" }).approvedChatCount).toBe(1);
  });
  it("malformed values throw (never ignored, narrowed or widened) and the message never echoes the entry", () => {
    const bad = ["*", "all", "ANY", "@mychannel", "12.5", "1e3", "0", "-0", "+5", "007", "-", "--5", "0x1F", "1 2", "9007199254740993", "٣", "1,,2", ",", "1,", ",1", " , ", "12abc", "-1001234567890;DROP", "%", "null", "undefined"];
    for (const raw of bad) {
      let message = "";
      expect(() => { try { parseAllowedChatIds(raw); } catch (e) { message = (e as Error).message; throw e; } }, JSON.stringify(raw)).toThrow(TelegramPolicyConfigError);
      for (const fragment of raw.split(/[ ,]/).filter((x) => x.length > 2)) expect(message, `echo of ${JSON.stringify(fragment)}`).not.toContain(fragment);
    }
  });
  it("one bad entry rejects the WHOLE value (a valid neighbour does not survive)", () => {
    expect(() => parseAllowedChatIds("42,*")).toThrow(TelegramPolicyConfigError);
    expect(() => parseAllowedChatIds("42,abc,43")).toThrow(TelegramPolicyConfigError);
  });
  it("bounds the number of entries", () => {
    const many = Array.from({ length: MAX_ALLOWED_CHAT_IDS + 1 }, (_, i) => String(i + 1)).join(",");
    expect(() => parseAllowedChatIds(many)).toThrow(/more than/);
    expect(parseAllowedChatIds(many.split(",").slice(0, MAX_ALLOWED_CHAT_IDS).join(",")).size).toBe(MAX_ALLOWED_CHAT_IDS);
  });
});

describe("isChatApproved", () => {
  const p = createTelegramIntakePolicy({ allowedChatIds: "-1001234567890,42" });
  it("approves exactly the listed chats, as number or canonical string", () => {
    expect(p.isChatApproved("-1001234567890")).toBe(true);
    expect(p.isChatApproved(-1001234567890)).toBe(true);
    expect(p.isChatApproved("42")).toBe(true);
    expect(p.isChatApproved(42)).toBe(true);
  });
  it("rejects everything else, including near misses and unusable values", () => {
    for (const id of ["43", 43, "-42", "1001234567890", "-1001234567891", " 42", "42 ", "042", "42.0", 42.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "", "tg_chat_42", null, undefined, {} as never]) {
      expect(p.isChatApproved(id as never), String(id)).toBe(false);
    }
  });
});

describe("TWINS_TELEGRAM_OPTIONS_ONLY parsing", () => {
  it("unset/empty = false, exactly true/false accepted, anything else throws (a typo cannot silently disable the mode)", () => {
    expect(parseOptionsOnly(undefined)).toBe(false);
    expect(parseOptionsOnly("")).toBe(false);
    expect(parseOptionsOnly("true")).toBe(true);
    expect(parseOptionsOnly("false")).toBe(false);
    for (const raw of ["1", "0", "yes", "no", "True", "TRUE", " true", "true ", "on", "enabled"]) expect(() => parseOptionsOnly(raw), raw).toThrow(TelegramPolicyConfigError);
  });
  it("loadTelegramIntakePolicy reads both variables and fails on a malformed one", () => {
    const p = loadTelegramIntakePolicy({ TWINS_TELEGRAM_ALLOWED_CHAT_IDS: "5", TWINS_TELEGRAM_OPTIONS_ONLY: "true" });
    expect(p.optionsOnly).toBe(true);
    expect(p.isChatApproved(5)).toBe(true);
    expect(loadTelegramIntakePolicy({}).approvedChatCount).toBe(0);
    expect(() => loadTelegramIntakePolicy({ TWINS_TELEGRAM_ALLOWED_CHAT_IDS: "*" })).toThrow(TelegramPolicyConfigError);
    expect(() => loadTelegramIntakePolicy({ TWINS_TELEGRAM_ALLOWED_CHAT_IDS: "5", TWINS_TELEGRAM_OPTIONS_ONLY: "maybe" })).toThrow(TelegramPolicyConfigError);
  });
});

describe("which chat is checked: the SAME message the normalizer ingests", () => {
  const chat = (id: unknown, type = "channel") => ({ id, type });
  const body = (extra: Record<string, unknown>) => ({ update_id: 1, ...extra });
  it("covers all four supported update kinds", () => {
    for (const kind of ["message", "channel_post", "edited_message", "edited_channel_post"] as const) {
      const d = describeUpdateChat(body({ [kind]: { message_id: 1, date: 1, chat: chat(-100123), text: "x" } }));
      expect(d).toEqual({ kind, chatId: "-100123", chatType: "channel" });
    }
  });
  it("uses the documented precedence when several message fields are present (no approved/unapproved mix-up)", () => {
    const d = describeUpdateChat(body({ edited_message: { chat: chat(222) }, channel_post: { chat: chat(111) }, message: { chat: chat(999) } }));
    expect(d?.kind).toBe("message");
    expect(d?.chatId).toBe("999");
    expect(selectUpdateMessage(body({ edited_channel_post: { chat: chat(3) }, edited_message: { chat: chat(2) } }) as never)?.kind).toBe("edited_message");
  });
  it("an update with no message returns null; an unusable chat id is reported as null, never coerced", () => {
    expect(describeUpdateChat(body({ callback_query: { id: "x" } }))).toBeNull();
    expect(describeUpdateChat(null)).toBeNull();
    expect(describeUpdateChat("text")).toBeNull();
    for (const id of ["123", 1.5, Number.NaN, 0, 2 ** 60, null, undefined, {}, []]) expect(describeUpdateChat(body({ message: { chat: chat(id) } }))?.chatId, String(id)).toBeNull();
    expect(describeUpdateChat(body({ message: {} }))?.chatId).toBeNull();
    expect(describeUpdateChat(body({ message: { chat: chat(5, "weird") } }))?.chatType).toBeNull();
  });
});

describe("chat id of a queued job", () => {
  it("uses chatId, falls back to the tg_chat_<id> identifier, and requires them to agree", () => {
    expect(chatIdOfQueuedMessage({ chatId: "-1001", channelIdentifier: "tg_chat_-1001" })).toBe("-1001");
    expect(chatIdOfQueuedMessage({ channelIdentifier: "tg_chat_-1001" })).toBe("-1001");
    expect(chatIdOfQueuedMessage({ chatId: "-1001" })).toBe("-1001");
  });
  it("is null (never approved) for legacy names, contradictions and unusable ids", () => {
    for (const m of [{ channelIdentifier: "@somechannel" }, { channelIdentifier: "chan-abc" }, { chatId: "5", channelIdentifier: "tg_chat_6" }, { chatId: "abc" }, { chatId: "05" }, { chatId: "" }, {}, { channelIdentifier: "tg_chat_" }, { channelIdentifier: "tg_chat_0" }, { channelIdentifier: "tg_chat_-05" }]) {
      expect(chatIdOfQueuedMessage(m as never), JSON.stringify(m)).toBeNull();
    }
  });
});
