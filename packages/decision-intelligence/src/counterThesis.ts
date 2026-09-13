import type { CounterThesis, CounterThesisSeverity, Thesis, ThesisFactor } from "./types";

/**
 * Fixed, disclosed severity per rule - not a learned or fabricated
 * weighting. A negative-convention event is the closest thing this
 * system has to a real invalidating fact; everything else is a
 * data-quality/coverage concern, deliberately capped below "high" so a
 * routine "no news yet" state can never alone trigger the same severity
 * as an actual adverse event.
 */
const FACTOR_SEVERITY: Record<string, CounterThesisSeverity> = {
  "bear.negative_convention_event": "high",
  "bull.positive_convention_event": "high", // only relevant when this thesis opposes a sell signal
  "bear.no_market_data": "medium",
  "bear.stale_market_data": "medium",
  "bear.market_data_conflict": "medium",
  "bear.market_data_anomaly": "medium",
  "bear.untrusted_source": "low",
  "bear.unresolved_entity": "low",
  "bear.no_corroborating_context": "low",
};

const SEVERITY_RANK: Record<CounterThesisSeverity, number> = { low: 0, medium: 1, high: 2 };

function severityOf(ruleId: string): CounterThesisSeverity {
  return FACTOR_SEVERITY[ruleId] ?? "low";
}

/**
 * The counter-thesis (spec section 10): "the strongest reasonable
 * argument that this trade is wrong." It is not a third independent
 * thesis - it IS whichever of the bull/bear theses opposes the signal's
 * own claimed direction, promoted with an explicit severity/confidence
 * so a decision can react to it deliberately rather than by accident.
 */
export function buildCounterThesis(signalDirection: "buy" | "sell", bullThesis: Thesis, bearThesis: Thesis): CounterThesis {
  const opposing = signalDirection === "buy" ? bearThesis : bullThesis;
  const opposingDirection: "buy" | "sell" = signalDirection === "buy" ? "sell" : "buy";

  const rankedFactors = [...opposing.factors].sort((a, b) => SEVERITY_RANK[severityOf(b.ruleId)] - SEVERITY_RANK[severityOf(a.ruleId)]);
  const strongestFactor: ThesisFactor | null = rankedFactors[0] ?? null;
  const severity: CounterThesisSeverity = strongestFactor ? severityOf(strongestFactor.ruleId) : "low";

  // Deterministic, evidence-count-based confidence - not a probability the trade fails.
  const confidence = opposing.factors.length === 0 ? 0 : Math.min(1, 0.3 + 0.2 * opposing.factors.length);

  return {
    opposingDirection,
    strongestFactor,
    invalidationFactors: opposing.factors,
    evidenceIds: opposing.evidenceIds,
    severity,
    confidence,
  };
}
