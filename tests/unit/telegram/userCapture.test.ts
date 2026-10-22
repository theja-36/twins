import { describe, expect, it } from "vitest";
import {
  USER_CAPTURE_METHODS,
  USER_CAPTURE_PROVIDER_NAME,
  channelIdentifierOf,
  normalizeRawUpdate,
  normalizeUserCaptureMessage,
  revisionExternalId,
  revisionHash12,
  textSha256Hex,
  type UserCaptureChat,
  type UserCaptureMessage,
} from "../../../adapters/telegram/src/index";

const CHAT_ID = -1001000000001; // synthetic
const chat: UserCaptureChat = { id: CHAT_ID, type: "channel", title: "Test Channel" };
const TEXT = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
const base: UserCaptureMessage = { id: 837678, date: 1_700_000_000, text: TEXT };

describe("shared revision identity", () => {
  it("is `<origin>_edit_<edit date>_<sha256-12>` and deterministic", () => {
    const id = revisionExternalId("837678", 1_700_000_100, TEXT);
    expect(id).toMatch(/^837678_edit_1700000100_[0-9a-f]{12}$/);
    expect(id).toBe(revisionExternalId("837678", 1_700_000_100, TEXT));
    expect(id.endsWith(textSha256Hex(TEXT).slice(0, 12))).toBe(true);
    expect(revisionHash12(TEXT)).toBe(textSha256Hex(TEXT).slice(0, 12));
  });
  it("changes with the text, the edit date and the origin id", () => {
    const a = revisionExternalId("1", 100, "x");
    expect(revisionExternalId("1", 100, "y")).not.toBe(a);
    expect(revisionExternalId("1", 101, "x")).not.toBe(a);
    expect(revisionExternalId("2", 100, "x")).not.toBe(a);
  });
  it("is IDENTICAL across the Bot API adapter and the User API adapter for the same edit (one identity rule, so paths collapse)", () => {
    for (const text of [TEXT, "plain", "multi\nline  text ", "emoji \u{1F680} and ‮right-to-left", "  leading and trailing  "]) {
      const bot = normalizeRawUpdate({ update_id: 5, edited_channel_post: { message_id: 42, date: 1_700_000_000, edit_date: 1_700_000_500, chat: { id: CHAT_ID, type: "channel" }, text } });
      const user = normalizeUserCaptureMessage(chat, { id: 42, date: 1_700_000_000, editDate: 1_700_000_500, text });
      expect(bot?.externalMessageId).toBeDefined();
      expect(user?.externalMessageId).toBe(bot?.externalMessageId);
      expect(user?.originMessageId).toBe(bot?.originMessageId);
      expect(user?.channelIdentifier).toBe(bot?.channelIdentifier);
      expect(user?.chatId).toBe(bot?.chatId);
      expect(user?.editDate?.getTime()).toBe(bot?.editDate?.getTime());
    }
  });
  it("an original keeps the same plain id in both adapters", () => {
    const bot = normalizeRawUpdate({ update_id: 6, channel_post: { message_id: 42, date: 1_700_000_000, chat: { id: CHAT_ID, type: "channel" }, text: TEXT } });
    const user = normalizeUserCaptureMessage(chat, { id: 42, date: 1_700_000_000, text: TEXT });
    expect(user?.externalMessageId).toBe("42");
    expect(user?.externalMessageId).toBe(bot?.externalMessageId);
  });
});

describe("normalizeUserCaptureMessage", () => {
  it("maps an original message to the existing normalized shape", () => {
    const m = normalizeUserCaptureMessage(chat, { ...base, views: 10, forwards: 2, authorSignature: "desk" });
    expect(m).toMatchObject({
      channelIdentifier: channelIdentifierOf(CHAT_ID),
      chatId: String(CHAT_ID),
      channelDisplayName: "Test Channel",
      externalMessageId: "837678",
      originMessageId: "837678",
      rawText: TEXT,
    });
    expect(m?.messageTimestamp).toEqual(new Date(1_700_000_000_000));
    expect(m?.editDate).toBeUndefined();
    expect(channelIdentifierOf(CHAT_ID)).toBe(`tg_chat_${CHAT_ID}`);
  });
  it("an edit becomes a revision under the shared identity; the original id is never reused for edited text", () => {
    const m = normalizeUserCaptureMessage(chat, { ...base, editDate: 1_700_000_100, text: "edited text" });
    expect(m?.externalMessageId).toBe(revisionExternalId("837678", 1_700_000_100, "edited text"));
    expect(m?.externalMessageId).not.toBe("837678");
    expect(m?.originMessageId).toBe("837678");
    expect(m?.editDate).toEqual(new Date(1_700_000_100_000));
    expect(m?.messageTimestamp).toEqual(new Date(1_700_000_000_000)); // the ORIGINAL message time
  });
  it("stores the text byte-for-byte (no trimming, normalisation or escaping)", () => {
    for (const text of ["  padded  ", "line1\r\nline2\n\n", "tab\there", "‮rtl‬", "emoji \u{1F680}", "<script>alert(1)</script>", "'; DROP TABLE x; --", "a".repeat(20_000), "\u0000nul"]) {
      expect(normalizeUserCaptureMessage(chat, { ...base, text })?.rawText).toBe(text);
    }
  });
  it("returns null when there is nothing to store (no text or caption)", () => {
    expect(normalizeUserCaptureMessage(chat, { id: 1, date: 1_700_000_000, media: { kind: "photo" } })).toBeNull();
    expect(normalizeUserCaptureMessage(chat, { id: 1, date: 1_700_000_000, text: "" })).toBeNull();
  });
  it("keeps the received message (entities and media METADATA) in rawPayload and never invents media content", () => {
    const received: UserCaptureMessage = {
      ...base,
      entities: [{ type: "bold", offset: 0, length: 3 }],
      media: { kind: "photo", mime: "image/jpeg", size: 1234, width: 10, height: 20, fileUniqueId: "AgAD" },
      hasProtectedContent: false,
    };
    const m = normalizeUserCaptureMessage(chat, received);
    const payload = m?.rawPayload as { source: string; chat: { id: number; type: string }; message: UserCaptureMessage };
    expect(payload.source).toBe(USER_CAPTURE_PROVIDER_NAME);
    expect(payload.chat).toEqual({ id: CHAT_ID, type: "channel" });
    expect(payload.message).toEqual(received);
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\//); // no file URLs
  });
  it("does not mutate its input", () => {
    const input: UserCaptureMessage = { ...base, entities: [{ type: "bold", offset: 0, length: 1 }] };
    const snapshot = JSON.stringify(input);
    normalizeUserCaptureMessage(chat, input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it("omits the display name when the channel has no title", () => {
    expect(normalizeUserCaptureMessage({ id: CHAT_ID, type: "channel" }, base)).not.toHaveProperty("channelDisplayName");
  });
  it("exposes exactly the two capture methods and a distinct provider name", () => {
    expect([...USER_CAPTURE_METHODS]).toEqual(["api_live", "api_history"]);
    expect(USER_CAPTURE_PROVIDER_NAME).toBe("telegram-user-capture");
  });
});
