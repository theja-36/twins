import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { checkTelegramMessageQuality } from "@twins/ingestion";
import type { Db } from "../db";
import { type DimensionOutcome, summarizeAssessment, type QualityAssessmentResult } from "../types";

/**
 * Telegram is Tier E and NEVER a source of truth (spec section 11/18).
 * That is encoded here as a deterministic, always-applicable
 * source_reliability failure - a Telegram message can never come out of
 * this engine as "trusted" on its own, only "flagged" at best, which is
 * intentional: any actual trading relevance has to come from independent
 * corroboration in a later phase, never from the raw message alone.
 *
 * Completeness/consistency/cross-source-conflict/anomaly do not apply to
 * unstructured free text.
 */
export async function assessTelegramMessage(
  db: Db,
  messageId: string,
): Promise<QualityAssessmentResult> {
  const [row] = await db
    .select()
    .from(schema.telegramMessages)
    .innerJoin(
      schema.telegramSources,
      eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id),
    )
    .where(eq(schema.telegramMessages.id, messageId));
  if (!row) throw new Error(`telegram_messages row not found: ${messageId}`);

  const message = row.telegram_messages;
  const evaluatedAt = new Date();
  const outcomes: DimensionOutcome[] = [];

  const structural = checkTelegramMessageQuality({
    externalMessageId: message.externalMessageId,
    messageTimestamp: message.messageTimestamp,
    rawText: message.rawText,
  });
  outcomes.push({
    dimension: "validity",
    ruleId: "validity.structural_check",
    passed: structural.valid,
    applicable: true,
    detail: structural.valid ? undefined : structural.reasons.join("; "),
  });

  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.no_future_observation",
    passed: message.messageTimestamp.getTime() <= evaluatedAt.getTime(),
    applicable: true,
  });
  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.received_after_observed",
    passed: message.receivedAt.getTime() >= message.messageTimestamp.getTime(),
    applicable: true,
    detail:
      message.receivedAt.getTime() < message.messageTimestamp.getTime()
        ? "received_at precedes message_timestamp"
        : undefined,
  });

  const duplicateRows = await db
    .select({ id: schema.telegramMessages.id })
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramSourceId, message.telegramSourceId),
        eq(schema.telegramMessages.externalMessageId, message.externalMessageId),
      ),
    );
  outcomes.push({
    dimension: "uniqueness",
    ruleId: "uniqueness.dedupe_key",
    passed: duplicateRows.length === 1,
    applicable: true,
    detail: duplicateRows.length > 1 ? `${duplicateRows.length} rows share this key` : undefined,
  });

  outcomes.push({
    dimension: "source_reliability",
    ruleId: "source_reliability.telegram_tier_e",
    passed: false,
    applicable: true,
    detail: "Telegram is Tier E (community signal) and is never treated as a source of truth",
  });

  outcomes.push({
    dimension: "lineage",
    ruleId: "lineage.source_resolves",
    passed: true,
    applicable: true,
  });

  const assessment = summarizeAssessment(
    { entityType: "telegram_messages", entityId: messageId, source: row.telegram_sources.channelIdentifier },
    outcomes,
  );
  assessment.evaluatedAt = evaluatedAt;
  return assessment;
}
