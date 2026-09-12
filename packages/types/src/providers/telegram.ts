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
}

/** TelegramProvider (spec section 43). */
export interface TelegramProvider {
  readonly providerName: string;
  fetchMessages(params: TelegramFetchParams): Promise<NormalizedTelegramMessage[]>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
