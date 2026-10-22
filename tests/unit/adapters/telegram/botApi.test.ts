/**
 * Unit tests for the Telegram Bot API webhook adapter.
 * Tests normalizeRawUpdate(), normalizeUpdate(), and TelegramBotWebhookAdapter.
 */

import { describe, expect, it } from "vitest";
import {
  TelegramBotWebhookAdapter,
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  normalizeRawUpdate,
  normalizeUpdate,
  type TelegramBotUpdate,
} from "../../../../adapters/telegram/src/botApi";
import { ProviderDataError } from "../../../../packages/types/src/providers/common";

function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeUpdate(overrides: Partial<TelegramBotUpdate> = {}): TelegramBotUpdate {
  return {
    update_id: 100,
    message: {
      message_id: 42,
      date: 1700000000,
      chat: { id: -1001234567890, type: "channel", username: "trading_signals" },
      text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
    },
    ...overrides,
  };
}

// ─── normalizeUpdate ─────────────────────────────────────────────────────────

describe("normalizeUpdate – normal text messages", () => {
  it("uses chat.id as the canonical channel identity; @username is mutable display metadata", () => {
    const msg = normalizeUpdate(makeUpdate());
    expect(msg?.channelIdentifier).toBe("tg_chat_-1001234567890");
    expect(msg?.chatId).toBe("-1001234567890");
    expect(msg?.channelDisplayName).toBe("@trading_signals");
  });

  it("keeps the same identity when the username changes or is absent", () => {
    const renamed = makeUpdate();
    req(renamed.message).chat.username = "renamed_channel";
    const noName = makeUpdate();
    delete req(noName.message).chat.username;
    expect(normalizeUpdate(renamed)?.channelIdentifier).toBe("tg_chat_-1001234567890");
    expect(normalizeUpdate(noName)?.channelIdentifier).toBe("tg_chat_-1001234567890");
    expect(normalizeUpdate(noName)?.channelDisplayName).toBeUndefined();
  });

  it("retains update_id for audit without using it as the message identity", () => {
    const msg = normalizeUpdate(makeUpdate());
    expect(msg?.updateId).toBe(100);
    expect(msg?.externalMessageId).toBe("42");
  });

  it("uses message_id as externalMessageId (not update_id)", () => {
    const msg = normalizeUpdate(makeUpdate());
    expect(msg?.externalMessageId).toBe("42");
  });

  it("preserves rawText verbatim", () => {
    const update = makeUpdate();
    const rawText = "BUY RELIANCE @ 2800 SL 2750 TGT 2900";
    update.message!.text = rawText;
    const msg = normalizeUpdate(update);
    expect(msg?.rawText).toBe(rawText);
  });

  it("converts Unix timestamp to Date correctly", () => {
    const msg = normalizeUpdate(makeUpdate());
    expect(msg?.messageTimestamp).toEqual(new Date(1700000000 * 1000));
  });

  it("stores the raw update object in rawPayload", () => {
    const update = makeUpdate();
    const msg = normalizeUpdate(update);
    expect(msg?.rawPayload).toStrictEqual(update);
  });
});

describe("normalizeUpdate – edited messages (deterministic revision identity)", () => {
  const edit = (over: Record<string, unknown> = {}, text = "BUY RELIANCE @ 2810 SL 2760 TGT 2910", updateId = 101): TelegramBotUpdate => ({
    update_id: updateId,
    edited_message: {
      message_id: 42,
      date: 1700000000,
      edit_date: 1700001000,
      chat: { id: -1001234567890, type: "channel", username: "trading_signals" },
      text,
      ...over,
    },
  });

  it("derives original/revision identity from message_id, edit_date and content hash", () => {
    const msg = req(normalizeUpdate(edit()));
    expect(msg.externalMessageId).toMatch(/^42_edit_1700001000_[0-9a-f]{12}$/);
    expect(msg.originMessageId).toBe("42");
    expect(msg.editDate?.getTime()).toBe(1700001000 * 1000);
    expect(msg.messageTimestamp.getTime()).toBe(1700000000 * 1000); // original send time
  });

  it("repeat delivery of the same update (same update_id) and an identical revision map to one identity", () => {
    expect(req(normalizeUpdate(edit({}, undefined, 101))).externalMessageId).toBe(
      req(normalizeUpdate(edit({}, undefined, 999))).externalMessageId,
    );
  });

  it("keeps a second, genuinely different edit distinct (later edit_date)", () => {
    const first = req(normalizeUpdate(edit()));
    const second = req(normalizeUpdate(edit({ edit_date: 1700002000 }, "BUY RELIANCE @ 2820 SL 2770 TGT 2920")));
    expect(second.externalMessageId).not.toBe(first.externalMessageId);
    expect(second.originMessageId).toBe(first.originMessageId);
  });

  it("keeps same-second edits with different text distinct (content hash)", () => {
    const a = req(normalizeUpdate(edit()));
    const b = req(normalizeUpdate(edit({}, "BUY RELIANCE @ 2999 SL 2760 TGT 2910")));
    expect(a.externalMessageId).not.toBe(b.externalMessageId);
  });

  it("works for edited_channel_post", () => {
    const msg = req(normalizeUpdate({
      update_id: 102,
      edited_channel_post: { message_id: 55, date: 1, edit_date: 2, chat: { id: -1001234567890, type: "channel" }, text: "SELL INFY @ 1500" },
    }));
    expect(msg.externalMessageId).toMatch(/^55_edit_2_[0-9a-f]{12}$/);
  });

  it("rejects an edit without edit_date instead of inventing an identity", () => {
    const upd = edit();
    delete upd.edited_message!.edit_date;
    expect(() => normalizeUpdate(upd)).toThrow(ProviderDataError);
  });

  it("originals carry originMessageId equal to their external id and no editDate", () => {
    const msg = req(normalizeUpdate(makeUpdate()));
    expect(msg.externalMessageId).toBe("42");
    expect(msg.originMessageId).toBe("42");
    expect(msg.editDate).toBeUndefined();
  });
});

