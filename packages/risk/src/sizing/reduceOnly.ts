/**
 * Reduce-only dynamic sizing (P0 #3), SHADOW ONLY. A pure function that takes the quantity `sizing-v1` already produced and returns an adjusted quantity that is NEVER larger: a multiplier in
 * [floor, 1] is built from extra evidence (drawdown, volatility, event proximity, unusable data sources, thin evidence) and applied by rounding DOWN to whole lots. `sizing-v1` stays authoritative
 * and unchanged; nothing calls this function yet, nothing stores its output and no gate reads it. Missing evidence never increases size: an unknown input leaves the factor at 1 and is reported
 * as unknown (it is not treated as good news). The floor keeps it from acting as a halt; stopping new trades is the circuit breaker's job (P1 #11).
 */
export const REDUCE_ONLY_SIZING_VERSION = "reduce-only-sizing-v1";

export interface ReduceOnlyInputs {
  /** Whole units/lots from sizing-v1. Anything not a non-negative integer is refused. */
  v1Quantity: number;
  /** Current drawdown as a percent of capital (>= 0), or null when unknown. */
  drawdownPct: number | null;
  /** Current volatility divided by its baseline (1 = normal), or null when unknown. */
  volatilityRatio: number | null;
  /** Hours until the next HIGH or CRITICAL scheduled event, or null when unknown/none within the horizon. */
  hoursToHighImpactEvent: number | null;
  /** Providers the source-health profile reports as not usable (count), or null when no profile was available. */
  unusableSources: number | null;
  /** True when the supporting evidence rests on a thin sample. */
  thinEvidence: boolean;
}
export interface ReduceOnlyPolicy {
  /** Smallest allowed multiplier, in (0, 1]. */
  floor: number;
  /** Multiplier applied when drawdown is at or above `drawdownStartPct`, falling linearly to `drawdownFullPct`. */
  drawdownStartPct: number; drawdownFullPct: number; drawdownMinMultiplier: number;
  volatilityStart: number; volatilityFull: number; volatilityMinMultiplier: number;
  /** An event inside this many hours scales the size by `eventMultiplier`. */
  eventWindowHours: number; eventMultiplier: number;
  /** Multiplier per unusable source (compounding), and for thin evidence. */
  perUnusableSourceMultiplier: number; thinEvidenceMultiplier: number;
}
export const DEFAULT_REDUCE_ONLY_POLICY: ReduceOnlyPolicy = {
  floor: 0.25,
  drawdownStartPct: 2, drawdownFullPct: 6, drawdownMinMultiplier: 0.5,
  volatilityStart: 1.5, volatilityFull: 3, volatilityMinMultiplier: 0.5,
  eventWindowHours: 4, eventMultiplier: 0.5,
  perUnusableSourceMultiplier: 0.9, thinEvidenceMultiplier: 0.75,
};

export class ReduceOnlyPolicyError extends Error { constructor(m: string) { super(m); this.name = "ReduceOnlyPolicyError"; } }
const unit = (x: number): boolean => Number.isFinite(x) && x > 0 && x <= 1;
/** Every multiplier must be in (0, 1]: a policy that could scale UP is refused outright (fail closed). */
export function validateReduceOnlyPolicy(p: ReduceOnlyPolicy): ReduceOnlyPolicy {
  const mults = [p.floor, p.drawdownMinMultiplier, p.volatilityMinMultiplier, p.eventMultiplier, p.perUnusableSourceMultiplier, p.thinEvidenceMultiplier];
  if (!mults.every(unit)) throw new ReduceOnlyPolicyError("every multiplier must be greater than 0 and at most 1");
  if (!(p.drawdownFullPct > p.drawdownStartPct && p.drawdownStartPct >= 0)) throw new ReduceOnlyPolicyError("drawdown range must be increasing and non-negative");
  if (!(p.volatilityFull > p.volatilityStart && p.volatilityStart >= 1)) throw new ReduceOnlyPolicyError("volatility range must be increasing and start at 1 or more");
  if (!(Number.isFinite(p.eventWindowHours) && p.eventWindowHours > 0)) throw new ReduceOnlyPolicyError("event window must be positive");
  return p;
}

