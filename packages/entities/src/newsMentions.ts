import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { resolveMentionsBatch } from "./resolve";
import { linkEntities } from "./relationships";
import type { EntityCandidate } from "./types";

const MAX_NGRAM = 4;

/**
 * Bounded, deterministic candidate-phrase extraction from one article's
 * own text (spec Performance section: "avoid full-database scans per
 * article ... use bounded candidate sets, deterministic prefilters").
 * The token/n-gram count is proportional to the article's own word
 * count, never the size of the entity registry, and the subsequent
 * lookup is a single indexed batch query (resolveMentionsBatch), not an
 * ILIKE scan over every known entity.
 */
export function extractCandidatePhrases(text: string): string[] {
  const words = text
    .replace(/[^\p{L}\p{N}&.\-\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const phrases = new Set<string>();
  for (let n = 1; n <= MAX_NGRAM; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      phrases.add(words.slice(i, i + n).join(" "));
    }
  }
  return Array.from(phrases);
}

export interface NewsMentionResult {
  resolved: EntityCandidate[];
  ambiguous: Array<{ matchedText: string; candidateCount: number }>;
}

/**
 * Replaces Phase 6's naive `ILIKE "%symbol%"` substring search
 * (packages/signals/src/context/news.ts, pre-Phase-7) with structured
 * resolution: candidate phrases from the article's own headline/body are
 * looked up against the maintained alias registry (exact normalized
 * match only - no substring matching, so "TATA" can never spuriously
 * match "TATAMOTORS"). A phrase matching more than one distinct entity
 * is treated as ambiguous and NOT linked to any of them (spec: prefer
 * UNRESOLVED over a guess). Resolved mentions are recorded as
 * NEWS -> MENTIONS -> ENTITY relationships, idempotently.
 */
export async function resolveNewsEntityMentions(
  db: Db,
  newsEvidenceId: string,
): Promise<NewsMentionResult> {
  const [row] = await db
    .select()
    .from(schema.newsEvidence)
    .where(eq(schema.newsEvidence.id, newsEvidenceId));
  if (!row) throw new Error(`news_evidence row not found: ${newsEvidenceId}`);

  const text = [row.headline, row.bodyExcerpt ?? ""].join(" ");
  const phrases = extractCandidatePhrases(text);
  const resolutions = await resolveMentionsBatch(db, phrases);

  const result: NewsMentionResult = { resolved: [], ambiguous: [] };
  const linkedEntityIds = new Set<string>();

  for (const resolution of resolutions.values()) {
    if (resolution.status === "resolved") {
      if (linkedEntityIds.has(resolution.candidate.entityId)) continue; // same entity via multiple overlapping n-grams
      linkedEntityIds.add(resolution.candidate.entityId);
      result.resolved.push(resolution.candidate);
      await linkEntities(db, {
        subjectType: "news_evidence",
        subjectId: newsEvidenceId,
        relationshipType: "MENTIONS",
        objectId: resolution.candidate.entityId,
        strength: "direct",
        matchMethod: resolution.candidate.matchMethod,
        matchedText: resolution.candidate.matchedText,
      });
    } else if (resolution.status === "ambiguous") {
      result.ambiguous.push({ matchedText: resolution.matchedText, candidateCount: resolution.candidates.length });
    }
  }

  return result;
}
