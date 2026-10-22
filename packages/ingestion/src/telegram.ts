import { and, eq, or } from "drizzle-orm";
import { schema } from "@twins/database";
import type { TelegramFetchParams, TelegramProvider } from "@twins/types";
import type { Db } from "./db";
import { checkTelegramMessageQuality } from "./dataQuality";

export interface IngestTelegramSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  rejectedInvalid: number;
  [key: string]: unknown;
}

export interface TelegramSourceRef {
  /** Legacy/derived identifier (`@username` for legacy rows, `tg_chat_<id>` for new events). */
  channelIdentifier: string;
  /** Canonical Telegram chat.id when known (new events). */
  chatId?: string | undefined;
  /** Mutable display metadata (username/title); never an identity. */
  displayName?: string | undefined;
}

async function findSource(db: Db, where: ReturnType<typeof eq>) {
  const [row] = await db
    .select({
      id: schema.telegramSources.id,
      chatId: schema.telegramSources.chatId,
      displayName: schema.telegramSources.displayName,
    })
    .from(schema.telegramSources)
    .where(where);
  return row;
}

/**
 * Resolves (creating if needed) the telegram_sources row for a channel.
 *
 * With a chat.id the identity is the chat id, never the @username: a renamed
 * channel keeps its source. Legacy username-only sources are NOT merged by
 * guessing; the only adoption done here is of a source whose identifier is
 * itself `tg_chat_<id>` (the legacy fallback name already encodes the id).
 * Without a chat id (old queued jobs) it falls back to the identifier, as before.
 */
export async function resolveTelegramSource(db: Db, ref: TelegramSourceRef): Promise<string> {
  const { channelIdentifier, chatId, displayName } = ref;

  if (chatId) {
    const byChat = await findSource(db, eq(schema.telegramSources.chatId, chatId));
    if (byChat) {
      if (displayName && byChat.displayName !== displayName) {
        await db
          .update(schema.telegramSources)
          .set({ displayName, updatedAt: new Date() })
          .where(eq(schema.telegramSources.id, byChat.id));
      }
      return byChat.id;
    }
    const byEncodedId = await findSource(db, eq(schema.telegramSources.channelIdentifier, channelIdentifier));
    if (byEncodedId && byEncodedId.chatId === null && channelIdentifier === `tg_chat_${chatId}`) {
      await db
        .update(schema.telegramSources)
        .set({ chatId, ...(displayName ? { displayName } : {}), updatedAt: new Date() })
        .where(eq(schema.telegramSources.id, byEncodedId.id));
      return byEncodedId.id;
    }
    const [inserted] = await db
      .insert(schema.telegramSources)
      .values({ channelIdentifier, chatId, displayName: displayName ?? null })
      .onConflictDoNothing()
      .returning({ id: schema.telegramSources.id });
    if (inserted) return inserted.id;
    const afterRace = await findSource(db, eq(schema.telegramSources.chatId, chatId));
    if (afterRace) return afterRace.id;
    throw new Error(
      `failed to resolve telegram source for chat ${chatId}: identifier ${channelIdentifier} is held by a different source`,
    );
  }

  const existing = await findSource(db, eq(schema.telegramSources.channelIdentifier, channelIdentifier));
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(schema.telegramSources)
    .values({ channelIdentifier })
    .onConflictDoNothing({ target: schema.telegramSources.channelIdentifier })
    .returning({ id: schema.telegramSources.id });
  if (inserted) return inserted.id;
  const afterRace = await findSource(db, eq(schema.telegramSources.channelIdentifier, channelIdentifier));
  if (!afterRace) throw new Error(`failed to resolve telegram source ${channelIdentifier}`);
  return afterRace.id;
}

/**
 * Raw Telegram ingestion only (spec section 18). No signal extraction,
 * no AI interpretation, no execution path - `rawText`/`rawPayload` are
 * stored byte-for-byte as untrusted external content (spec section 27)
 * and are never modified once written (there is no update path here or
 * anywhere else in this package for `telegram_messages`).
 */
