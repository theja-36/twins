import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { resolveInstrument } from "@twins/ingestion";
import type { Db } from "./db";
import { parseTelegramSignal } from "./extract";

export interface CreateSignalOptions {
  /** Telegram messages don't carry an exchange - the caller (a per-channel
   * config, not the message text) supplies which exchange its symbols
   * belong to. Never guessed from the message. */
  exchange: string;
  instrumentType: string;
}

export interface CreateSignalOutcome {
  created: boolean;
  signalId?: string;
  reason?: string;
}

/**
 * Structures a raw, already-ingested Telegram message into a `signals`
 * row (spec section 18/19/61 - the signal is an input, not a decision).
 * If the message text does not match a recognizable BUY/SELL directive,
 * no row is created - fabricating a structured signal out of unrelated
 * chatter would be worse than having none.
 */
export async function createSignalFromTelegramMessage(
  db: Db,
  telegramMessageId: string,
  options: CreateSignalOptions,
): Promise<CreateSignalOutcome> {
  const [message] = await db
    .select()
    .from(schema.telegramMessages)
    .where(eq(schema.telegramMessages.id, telegramMessageId));
  if (!message) throw new Error(`telegram_messages row not found: ${telegramMessageId}`);

  const parsed = parseTelegramSignal(message.rawText);
  if (!parsed) {
    return { created: false, reason: "no recognizable BUY/SELL directive in message text" };
  }

  const instrumentId = await resolveInstrument(
    db,
    { symbol: parsed.symbol, exchange: options.exchange },
    options.instrumentType,
  );

  const [row] = await db
    .insert(schema.signals)
    .values({
      sourceType: "telegram",
      telegramMessageId,
      instrumentId,
      direction: parsed.direction,
      entryPrice: parsed.entryPrice?.toString(),
      stopLoss: parsed.stopLoss?.toString(),
      targets: parsed.targets,
      timeframe: parsed.timeframe,
      extractedConfidence: parsed.extractedConfidence?.toString(),
      status: "pending",
      signalTimestamp: message.messageTimestamp,
    })
    .returning({ id: schema.signals.id });
  if (!row) throw new Error("failed to insert signals row");

  return { created: true, signalId: row.id };
}
