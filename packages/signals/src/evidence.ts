import type { schema } from "@twins/database";
import type { QualityAssessmentResult } from "@twins/dataquality";
import type { MarketContext } from "./context/market";

/**
 * Phase 8 - "Evidence Normalisation" pipeline stage. Every evidence
 * domain (market/macro/news/telegram/event) has a different shape;
 * downstream consumers (conflict detection, freshness assessment, a
 * future Decision Engine) shouldn't each need to know all of them. This
 * is a read-only projection - the underlying typed rows are still
 * available on the richer report fields; nothing here replaces them.
 */
export type EvidenceKind =
  | "market_observation"
  | "macro_observation"
  | "news_evidence"
  | "telegram_message"
  | "entity_event";

export interface NormalizedEvidenceItem {
  kind: EvidenceKind;
  id: string;
  /** The evidence's own timestamp (observed/source/message time - never receivedAt). */
  timestamp: Date;
  source: string;
  summary: string;
  /** Present only for domains Phase 5 assesses (market/macro/news/telegram). Absent for entity/event items, which aren't independently quality-scored. */
  quality?: QualityAssessmentResult | undefined;
}

export function normalizeMarketContext(context: MarketContext | null): NormalizedEvidenceItem[] {
  if (!context) return [];
  return [
    {
      kind: "market_observation",
      id: context.observation.id,
      timestamp: context.observation.observedAt,
      source: context.observation.source,
      summary: `${context.observation.timeframe} bar: close=${context.observation.close ?? "n/a"}`,
      quality: context.quality,
    },
  ];
}

export function normalizeMacroObservations(
  observations: Array<typeof schema.macroObservations.$inferSelect>,
  qualityByObservationId: Map<string, QualityAssessmentResult>,
): NormalizedEvidenceItem[] {
  return observations.map((observation) => ({
    kind: "macro_observation",
    id: observation.id,
    timestamp: observation.observedAt,
    source: observation.source,
    summary: `${observation.seriesCode} (${observation.region}) = ${observation.value}`,
    quality: qualityByObservationId.get(observation.id),
  }));
}

export function normalizeNewsEvidence(
  items: Array<typeof schema.newsEvidence.$inferSelect>,
  qualityByEvidenceId: Map<string, QualityAssessmentResult>,
): NormalizedEvidenceItem[] {
  return items.map((item) => ({
    kind: "news_evidence",
    id: item.id,
    timestamp: item.sourceTimestamp,
    source: item.sourceUrl,
    summary: item.headline,
    quality: qualityByEvidenceId.get(item.id),
  }));
}

export function normalizeTelegramMessage(
  message: typeof schema.telegramMessages.$inferSelect | undefined,
  quality: QualityAssessmentResult | undefined,
): NormalizedEvidenceItem[] {
  if (!message) return [];
  return [
    {
      kind: "telegram_message",
      id: message.id,
      timestamp: message.messageTimestamp,
      source: "telegram",
      summary: message.rawText,
      quality,
    },
  ];
}

export function normalizeRelevantEvents(
  events: Array<{ id: string; title: string; eventType: string | null; firstSeenAt: Date }>,
): NormalizedEvidenceItem[] {
  return events.map((event) => ({
    kind: "entity_event",
    id: event.id,
    timestamp: event.firstSeenAt,
    source: "news_events",
    summary: event.eventType ? `[${event.eventType}] ${event.title}` : event.title,
    // Events aren't independently quality-scored by Phase 5 - their
    // trustworthiness derives from the news_evidence rows clustered into
    // them, each of which carries its own quality assessment already.
  }));
}
