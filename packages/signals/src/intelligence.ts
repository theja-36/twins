import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { assessTelegramMessage } from "@twins/dataquality";
import type { Db } from "./db";
import { gatherMarketContext } from "./context/market";
import { gatherMacroContext, type MacroContextOptions } from "./context/macro";
import { gatherNewsContext } from "./context/news";
import { gatherPriorSignalStats } from "./context/priorSignals";
import type { SignalIntelligence } from "./types";

export interface BuildSignalIntelligenceOptions {
  macro?: MacroContextOptions;
  newsLimit?: number;
}

async function linkEvidenceOnce(
  db: Db,
  signalId: string,
  evidenceKind: "market_observation" | "macro_observation" | "news_evidence",
  columnValue: string,
  column: "marketObservationId" | "macroObservationId" | "newsEvidenceId",
): Promise<void> {
  const existing = await db
    .select({ id: schema.signalEvidence.id })
    .from(schema.signalEvidence)
    .where(
      and(
        eq(schema.signalEvidence.signalId, signalId),
        eq(schema.signalEvidence[column], columnValue),
      ),
    );
  if (existing.length > 0) return;

  await db.insert(schema.signalEvidence).values({
    signalId,
    evidenceKind,
    [column]: columnValue,
  });
}

/**
 * Assembles the structured, evidence-backed intelligence for one signal
 * (spec: External Telegram Signal -> ... -> Signal Intelligence ->
 * evidence-backed structured result -> [FUTURE] Decision Engine).
 *
 * This function makes NO trading decision, calls NO AI/LLM, and never
 * interprets the Telegram message text as anything other than the
 * literal source of the already-extracted structured fields on `signal`
 * (spec section 27/61) - it only gathers and links evidence, then marks
 * the signal `analyzed`. Every gap in available evidence is recorded in
 * `dataCompletenessNotes` rather than silently ignored (spec section 2).
 */
export async function buildSignalIntelligence(
  db: Db,
  signalId: string,
  options: BuildSignalIntelligenceOptions = {},
): Promise<SignalIntelligence> {
  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) throw new Error(`signals row not found: ${signalId}`);

  const [instrument] = await db
    .select()
    .from(schema.instruments)
    .where(eq(schema.instruments.id, signal.instrumentId));
  if (!instrument) throw new Error(`instruments row not found: ${signal.instrumentId}`);

  const notes: string[] = [];

  let originalTelegramMessage: typeof schema.telegramMessages.$inferSelect | undefined;
  let telegramMessageQuality: SignalIntelligence["telegramMessageQuality"];
  if (signal.telegramMessageId) {
    const [message] = await db
      .select()
      .from(schema.telegramMessages)
      .where(eq(schema.telegramMessages.id, signal.telegramMessageId));
    originalTelegramMessage = message;
    if (message) {
      telegramMessageQuality = await assessTelegramMessage(db, message.id);
    }
  }

  const marketContext = await gatherMarketContext(db, signal.instrumentId);
  if (!marketContext) notes.push(`no market_observations found for instrument ${instrument.symbol}`);
  else await linkEvidenceOnce(db, signalId, "market_observation", marketContext.observation.id, "marketObservationId");

  const macroContext = await gatherMacroContext(db, options.macro);
  if (macroContext.length === 0) notes.push("no macro_observations available");
  for (const observation of macroContext) {
    await linkEvidenceOnce(db, signalId, "macro_observation", observation.id, "macroObservationId");
  }

  const newsContext = await gatherNewsContext(db, instrument.id, { limit: options.newsLimit });
  if (newsContext.length === 0) {
    notes.push(`no news_evidence found mentioning "${instrument.symbol}"`);
  }
  for (const item of newsContext) {
    await linkEvidenceOnce(db, signalId, "news_evidence", item.id, "newsEvidenceId");
  }

  const priorSignalStats = await gatherPriorSignalStats(db, signal.instrumentId, signalId);

  await db
    .update(schema.signals)
    .set({ status: "analyzed", updatedAt: new Date() })
    .where(eq(schema.signals.id, signalId));

  const [updated] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));

  return {
    signal: updated ?? signal,
    originalTelegramMessage,
    telegramMessageQuality,
    marketContext,
    macroContext,
    newsContext,
    priorSignalStats,
    dataCompletenessNotes: notes,
    generatedAt: new Date(),
  };
}
