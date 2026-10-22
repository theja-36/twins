import { assessMacroObservation, assessNewsEvidence, type QualityAssessmentResult } from "@twins/dataquality";
import { gatherSignalEntityContext, type SignalEntityContext } from "@twins/entities";
import type { Db } from "./db";
import { buildSignalIntelligence, type BuildSignalIntelligenceOptions } from "./intelligence";
import { resolveContextWindow, type ContextWindow } from "./contextWindow";
import {
  normalizeMacroObservations,
  normalizeMarketContext,
  normalizeNewsEvidence,
  normalizeRelevantEvents,
  normalizeTelegramMessage,
  type NormalizedEvidenceItem,
} from "./evidence";
import type { SignalIntelligence } from "./types";

export interface AssembleSignalIntelligenceOptions {
  macro?: BuildSignalIntelligenceOptions["macro"];
  newsLimit?: number;
  /** How far back evidence is still considered part of this signal's context window. Omit for no lower bound. */
  lookbackMs?: number;
  /** Explicit market selection (source, interval, context). */
  market?: BuildSignalIntelligenceOptions["market"];
  /** Explicit analysis as-of time: evidence received after it is excluded. */
  asOf?: Date | undefined;
}

/**
 * Phase 8 - Signal Intelligence Engine output. Composes Phase 6's
 * `SignalIntelligence` and Phase 7's `SignalEntityContext` - it does not
 * duplicate either's fields, only adds the pipeline stages neither
 * covered: a bounded context window, uniform evidence normalization
 * across every domain, and explicit conflict/freshness surfacing.
 *
 * This is an EVIDENCE OBJECT, not a decision. Nothing here approves,
 * rejects, scores profitability, or outputs BUY/SELL/WAIT/REJECT - that
 * is a later Decision Engine phase's job.
 */
export interface SignalIntelligenceReport {
  contextWindow: ContextWindow;
  /** Phase 6's signal + market/macro/news/telegram context, evidence-linked and marked analyzed - unchanged shape, now temporally bounded. */
  core: SignalIntelligence;
  /** Phase 7's entity/event context - unchanged shape. */
  entityContext: SignalEntityContext;
  /** Every piece of evidence gathered, in one uniform shape, across all five domains. */
  normalizedEvidence: NormalizedEvidenceItem[];
  /** Evidence items whose Phase 5 quality assessment flagged a cross-source disagreement or an anomalous jump. */
  conflicts: NormalizedEvidenceItem[];
  /** Evidence items whose Phase 5 quality assessment flagged them as stale relative to the signal's context window. */
  staleEvidence: NormalizedEvidenceItem[];
  generatedAt: Date;
}

function hasFailedDimension(quality: QualityAssessmentResult | undefined, dimension: string): boolean {
  if (!quality) return false;
  return quality.dimensions.some((d) => d.dimension === dimension && d.applicable && !d.passed);
}

/**
 * The Phase 8 pipeline: Signal -> Context Window -> Source Retrieval ->
 * Temporal Filtering -> Entity/Event Association -> Evidence
 * Normalisation -> Cross-Source Relationship Detection -> Conflict
 * Detection -> Freshness Assessment -> Intelligence Assembly ->
 * Structured Output.
 *
 * Deterministic throughout: every step is a database query or a plain
 * function over already-computed Phase 5/6/7 results. No AI/LLM call
 * exists anywhere in this function or anything it calls.
 */
export async function assembleSignalIntelligence(
  db: Db,
  signalId: string,
  options: AssembleSignalIntelligenceOptions = {},
): Promise<SignalIntelligenceReport> {
  // Source Retrieval + Temporal Filtering + Intelligence Assembly (core):
  // reuses Phase 6's buildSignalIntelligence with no-look-ahead enforced,
  // rather than re-implementing retrieval - there is exactly one
  // authoritative retrieval path per domain, same lesson as the Phase 7
  // news-matching cleanup.
  const core = await buildSignalIntelligence(db, signalId, {
    macro: options.macro,
    newsLimit: options.newsLimit,
    enforceNoLookahead: true,
    market: options.market,
    asOf: options.asOf,
  });

  const contextWindow = resolveContextWindow(core.signal.signalTimestamp, { lookbackMs: options.lookbackMs });

  // Entity/Event Association: reuses Phase 7 unchanged.
  const entityContext = await gatherSignalEntityContext(db, signalId);

  // Quality parity: market and telegram evidence already carry a Phase 5
  // assessment from buildSignalIntelligence; macro/news did not
  // previously (spec: "preserve entity relationship + source quality +
  // temporal quality separately" for every evidence type, not just some).
  const macroQualityEntries = await Promise.all(
    core.macroContext.map(async (observation) => [observation.id, await assessMacroObservation(db, observation.id)] as const),
  );
  const macroQuality = new Map(macroQualityEntries);

  const newsQualityEntries = await Promise.all(
    core.newsContext.map(async (item) => [item.id, await assessNewsEvidence(db, item.id)] as const),
  );
  const newsQuality = new Map(newsQualityEntries);

  // Evidence Normalisation: one uniform shape across all five domains.
  const normalizedEvidence: NormalizedEvidenceItem[] = [
    ...normalizeMarketContext(core.marketContext),
    ...normalizeMacroObservations(core.macroContext, macroQuality),
    ...normalizeNewsEvidence(core.newsContext, newsQuality),
    ...normalizeTelegramMessage(core.originalTelegramMessage, core.telegramMessageQuality),
    ...normalizeRelevantEvents(entityContext.relevantEvents),
  ];

  // Cross-Source Relationship Detection + Conflict Detection: surfaced
  // explicitly here rather than left buried inside each item's quality
  // blob, so a caller doesn't have to know Phase 5's internal dimension
  // vocabulary to find out what's in dispute.
  const conflicts = normalizedEvidence.filter(
    (item) => hasFailedDimension(item.quality, "cross_source_conflict") || hasFailedDimension(item.quality, "anomaly"),
  );

  // Freshness Assessment: same pattern, surfaced explicitly.
  const staleEvidence = normalizedEvidence.filter((item) => hasFailedDimension(item.quality, "freshness"));

  return {
    contextWindow,
    core,
    entityContext,
    normalizedEvidence,
    conflicts,
    staleEvidence,
    generatedAt: new Date(),
  };
}
