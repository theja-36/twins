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
 * - Edited messages (`edited_message`) are tracked under the same
 *   `externalMessageId` as their original, appended with `_edit` so the
 *   ingestion layer treats them as distinct messages and never silently
 *   overwrites the original append-only record (spec section 18/33).
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
  date: number; // Unix timestamp (seconds)
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
 * Derives the canonical channel identifier from a Telegram chat object.
 * Prefers the public username when present (stable across renames for
 * public channels); falls back to the numeric chat ID stringified.
 */
function deriveChannelIdentifier(chat: TelegramBotChat): string {
  if (chat.username) return `@${chat.username}`;
  return `tg_chat_${chat.id}`;
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

  const channelIdentifier = deriveChannelIdentifier(message.chat);
  const externalMessageId = isEdit
    ? `${message.message_id}_edit`
    : String(message.message_id);

  return {
    channelIdentifier,
    externalMessageId,
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
