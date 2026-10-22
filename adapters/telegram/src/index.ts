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
  selectUpdateMessage,
  describeUpdateChat,
} from "./botApi.js";
export {
  TelegramPolicyConfigError,
  MAX_ALLOWED_CHAT_IDS,
  parseAllowedChatIds,
  parseOptionsOnly,
  createTelegramIntakePolicy,
  loadTelegramIntakePolicy,
  chatIdOfQueuedMessage,
} from "./intakePolicy.js";
export type { TelegramIntakePolicy } from "./intakePolicy.js";
export type {
  TelegramUpdateKind,
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
