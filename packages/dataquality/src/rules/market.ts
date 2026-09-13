import { and, desc, eq, lt, ne } from "drizzle-orm";
import { schema } from "@twins/database";
import { checkMarketBarQuality } from "@twins/ingestion";
import type { Db } from "../db";
import { type DimensionOutcome, summarizeAssessment, type QualityAssessmentResult } from "../types";

export interface AssessMarketObservationOptions {
  maxAgeMs?: number; // freshness threshold; default 7 days
  anomalyThresholdRatio?: number; // default 0.20 (20% move vs prior bar)
  crossSourceConflictThresholdRatio?: number; // default 0.005 (0.5%)
}

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_ANOMALY_RATIO = 0.2;
const DEFAULT_CONFLICT_RATIO = 0.005;

function toNum(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Assesses a single already-persisted market_observations row across all
 * ten quality dimensions where they semantically apply to numeric OHLCV
 * data. Purely deterministic - no AI, no trading decision (spec: this
 * engine must not make trading decisions).
 */
export async function assessMarketObservation(
  db: Db,
  observationId: string,
  options: AssessMarketObservationOptions = {},
): Promise<QualityAssessmentResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const anomalyThresholdRatio = options.anomalyThresholdRatio ?? DEFAULT_ANOMALY_RATIO;
  const conflictThresholdRatio =
    options.crossSourceConflictThresholdRatio ?? DEFAULT_CONFLICT_RATIO;

  const [row] = await db
    .select()
    .from(schema.marketObservations)
    .innerJoin(schema.instruments, eq(schema.marketObservations.instrumentId, schema.instruments.id))
    .where(eq(schema.marketObservations.id, observationId));
  if (!row) throw new Error(`market_observations row not found: ${observationId}`);

  const obs = row.market_observations;
  const evaluatedAt = new Date();
  const outcomes: DimensionOutcome[] = [];

  const open = toNum(obs.open);
  const high = toNum(obs.high);
  const low = toNum(obs.low);
  const close = toNum(obs.close);
  const volume = toNum(obs.volume);

  // --- validity + completeness (reuses Phase 4's deterministic structural checks) ---
  const structural = checkMarketBarQuality({
    observedAt: obs.observedAt,
    open,
    high,
    low,
    close,
    volume,
    timeframe: obs.timeframe,
    receivedAt: evaluatedAt,
  });
  outcomes.push({
    dimension: "validity",
    ruleId: "validity.structural_check",
    passed: structural.valid,
    applicable: true,
    detail: structural.valid ? undefined : structural.reasons.join("; "),
  });
  outcomes.push({
    dimension: "completeness",
    ruleId: "completeness.full_ohlc",
    passed: structural.valid && structural.status !== "incomplete",
    applicable: structural.valid,
    detail: structural.status === "incomplete" ? "one or more OHLC fields missing" : undefined,
  });

  // --- freshness ---
  const ageMs = evaluatedAt.getTime() - obs.observedAt.getTime();
  outcomes.push({
    dimension: "freshness",
    ruleId: "freshness.max_age",
    passed: ageMs <= maxAgeMs,
    applicable: true,
    detail: ageMs > maxAgeMs ? `observation is ${Math.round(ageMs / 86_400_000)} days old` : undefined,
  });

  // --- consistency (open/close within [low, high]) ---
  const withinRange =
    (open === undefined || low === undefined || high === undefined || (open >= low && open <= high)) &&
    (close === undefined || low === undefined || high === undefined || (close >= low && close <= high));
  outcomes.push({
    dimension: "consistency",
    ruleId: "consistency.ohlc_within_range",
    passed: withinRange,
    applicable: low !== undefined && high !== undefined,
    detail: withinRange ? undefined : "open/close fall outside the [low, high] range",
  });

  // --- temporal integrity ---
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

  // --- uniqueness (defensive re-check of the Phase 2 unique constraint) ---
  const duplicateRows = await db
    .select({ id: schema.marketObservations.id })
    .from(schema.marketObservations)
    .where(
      and(
        eq(schema.marketObservations.instrumentId, obs.instrumentId),
        eq(schema.marketObservations.source, obs.source),
        eq(schema.marketObservations.timeframe, obs.timeframe),
        eq(schema.marketObservations.observedAt, obs.observedAt),
      ),
    );
  outcomes.push({
    dimension: "uniqueness",
    ruleId: "uniqueness.dedupe_key",
    passed: duplicateRows.length === 1,
    applicable: true,
    detail: duplicateRows.length > 1 ? `${duplicateRows.length} rows share this key` : undefined,
  });

  // --- cross-source conflict ---
  const otherSourceRows = await db
    .select()
    .from(schema.marketObservations)
    .where(
      and(
        eq(schema.marketObservations.instrumentId, obs.instrumentId),
        eq(schema.marketObservations.timeframe, obs.timeframe),
        eq(schema.marketObservations.observedAt, obs.observedAt),
        ne(schema.marketObservations.source, obs.source),
      ),
    );
  let conflictDetail: string | undefined;
  let conflictPassed = true;
  if (otherSourceRows.length > 0 && close !== undefined) {
    for (const other of otherSourceRows) {
      const otherClose = toNum(other.close);
      if (otherClose === undefined || otherClose === 0) continue;
      const diffRatio = Math.abs(otherClose - close) / Math.abs(otherClose);
      if (diffRatio > conflictThresholdRatio) {
        conflictPassed = false;
        conflictDetail = `disagrees with source "${other.source}" by ${(diffRatio * 100).toFixed(2)}%`;
        break;
      }
    }
  }
  outcomes.push({
    dimension: "cross_source_conflict",
    ruleId: "cross_source.close_price_agreement",
    passed: conflictPassed,
    applicable: otherSourceRows.length > 0 && close !== undefined,
    detail: conflictDetail,
  });

  // --- anomaly (vs the immediately preceding bar from the same source) ---
  const [priorBar] = await db
    .select()
    .from(schema.marketObservations)
    .where(
      and(
        eq(schema.marketObservations.instrumentId, obs.instrumentId),
        eq(schema.marketObservations.source, obs.source),
        eq(schema.marketObservations.timeframe, obs.timeframe),
        lt(schema.marketObservations.observedAt, obs.observedAt),
      ),
    )
    .orderBy(desc(schema.marketObservations.observedAt))
    .limit(1);
  let anomalyPassed = true;
  let anomalyDetail: string | undefined;
  const priorClose = priorBar ? toNum(priorBar.close) : undefined;
  const anomalyApplicable = priorClose !== undefined && priorClose !== 0 && close !== undefined;
  if (anomalyApplicable && priorClose !== undefined && close !== undefined) {
    const changeRatio = Math.abs(close - priorClose) / Math.abs(priorClose);
    if (changeRatio > anomalyThresholdRatio) {
      anomalyPassed = false;
      anomalyDetail = `close moved ${(changeRatio * 100).toFixed(1)}% vs the prior bar`;
    }
  }
  outcomes.push({
    dimension: "anomaly",
    ruleId: "anomaly.close_price_jump",
    passed: anomalyPassed,
    applicable: anomalyApplicable,
    detail: anomalyDetail,
  });

  // --- source reliability (informational: latest known provider_health for this source) ---
  const [latestHealth] = await db
    .select()
    .from(schema.providerHealth)
    .where(
      and(
        eq(schema.providerHealth.providerName, obs.source),
        eq(schema.providerHealth.providerType, "market"),
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

  // --- lineage ---
  outcomes.push({
    dimension: "lineage",
    ruleId: "lineage.instrument_resolves",
    passed: row.instruments !== null,
    applicable: true,
  });

  const assessment = summarizeAssessment(
    { entityType: "market_observations", entityId: observationId, source: obs.source },
    outcomes,
  );
  assessment.evaluatedAt = evaluatedAt;
  return assessment;
}
