import type { ProviderHealthSnapshot } from "./common";

export interface TelegramFetchParams {
  channelIdentifier: string;
  /** Fetch only messages after this external message id (adapter-defined ordering). */
  sinceExternalMessageId?: string;
}

/**
 * A raw Telegram message as translated by the adapter - Tier E, never a
 * source of truth (spec section 11/18). `rawText` is untrusted external
 * content (spec section 27) and must be preserved verbatim, never
 * modified, by whatever ingests this (spec section 18).
 */
export interface NormalizedTelegramMessage {
  channelIdentifier: string;
  externalMessageId: string;
  messageTimestamp: Date;
  rawText: string;
  rawPayload?: unknown;
  /**
   * Telegram's own message_id of the ORIGINAL message (same chat). Equals
   * externalMessageId for originals; shared by every revision of the message.
   */
  originMessageId?: string;
  /** Telegram `edit_date` for a revision (its effective time); absent for originals. */
  editDate?: Date;
  /**
   * Telegram chat.id (stringified): the canonical, stable channel identity for new
   * events. `channelIdentifier` is derived from it (`tg_chat_<id>`); @username/title
   * are mutable display metadata only.
   */
  chatId?: string;
  /** Mutable display metadata (e.g. "@username" or the chat title); never an identity. */
  channelDisplayName?: string;
  /**
   * Telegram update_id: identifies an UPDATE (a repeat delivery of the same update
   * carries the same id). Kept for audit; it is not the content-revision identity.
   */
  updateId?: number;
}

/** TelegramProvider (spec section 43). */
export interface TelegramProvider {
  readonly providerName: string;
  fetchMessages(params: TelegramFetchParams): Promise<NormalizedTelegramMessage[]>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
