import { chatIdOfQueuedMessage, type TelegramIntakePolicy, type UserCaptureMethod } from "@twins/adapter-telegram";
import type { Db } from "@twins/database";
import { recordDeletionEvents, resolveTelegramSource } from "@twins/ingestion";
import type { StructuredLogger } from "@twins/shared";
import { InvalidJobInputError } from "./jobErrors.js";
import { parseJobTimestamp } from "./jobTimestamp.js";

/**
 * Provenance of a User API capture as carried in the job payload (BullMQ serialises dates to ISO strings). Absent on the
 * original Bot API webhook jobs, which keep their existing path unchanged.
 */
export interface CapturePayload {
  captureMethod: UserCaptureMethod;
  /** API clock when the capture endpoint accepted the content. */
  observedAt: string | Date;
  /** Set if and only if `captureMethod` is `api_history`. */
  importedAt?: string | Date;
  importBatchId?: string;
  clientObservedAt?: string;
}

export interface ParsedCapture {
  captureMethod: UserCaptureMethod;
  observedAt: Date;
  importedAt?: Date;
  importBatchId?: string;
  clientObservedAt?: string;
}

const CAPTURE_KEYS = new Set(["captureMethod", "observedAt", "importedAt", "importBatchId", "clientObservedAt"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^[1-9][0-9]{0,15}$/;

/** Strict parse of the capture provenance in a job payload. Anything malformed is permanent invalid input (never guessed). */
export function parseCapture(value: unknown): ParsedCapture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidJobInputError("capture metadata must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!CAPTURE_KEYS.has(key)) throw new InvalidJobInputError("capture metadata has an unknown field");
  const method = raw["captureMethod"];
  if (method !== "api_live" && method !== "api_history") throw new InvalidJobInputError("capture metadata has an unsupported captureMethod");
  const observedAt = parseJobTimestamp(raw["observedAt"], "capture.observedAt");
  const hasImported = raw["importedAt"] !== undefined && raw["importedAt"] !== null;
  if ((method === "api_history") !== hasImported) throw new InvalidJobInputError("capture.importedAt must be present exactly for api_history");
  const out: ParsedCapture = { captureMethod: method, observedAt };
  if (hasImported) out.importedAt = parseJobTimestamp(raw["importedAt"], "capture.importedAt");
  const batch = raw["importBatchId"];
  if (batch !== undefined) {
    if (typeof batch !== "string" || !UUID.test(batch)) throw new InvalidJobInputError("capture.importBatchId must be a UUID");
    out.importBatchId = batch.toLowerCase();
  }
  const client = raw["clientObservedAt"];
  if (client !== undefined) {
    if (typeof client !== "string" || client.length > 40) throw new InvalidJobInputError("capture.clientObservedAt is not acceptable");
    out.clientObservedAt = client;
  }
  return out;
}

/** Queue payload for observed deletions. It carries message IDS only: no text, ever. */
export interface TelegramEventsJobPayload {
  jobType: "telegram_events";
  providerName: string;
  correlation?: { correlationId: string; requestId: string; receivedAt: string };
  events: {
    kind: "delete";
    channelIdentifier: string;
    chatId: string;
    messageIds: string[];
    capture: CapturePayload;
  };
}

export type TelegramEventsOutcome =
  | { outcome: "events_recorded"; recorded: number; duplicates: number; unknownMessages: number }
  | { outcome: "chat_not_approved"; reasonCodes: string[] };

export interface TelegramEventsOptions {
  logger: StructuredLogger;
  intakePolicy: Pick<TelegramIntakePolicy, "isChatApproved">;
}

/**
 * Records observed deletions. Nothing here writes to `telegram_messages`: a deletion is an append-only event, linked to the
 * stored message when there is one. The approved-chat gate runs before any database access.
 */
export async function processTelegramEventsJob(payload: TelegramEventsJobPayload, db: Db, options: TelegramEventsOptions): Promise<TelegramEventsOutcome> {
  const events = payload?.events;
  if (!events || events.kind !== "delete") throw new InvalidJobInputError("unsupported events job");
  if (typeof events.channelIdentifier !== "string" || typeof events.chatId !== "string") throw new InvalidJobInputError("events job lacks its chat identity");
  const ids = events.messageIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== "string" || !MESSAGE_ID.test(id))) {
    throw new InvalidJobInputError("events job has invalid message ids");
  }
  const chatId = chatIdOfQueuedMessage({ chatId: events.chatId, channelIdentifier: events.channelIdentifier });
  if (!options.intakePolicy.isChatApproved(chatId)) {
    options.logger.warn("worker.intake.chat_rejected", { reason: chatId === null ? "chat_id_unusable" : "chat_not_approved", chatId });
    return { outcome: "chat_not_approved", reasonCodes: [chatId === null ? "chat.id_unusable" : "chat.not_approved"] };
  }
  const capture = parseCapture(events.capture);
  const telegramSourceId = await resolveTelegramSource(db, { channelIdentifier: events.channelIdentifier, chatId: events.chatId });
  const summary = await recordDeletionEvents(db, {
    telegramSourceId,
    messageIds: ids,
    captureMethod: capture.captureMethod,
    observedAt: capture.observedAt,
    meta: {
      ...(capture.importBatchId ? { importBatchId: capture.importBatchId } : {}),
      ...(capture.clientObservedAt ? { clientObservedAt: capture.clientObservedAt } : {}),
    },
  });
  options.logger.info("worker.events.deletions_recorded", { ...summary });
  return { outcome: "events_recorded", ...summary };
}
