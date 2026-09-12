import { createAdapterRegistry } from "@twins/shared";
import type { TelegramProvider } from "@twins/types";

/**
 * Registry of TelegramProvider adapters, keyed by provider name (e.g. a
 * specific MTProto/Bot API client wrapper). No concrete implementation
 * yet - Telegram is Tier E and never a source of truth (spec section
 * 11/18).
 */
export const telegramProviders = createAdapterRegistry<TelegramProvider>(
  "telegram",
);

export type {
  NormalizedTelegramMessage,
  ProviderHealthSnapshot,
  TelegramFetchParams,
  TelegramProvider,
} from "@twins/types";