export interface ReduceOnlyFactor { name: "drawdown" | "volatility" | "event" | "sources" | "thin_evidence"; multiplier: number; detail: string }
export interface ReduceOnlyResult {
  version: typeof REDUCE_ONLY_SIZING_VERSION;
  v1Quantity: number;
  adjustedQuantity: number;
  /** Combined multiplier after the floor, in [floor, 1]. */
  multiplier: number;
  factors: ReduceOnlyFactor[];
  /** Inputs that were null and therefore changed nothing (reported, never assumed good). */
  unknownInputs: string[];
  reduced: boolean;
  notes: string[];
  /** Always false: this result is shadow evidence; sizing-v1 is what any decision uses. */
  usedForDecisions: false;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
/** Linear ramp: 1 at/below `start`, `minMult` at/above `full`. */
const ramp = (x: number, start: number, full: number, minMult: number): number => (x <= start ? 1 : x >= full ? minMult : 1 - ((x - start) / (full - start)) * (1 - minMult));

export function reduceOnlySize(i: ReduceOnlyInputs, policy: ReduceOnlyPolicy = DEFAULT_REDUCE_ONLY_POLICY): ReduceOnlyResult {
  const p = validateReduceOnlyPolicy(policy);
  if (!Number.isInteger(i.v1Quantity) || i.v1Quantity < 0) throw new ReduceOnlyPolicyError("v1Quantity must be a non-negative whole number");
  const factors: ReduceOnlyFactor[] = [], unknown: string[] = [], notes: string[] = [];

  if (i.drawdownPct === null) unknown.push("drawdownPct");
  else if (Number.isFinite(i.drawdownPct) && i.drawdownPct > p.drawdownStartPct) { const m = ramp(i.drawdownPct, p.drawdownStartPct, p.drawdownFullPct, p.drawdownMinMultiplier); factors.push({ name: "drawdown", multiplier: r4(m), detail: `drawdown ${i.drawdownPct}% of capital` }); }
  if (i.volatilityRatio === null) unknown.push("volatilityRatio");
  else if (Number.isFinite(i.volatilityRatio) && i.volatilityRatio > p.volatilityStart) { const m = ramp(i.volatilityRatio, p.volatilityStart, p.volatilityFull, p.volatilityMinMultiplier); factors.push({ name: "volatility", multiplier: r4(m), detail: `volatility ${i.volatilityRatio}x baseline` }); }
  if (i.hoursToHighImpactEvent === null) unknown.push("hoursToHighImpactEvent");
  else if (Number.isFinite(i.hoursToHighImpactEvent) && i.hoursToHighImpactEvent >= 0 && i.hoursToHighImpactEvent <= p.eventWindowHours) factors.push({ name: "event", multiplier: p.eventMultiplier, detail: `high-impact event in ${i.hoursToHighImpactEvent}h` });
  if (i.unusableSources === null) unknown.push("unusableSources");
  else if (Number.isInteger(i.unusableSources) && i.unusableSources > 0) factors.push({ name: "sources", multiplier: r4(Math.pow(p.perUnusableSourceMultiplier, i.unusableSources)), detail: `${i.unusableSources} source(s) not usable` });
  if (i.thinEvidence) factors.push({ name: "thin_evidence", multiplier: p.thinEvidenceMultiplier, detail: "supporting evidence rests on a thin sample" });

  const raw = factors.reduce((m, f) => m * f.multiplier, 1);
  const multiplier = r4(Math.min(1, Math.max(p.floor, raw)));
  if (raw < p.floor) notes.push("FLOOR_APPLIED");
  // Round DOWN to whole lots and clamp to v1: the adjusted size can never exceed what sizing-v1 produced.
  let adjusted = Math.min(i.v1Quantity, Math.floor(i.v1Quantity * multiplier + 1e-9));
  if (i.v1Quantity > 0 && adjusted === 0) notes.push("ROUNDED_TO_ZERO");
  if (unknown.length) notes.push("UNKNOWN_INPUTS_DID_NOT_CHANGE_SIZE");
  adjusted = Math.max(0, adjusted);
  return { version: REDUCE_ONLY_SIZING_VERSION, v1Quantity: i.v1Quantity, adjustedQuantity: adjusted, multiplier, factors, unknownInputs: unknown, reduced: adjusted < i.v1Quantity, notes, usedForDecisions: false };
}

export interface ReduceOnlySummary { n: number; reduced: number; reducedShare: number | null; meanMultiplier: number | null; totalV1: number; totalAdjusted: number; byFactor: Record<string, number>; withUnknownInputs: number }
/** Shadow comparison over many results: how often it would have reduced, by how much, and which factors did it. Pure; the numbers are for review, not for any decision. */
export function summarizeReduceOnly(results: readonly ReduceOnlyResult[]): ReduceOnlySummary {
  const byFactor: Record<string, number> = {};
  let reduced = 0, sum = 0, v1 = 0, adj = 0, unknown = 0;
  for (const r of results) {
    if (r.reduced) reduced += 1;
    sum += r.multiplier; v1 += r.v1Quantity; adj += r.adjustedQuantity;
    if (r.unknownInputs.length) unknown += 1;
    for (const f of r.factors) byFactor[f.name] = (byFactor[f.name] ?? 0) + 1;
  }
  const n = results.length;
  return { n, reduced, reducedShare: n === 0 ? null : r4(reduced / n), meanMultiplier: n === 0 ? null : r4(sum / n), totalV1: v1, totalAdjusted: adj, byFactor, withUnknownInputs: unknown };
}