describe("normalizeUpdate – non-text messages", () => {
  it("returns null for update with no message field", () => {
    const update: TelegramBotUpdate = { update_id: 103 };
    expect(normalizeUpdate(update)).toBeNull();
  });

  it("returns null for message with no text and no caption", () => {
    const update = makeUpdate();
    delete update.message!.text;
    expect(normalizeUpdate(update)).toBeNull();
  });

  it("uses caption as rawText when text is absent (media with caption)", () => {
    const update = makeUpdate();
    delete update.message!.text;
    update.message!.caption = "BUY TCS @ 3500 SL 3450 TGT 3600";
    const msg = normalizeUpdate(update);
    expect(msg?.rawText).toBe("BUY TCS @ 3500 SL 3450 TGT 3600");
  });

  it("returns null for empty text field", () => {
    const update = makeUpdate();
    update.message!.text = "";
    expect(normalizeUpdate(update)).toBeNull();
  });
});

describe("normalizeUpdate – channel_post", () => {
  it("handles channel_post the same as message", () => {
    const update: TelegramBotUpdate = {
      update_id: 104,
      channel_post: {
        message_id: 77,
        date: 1700003000,
        chat: { id: -1001111111111, type: "channel", username: "nse_signals" },
        text: "SELL WIPRO @ 450 SL 460 TGT 430",
      },
    };
    const msg = normalizeUpdate(update);
    expect(msg?.channelIdentifier).toBe("tg_chat_-1001111111111");
    expect(msg?.externalMessageId).toBe("77");
    expect(msg?.rawText).toContain("SELL WIPRO");
  });
});

// ─── normalizeRawUpdate ──────────────────────────────────────────────────────

describe("normalizeRawUpdate – structural validation", () => {
  it("throws ProviderDataError for non-object payload", () => {
    expect(() => normalizeRawUpdate("bad")).toThrow(ProviderDataError);
    expect(() => normalizeRawUpdate(null)).toThrow(ProviderDataError);
    expect(() => normalizeRawUpdate(42)).toThrow(ProviderDataError);
  });

  it("throws ProviderDataError when update_id is missing", () => {
    expect(() => normalizeRawUpdate({ message: {} })).toThrow(ProviderDataError);
  });

  it("throws ProviderDataError when update_id is not a number", () => {
    expect(() => normalizeRawUpdate({ update_id: "100" })).toThrow(ProviderDataError);
  });

  it("returns null for valid but text-free update", () => {
    const update = { update_id: 200, message: { message_id: 1, date: 1700000000, chat: { id: 1, type: "private" } } };
    expect(normalizeRawUpdate(update)).toBeNull();
  });

  it("returns NormalizedTelegramMessage for valid text update", () => {
    const update = makeUpdate();
    const msg = normalizeRawUpdate(update);
    expect(msg).not.toBeNull();
    expect(msg?.rawText).toContain("BUY RELIANCE");
  });
});

// ─── Duplicate update_id idempotency note ────────────────────────────────────

describe("normalizeRawUpdate – duplicate updates produce identical messages", () => {
  it("same update_id with same message_id yields same externalMessageId", () => {
    const update = makeUpdate();
    const msg1 = normalizeRawUpdate(update);
    const msg2 = normalizeRawUpdate(update);
    expect(msg1?.externalMessageId).toBe(msg2?.externalMessageId);
    expect(msg1?.channelIdentifier).toBe(msg2?.channelIdentifier);
  });
});

// ─── TelegramBotWebhookAdapter ───────────────────────────────────────────────

describe("TelegramBotWebhookAdapter", () => {
  const adapter = new TelegramBotWebhookAdapter();

  it("has correct providerName", () => {
    expect(adapter.providerName).toBe(TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME);
  });

  it("getHealth returns healthy status", async () => {
    const health = await adapter.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.providerType).toBe("telegram");
    expect(health.providerName).toBe(TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME);
  });

  it("fetchMessages throws ProviderDataError (polling not supported)", async () => {
    await expect(
      adapter.fetchMessages({ channelIdentifier: "@test" }),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });
});
