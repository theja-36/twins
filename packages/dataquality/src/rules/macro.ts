import { and, desc, eq, lt, ne } from "drizzle-orm";
import { schema } from "@twins/database";
import { checkMacroObservationQuality } from "@twins/ingestion";
import type { Db } from "../db";
import { type DimensionOutcome, summarizeAssessment, type QualityAssessmentResult } from "../types";

export interface AssessMacroObservationOptions {
  maxAgeMs?: number; // freshness threshold; default 90 days (macro series update slowly)
  anomalyThresholdRatio?: number; // default 0.5 (50% move vs prior release)
  crossSourceConflictThresholdRatio?: number; // default 0.02 (2%)
}

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90;
const DEFAULT_ANOMALY_RATIO = 0.5;
const DEFAULT_CONFLICT_RATIO = 0.02;

/**
 * Macro data updates far less frequently and in coarser steps than
 * market data, so completeness/consistency (meaningful for multi-field
 * OHLCV bars) are not applied here (spec: "do not force every dimension
 * onto every data type where it makes no semantic sense").
 */
export async function assessMacroObservation(
  db: Db,
  observationId: string,
  options: AssessMacroObservationOptions = {},
): Promise<QualityAssessmentResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const anomalyThresholdRatio = options.anomalyThresholdRatio ?? DEFAULT_ANOMALY_RATIO;
  const conflictThresholdRatio =
    options.crossSourceConflictThresholdRatio ?? DEFAULT_CONFLICT_RATIO;

  const [obs] = await db
    .select()
    .from(schema.macroObservations)
    .where(eq(schema.macroObservations.id, observationId));
  if (!obs) throw new Error(`macro_observations row not found: ${observationId}`);

  const evaluatedAt = new Date();
  const value = Number(obs.value);
  const outcomes: DimensionOutcome[] = [];

  const structural = checkMacroObservationQuality({
    observedAt: obs.observedAt,
    value,
    region: obs.region,
    seriesCode: obs.seriesCode,
  });
  outcomes.push({
    dimension: "validity",
    ruleId: "validity.structural_check",
    passed: structural.valid,
    applicable: true,
    detail: structural.valid ? undefined : structural.reasons.join("; "),
  });

  const ageMs = evaluatedAt.getTime() - obs.observedAt.getTime();
  outcomes.push({
    dimension: "freshness",
    ruleId: "freshness.max_age",
    passed: ageMs <= maxAgeMs,
    applicable: true,
    detail: ageMs > maxAgeMs ? `observation is ${Math.round(ageMs / 86_400_000)} days old` : undefined,
  });

  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.no_future_observation",
    passed: obs.observedAt.getTime() <= evaluatedAt.getTime(),
    applicable: true,
  });
  outcomes.push({
    dimension: "temporal_integrity",
    ruleId: "temporal.received_after_observed",
    passed: obs.receivedAt.getTime() >= obs.observedAt.getTime(),
    applicable: true,
    detail:
      obs.receivedAt.getTime() < obs.observedAt.getTime()
        ? "received_at precedes observed_at"
        : undefined,
  });

  const duplicateRows = await db
    .select({ id: schema.macroObservations.id })
    .from(schema.macroObservations)
    .where(
      and(
        eq(schema.macroObservations.source, obs.source),
        eq(schema.macroObservations.seriesCode, obs.seriesCode),
        eq(schema.macroObservations.observedAt, obs.observedAt),
      ),
    );
  outcomes.push({
    dimension: "uniqueness",
    ruleId: "uniqueness.dedupe_key",
    passed: duplicateRows.length === 1,
    applicable: true,
    detail: duplicateRows.length > 1 ? `${duplicateRows.length} rows share this key` : undefined,
  });

  const otherSourceRows = await db
    .select()
    .from(schema.macroObservations)
    .where(
      and(
        eq(schema.macroObservations.region, obs.region),
        eq(schema.macroObservations.seriesCode, obs.seriesCode),
        eq(schema.macroObservations.observedAt, obs.observedAt),
        ne(schema.macroObservations.source, obs.source),
      ),
    );
  let conflictPassed = true;
  let conflictDetail: string | undefined;
  for (const other of otherSourceRows) {
    const otherValue = Number(other.value);
    if (!Number.isFinite(otherValue) || otherValue === 0) continue;
    const diffRatio = Math.abs(otherValue - value) / Math.abs(otherValue);
    if (diffRatio > conflictThresholdRatio) {
      conflictPassed = false;
      conflictDetail = `disagrees with source "${other.source}" by ${(diffRatio * 100).toFixed(2)}%`;
      break;
    }
  }
  outcomes.push({
    dimension: "cross_source_conflict",
    ruleId: "cross_source.value_agreement",
    passed: conflictPassed,
    applicable: otherSourceRows.length > 0,
    detail: conflictDetail,
  });

  const [priorObs] = await db
    .select()
    .from(schema.macroObservations)
    .where(
      and(
        eq(schema.macroObservations.source, obs.source),
        eq(schema.macroObservations.seriesCode, obs.seriesCode),
        lt(schema.macroObservations.observedAt, obs.observedAt),
      ),
    )
    .orderBy(desc(schema.macroObservations.observedAt))
    .limit(1);
  let anomalyPassed = true;
  let anomalyDetail: string | undefined;
  const priorValue = priorObs ? Number(priorObs.value) : undefined;
  const anomalyApplicable = priorValue !== undefined && Number.isFinite(priorValue) && priorValue !== 0;
  if (anomalyApplicable && priorValue !== undefined) {
    const changeRatio = Math.abs(value - priorValue) / Math.abs(priorValue);
    if (changeRatio > anomalyThresholdRatio) {
      anomalyPassed = false;
      anomalyDetail = `value moved ${(changeRatio * 100).toFixed(1)}% vs the prior release`;
    }
  }
  outcomes.push({
    dimension: "anomaly",
    ruleId: "anomaly.value_jump",
    passed: anomalyPassed,
    applicable: anomalyApplicable,
    detail: anomalyDetail,
  });

  const [latestHealth] = await db
    .select()
    .from(schema.providerHealth)
    .where(
      and(
        eq(schema.providerHealth.providerName, obs.source),
        eq(schema.providerHealth.providerType, "macro"),
      ),
    )
    .orderBy(desc(schema.providerHealth.checkedAt))
    .limit(1);
  outcomes.push({
    dimension: "source_reliability",
    ruleId: "source_reliability.latest_provider_health",
    passed: latestHealth ? latestHealth.status === "healthy" : true,
    applicable: latestHealth !== undefined,
    detail: latestHealth && latestHealth.status !== "healthy" ? `provider_health status is ${latestHealth.status}` : undefined,
  });

  outcomes.push({
    dimension: "lineage",
    ruleId: "lineage.source_present",
    passed: obs.source.trim().length > 0,
    applicable: true,
  });

  const assessment = summarizeAssessment(
    { entityType: "macro_observations", entityId: observationId, source: obs.source },
    outcomes,
  );
  assessment.evaluatedAt = evaluatedAt;
  return assessment;
}
