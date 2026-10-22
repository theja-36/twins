import type { NormalizedTelegramMessage } from "@twins/types";
import { revisionExternalId } from "./revisionId.js";

/** Provider name recorded for rows captured through the read-only User API session (live updates and history import). */
export const USER_CAPTURE_PROVIDER_NAME = "telegram-user-capture";

export type UserCaptureMethod = "api_live" | "api_history";
export const USER_CAPTURE_METHODS: readonly UserCaptureMethod[] = ["api_live", "api_history"];

export interface UserCaptureChat {
  /** Telegram chat id of the channel (the `-100...` form). */
  id: number;
  type: "channel";
  title?: string;
}

export interface UserCaptureEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

/** Media METADATA only. No file is ever downloaded or stored. */
export interface UserCaptureMedia {
  kind: string;
  mime?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  fileUniqueId?: string;
}

export interface UserCaptureMessage {
  id: number;
  /** Unix seconds of the ORIGINAL message. */
  date: number;
  /** Unix seconds of the latest edit, when the message has been edited. */
  editDate?: number;
  /** The message text, or the caption of a media message. Untrusted external content, stored verbatim. */
  text?: string;
  entities?: UserCaptureEntity[];
  media?: UserCaptureMedia;
  views?: number;
  forwards?: number;
  authorSignature?: string;
  hasProtectedContent?: boolean;
}

export const USER_CAPTURE_CHANNEL_PREFIX = "tg_chat_";

/** Canonical channel identity for a chat id; identical to the one the Bot API adapter derives. */
export function channelIdentifierOf(chatId: number): string {
  return `${USER_CAPTURE_CHANNEL_PREFIX}${chatId}`;
}

/**
 * Translates one User API message into the existing normalized message shape, so the verified ingestion pipeline (source
 * resolution, immutable storage, revision identity, parser) is reused unchanged.
 *
 * - Returns `null` for a message without text/caption (nothing to store; the row needs raw text), like the Bot API path.
 * - An original keeps its plain message id; an edited message is keyed by the SHARED revision identity, so the original
 *   text is never overwritten and the same edit seen twice (live, then in history) collapses to one row.
 * - `rawPayload` keeps the received message object as validated (text, entities, media metadata, counters).
 */
export function normalizeUserCaptureMessage(chat: UserCaptureChat, message: UserCaptureMessage): NormalizedTelegramMessage | null {
  const text = message.text;
  if (typeof text !== "string" || text.length === 0) return null;
  const originMessageId = String(message.id);
  const edited = message.editDate !== undefined;
  const base: NormalizedTelegramMessage = {
    channelIdentifier: channelIdentifierOf(chat.id),
    chatId: String(chat.id),
    ...(chat.title ? { channelDisplayName: chat.title } : {}),
    externalMessageId: edited ? revisionExternalId(originMessageId, message.editDate as number, text) : originMessageId,
    originMessageId,
    messageTimestamp: new Date(message.date * 1000),
    rawText: text,
    rawPayload: { source: USER_CAPTURE_PROVIDER_NAME, chat: { id: chat.id, type: chat.type }, message },
  };
  return edited ? { ...base, editDate: new Date((message.editDate as number) * 1000) } : base;
}