export type CaptureMethodName = "bot_webhook" | "api_live" | "api_history";

/**
 * How the messages of one ingestion call were obtained. Omitted (or `bot_webhook`) = the original Bot API path, which
 * stays exactly as it was: the row gets the column defaults (`capture_method='bot_webhook'`, no `observed_at`).
 * For `api_live` / `api_history` the migration-0007 constraints apply: `observedAt` is required, and `importedAt` is
 * required if and only if the method is `api_history`.
 */
export interface IngestProvenance {
  captureMethod: CaptureMethodName;
  observedAt?: Date;
  importedAt?: Date;
}

export async function ingestTelegramMessages(
  db: Db,
  provider: TelegramProvider,
  params: TelegramFetchParams,
  provenance?: IngestProvenance,
): Promise<IngestTelegramSummary> {
  const capture = provenance && provenance.captureMethod !== "bot_webhook" ? provenance : undefined;
  if (capture) {
    if (!capture.observedAt) throw new Error("observedAt is required for api_live and api_history captures");
    if ((capture.captureMethod === "api_history") !== (capture.importedAt !== undefined)) {
      throw new Error("importedAt is required for api_history and forbidden for api_live");
    }
  }
  const messages = await provider.fetchMessages(params);
  const sourceCache = new Map<string, string>();

  const summary: IngestTelegramSummary = {
    fetched: messages.length,
    inserted: 0,
    duplicates: 0,
    rejectedInvalid: 0,
  };

  for (const message of messages) {
    const quality = checkTelegramMessageQuality({
      externalMessageId: message.externalMessageId,
      messageTimestamp: message.messageTimestamp,
      rawText: message.rawText,
    });
    if (!quality.valid) {
      summary.rejectedInvalid += 1;
      continue;
    }

    const sourceKey = `${message.chatId ?? ""}|${message.channelIdentifier || params.channelIdentifier}`;
    let telegramSourceId = sourceCache.get(sourceKey);
    if (!telegramSourceId) {
      telegramSourceId = await resolveTelegramSource(db, {
        channelIdentifier: message.channelIdentifier || params.channelIdentifier,
        chatId: message.chatId,
        displayName: message.channelDisplayName,
      });
      sourceCache.set(sourceKey, telegramSourceId);
    }

    // First observation already edited (typical for history import): no earlier row of this message exists, so the stored
    // text is a LATER revision. It is stored under the revision identity (never as the plain id), flagged here once, at INSERT.
    let firstSeenEdited = false;
    if (capture && message.editDate !== undefined && message.originMessageId !== undefined) {
      const [earlier] = await db
        .select({ id: schema.telegramMessages.id })
        .from(schema.telegramMessages)
        .where(
          and(
            eq(schema.telegramMessages.telegramSourceId, telegramSourceId),
            or(
              eq(schema.telegramMessages.originMessageId, message.originMessageId),
              eq(schema.telegramMessages.externalMessageId, message.originMessageId),
            ),
          ),
        )
        .limit(1);
      firstSeenEdited = earlier === undefined;
    }

    const [inserted] = await db
      .insert(schema.telegramMessages)
      .values({
        telegramSourceId,
        externalMessageId: message.externalMessageId,
        originMessageId: message.originMessageId ?? null,
        editDate: message.editDate ?? null,
        messageTimestamp: message.messageTimestamp,
        receivedAt: new Date(),
        rawText: message.rawText,
        rawPayload: message.rawPayload,
        ...(capture
          ? {
              captureMethod: capture.captureMethod,
              observedAt: capture.observedAt ?? null,
              importedAt: capture.importedAt ?? null,
              firstSeenEdited,
            }
          : {}),
      })
      .onConflictDoNothing({
        target: [
          schema.telegramMessages.telegramSourceId,
          schema.telegramMessages.externalMessageId,
        ],
      })
      .returning({ id: schema.telegramMessages.id });

    if (inserted) {
      summary.inserted += 1;
    } else {
      summary.duplicates += 1;
    }
  }

  return summary;
}
