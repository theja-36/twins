import { eq } from "drizzle-orm";
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

async function resolveTelegramSource(db: Db, channelIdentifier: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.telegramSources.id })
    .from(schema.telegramSources)
    .where(eq(schema.telegramSources.channelIdentifier, channelIdentifier));
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(schema.telegramSources)
    .values({ channelIdentifier })
    .onConflictDoNothing({ target: schema.telegramSources.channelIdentifier })
    .returning({ id: schema.telegramSources.id });
  if (inserted) return inserted.id;

  const [afterRace] = await db
    .select({ id: schema.telegramSources.id })
    .from(schema.telegramSources)
    .where(eq(schema.telegramSources.channelIdentifier, channelIdentifier));
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
export async function ingestTelegramMessages(
  db: Db,
  provider: TelegramProvider,
  params: TelegramFetchParams,
): Promise<IngestTelegramSummary> {
  const messages = await provider.fetchMessages(params);
  const telegramSourceId = await resolveTelegramSource(db, params.channelIdentifier);

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

    const [inserted] = await db
      .insert(schema.telegramMessages)
      .values({
        telegramSourceId,
        externalMessageId: message.externalMessageId,
        messageTimestamp: message.messageTimestamp,
        receivedAt: new Date(),
        rawText: message.rawText,
        rawPayload: message.rawPayload,
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
