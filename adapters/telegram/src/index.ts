import { createAdapterRegistry } from "@twins/shared";
import type { TelegramProvider } from "@twins/types";

/**
 * Registry of TelegramProvider adapters, keyed by provider name (e.g. a
 * specific MTProto/Bot API client wrapper). Telegram is Tier E and never
 * a source of truth (spec section 11/18).
 */
export const telegramProviders = createAdapterRegistry<TelegramProvider>(
  "telegram",
);

// Concrete adapters.
export {
  TelegramBotWebhookAdapter,
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  normalizeRawUpdate,
  normalizeUpdate,
} from "./botApi.js";
export type {
  TelegramBotUpdate,
  TelegramBotMessage,
  TelegramBotChat,
} from "./botApi.js";

export type {
  NormalizedTelegramMessage,
  ProviderHealthSnapshot,
  TelegramFetchParams,
  TelegramProvider,
} from "@twins/types";
