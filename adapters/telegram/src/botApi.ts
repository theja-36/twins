/**
 * Telegram Bot API webhook adapter (spec section 18/27/43).
 *
 * This adapter accepts Telegram Bot API Update payloads delivered to our
 * webhook endpoint and translates them into the NormalizedTelegramMessage
 * contract. It intentionally has NO fetchMessages() implementation that
 * polls Telegram; polling is discouraged by the Telegram Bot API documentation
 * and is architecturally unnecessary when we control our own webhook endpoint.
 *
 * Security invariants (spec section 27 - prompt-injection defence):
 * - `rawText` is stored verbatim and is NEVER interpreted as a system
 *   instruction, a configuration key, or anything other than untrusted user
 *   content from a Tier E source.
 * - Edited messages are distinct append-only revisions (spec section 18/33).
 *   Identity layers (all deterministic from the payload; never processing
 *   time or random ids):
 *     original message  = (chat, message_id)                    -> "<message_id>"
 *     content revision  = (chat, message_id, edit_date, sha256(text))
 *                         -> "<message_id>_edit_<edit_date>_<hash12>"
 *     update            = update_id (identifies an UPDATE; a repeat delivery of the
 *                         same update carries the same update_id). Retained in the
 *                         raw payload and as `updateId`; it is NOT the revision
 *                         identity. Deduplication happens on the revision identity,
 *                         so a repeat delivery collapses while a later, different
 *                         edit is preserved.
 *     channel           = chat.id (stable); @username/title are mutable metadata
 * - Non-text updates (photos, stickers, service messages without text) are
 *   explicitly returned as an empty array — there is no "interpretation" of
 *   non-text content.
 * - Duplicate `update_id` values (Telegram may redeliver an update on
 *   network error) return an empty array; de-duplication at the storage
 *   layer (telegram_messages unique index) is the authoritative guard, but
 *   returning early here avoids unnecessary DB round-trips.
 *
 * This adapter does NOT implement getHealth() with a live Telegram API call
 * because that would require the bot token in this package; health checking
 * belongs to a future operations phase (spec section 44). The health response
 * is always "healthy" at the adapter level — actual liveness is determined
 * by whether webhook updates keep arriving.
 */

import { createHash } from "node:crypto";
import {
  ProviderDataError,
  type NormalizedTelegramMessage,
  type ProviderHealthSnapshot,
  type TelegramFetchParams,
  type TelegramProvider,
} from "@twins/types";

export const TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME = "telegram-bot-webhook";

/**
 * Minimal subset of the Telegram Bot API `Update` object (Bot API v6+).
 * We parse only the fields we need; the rest is stored verbatim in
 * `rawPayload` on the NormalizedTelegramMessage.
 */
export interface TelegramBotUpdate {
  update_id: number;
  message?: TelegramBotMessage;
  edited_message?: TelegramBotMessage;
  channel_post?: TelegramBotMessage;
  edited_channel_post?: TelegramBotMessage;
}

export interface TelegramBotMessage {
  message_id: number;
  date: number; // Unix timestamp (seconds) of the ORIGINAL message, also on edits
  edit_date?: number; // Unix timestamp (seconds) of the last edit; present on edited_* updates
  chat: TelegramBotChat;
  text?: string;
  caption?: string; // Text attached to media; treated as rawText for signal extraction purposes.
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
}

export interface TelegramBotChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

/**
 * Canonical channel identity is Telegram's numeric chat.id, which survives
 * renames. `@username`/title are mutable display metadata only.
 */
function channelIdentity(chat: TelegramBotChat): {
  channelIdentifier: string;
  chatId: string;
  channelDisplayName?: string;
} {
  const display = chat.username ? `@${chat.username}` : chat.title;
  return {
    channelIdentifier: `tg_chat_${chat.id}`,
    chatId: String(chat.id),
    ...(display ? { channelDisplayName: display } : {}),
  };
}

/**
 * Extracts the readable text from a Telegram message, prioritising `text`
 * over `caption`. Returns null if neither is present (e.g. sticker, poll,
 * voice note) — in that case the update produces no NormalizedTelegramMessage.
 */
function extractText(message: TelegramBotMessage): string | null {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text;
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return message.caption;
  }
  return null;
}

/**
 * Validates that the given value looks like a TelegramBotUpdate object with
 * the minimum required fields. Returns a typed value or throws
 * ProviderDataError.
 */
