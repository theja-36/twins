import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { checkNewsItemQuality } from "@twins/ingestion";
import type { Db } from "../db";
import { type DimensionOutcome, summarizeAssessment, type QualityAssessmentResult } from "../types";

export interface AssessNewsEvidenceOptions {
  maxAgeMs?: number; // default 30 days - news relevance decays
}

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Completeness/consistency/cross-source-conflict/anomaly do not apply to
 * a single article's text (spec: "do not force every dimension onto
 * every data type where it makes no semantic sense") - clustering
 * multiple articles into one event is Phase 7's job, not this engine's.
 */
export async function assessNewsEvidence(
  db: Db,
  evidenceId: string,
  options: AssessNewsEvidenceOptions = {},
): Promise<QualityAssessmentResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const [row] = await db
    .select()
    .from(schema.newsEvidence)
    .innerJoin(schema.newsSources, eq(schema.newsEvidence.newsSourceId, schema.newsSources.id))
    .where(eq(schema.newsEvidence.id, evidenceId));
  if (!row) throw new Error(`news_evidence row not found: ${evidenceId}`);

  const evidence = row.news_evidence;
  const source = row.news_sources;
  const evaluatedAt = new Date();
  const outcomes: DimensionOutcome[] = [];

  const structural = checkNewsItemQuality({
    headline: evidence.headline,
    sourceUrl: evidence.sourceUrl,
    sourceTimestamp: evidence.sourceTimestamp,
  });
  outcomes.push({
    dimension: "validity",
    ruleId: "validity.structural_check",
    passed: structural.valid,
    applicable: true,
    detail: structural.valid ? undefined : structural.reasons.join("; "),
  });

  const ageMs = evaluatedAt.getTime() - evidence.sourceTimestamp.getTime();
  outcomes.push({
    dimension: "freshness",
    ruleId: "freshness.max_age",
    passed: ageMs <= maxAgeMs,
    applicable: true,
    detail: ageMs > maxAgeMs ? `article is ${Math.round(ageMs / 86_400_000)} days old` : undefined,
  });

  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.no_future_observation",
    passed: evidence.sourceTimestamp.getTime() <= evaluatedAt.getTime(),
    applicable: true,
  });
  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.received_after_observed",
    passed: evidence.receivedAt.getTime() >= evidence.sourceTimestamp.getTime(),
    applicable: true,
    detail:
      evidence.receivedAt.getTime() < evidence.sourceTimestamp.getTime()
        ? "received_at precedes source_timestamp"
        : undefined,
  });

  const duplicateRows = await db
    .select({ id: schema.newsEvidence.id })
    .from(schema.newsEvidence)
    .where(
      and(
        eq(schema.newsEvidence.newsSourceId, evidence.newsSourceId),
        eq(schema.newsEvidence.dedupeHash, evidence.dedupeHash),
      ),
    );
  outcomes.push({
    dimension: "uniqueness",
    ruleId: "uniqueness.dedupe_key",
    passed: duplicateRows.length === 1,
    applicable: true,
    detail: duplicateRows.length > 1 ? `${duplicateRows.length} rows share this dedupe key` : undefined,
  });

  // Tier A-C sources are professional/authoritative; D-E are treated as
  // lower reliability (spec section 11/17 source priority).
  const reliableTier = source.tier === "A" || source.tier === "B" || source.tier === "C";
  outcomes.push({
    dimension: "source_reliability",
    ruleId: "source_reliability.tier",
    passed: reliableTier,
    applicable: true,
    detail: reliableTier ? undefined : `source tier is ${source.tier} (aggregation/discovery, not primary)`,
  });

  outcomes.push({
    dimension: "lineage",
    ruleId: "lineage.source_resolves",
    passed: true,
    applicable: true,
  });

  const assessment = summarizeAssessment(
    { entityType: "news_evidence", entityId: evidenceId, source: source.name },
    outcomes,
  );
  assessment.evaluatedAt = evaluatedAt;
  return assessment;
}