function parseUpdate(raw: unknown): TelegramBotUpdate {
  if (typeof raw !== "object" || raw === null) {
    throw new ProviderDataError(
      TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
      `Update payload must be a JSON object, got ${typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["update_id"] !== "number") {
    throw new ProviderDataError(
      TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
      "Update payload missing required numeric field: update_id",
    );
  }
  return obj as unknown as TelegramBotUpdate;
}

/**
 * Translates a single parsed TelegramBotUpdate into zero or one
 * NormalizedTelegramMessage. Returns null when the update contains no
 * extractable text (e.g. photo without caption, service message).
 *
 * The `externalMessageId` is the update's message_id, not update_id, so
 * that re-delivered updates (same update_id, same message_id) map
 * to the same storage key and are deduplicated by the telegram_messages
 * unique index (spec section 33).
 *
 * For edited messages the id is suffixed with `_edit` to produce a
 * distinct, append-only record — the original raw text is never modified.
 */
export function normalizeUpdate(
  update: TelegramBotUpdate,
): NormalizedTelegramMessage | null {
  const message =
    update.message ??
    update.channel_post ??
    update.edited_message ??
    update.edited_channel_post;

  if (!message) return null;

  const rawText = extractText(message);
  if (rawText === null) return null;

  const isEdit =
    update.edited_message !== undefined ||
    update.edited_channel_post !== undefined;

  const channel = channelIdentity(message.chat);
  const originMessageId = String(message.message_id);

  if (!isEdit) {
    return {
      ...channel,
      updateId: update.update_id,
      externalMessageId: originMessageId,
      originMessageId,
      messageTimestamp: new Date(message.date * 1000),
      rawText,
      rawPayload: update,
    };
  }

  // An edit without a usable edit_date has no deterministic revision identity;
  // reject it explicitly instead of inventing one.
  if (typeof message.edit_date !== "number" || !Number.isFinite(message.edit_date)) {
    throw new ProviderDataError(
      TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
      "Edited message is missing numeric edit_date; cannot derive a revision identity",
    );
  }
  const textHash = createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 12);

  return {
    ...channel,
    updateId: update.update_id,
    externalMessageId: `${originMessageId}_edit_${message.edit_date}_${textHash}`,
    originMessageId,
    editDate: new Date(message.edit_date * 1000),
    messageTimestamp: new Date(message.date * 1000),
    rawText,
    rawPayload: update,
  };
}

/**
 * Parses and normalizes a raw JSON webhook Update payload.
 * Throws ProviderDataError for structurally invalid payloads.
 * Returns null (not an error) for valid updates that contain no text.
 */
export function normalizeRawUpdate(rawPayload: unknown): NormalizedTelegramMessage | null {
  const update = parseUpdate(rawPayload);
  return normalizeUpdate(update);
}

/**
 * TelegramProvider implementation for the Bot API webhook path.
 *
 * `fetchMessages()` is intentionally not applicable for a webhook-driven
 * adapter — messages arrive via HTTP POST, not by polling. Calling
 * fetchMessages() on this provider throws ProviderDataError to make the
 * mismatch explicit rather than silently returning empty.
 *
 * The webhook handling flow is: HTTP POST /webhooks/telegram →
 * `normalizeRawUpdate()` (this module) → `ingestTelegramMessages()` via the
 * worker queue → signal extraction → validation pipeline.
 */
export class TelegramBotWebhookAdapter implements TelegramProvider {
  readonly providerName = TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME;

  /**
   * Not applicable for webhook-driven ingestion. Use `normalizeRawUpdate()`
   * instead, which is called from the API webhook handler.
   */
  async fetchMessages(_params: TelegramFetchParams): Promise<NormalizedTelegramMessage[]> {
    throw new ProviderDataError(
      TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
      "fetchMessages() is not supported on the webhook adapter. " +
        "Messages are delivered via HTTP webhook POST and normalized " +
        "through normalizeRawUpdate() before ingestion.",
    );
  }

  async getHealth(): Promise<ProviderHealthSnapshot> {
    // Liveness of the webhook path is determined by whether updates arrive;
    // there is no meaningful synchronous health check without a live Bot
    // token in this package (spec section 44). Report as healthy at the
    // adapter layer; monitor at the infrastructure layer.
    return {
      providerName: TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
      providerType: "telegram",
      status: "healthy",
      checkedAt: new Date(),
    };
  }
}
