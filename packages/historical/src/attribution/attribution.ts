/**
 * Outcome attribution (P0 #5, first slice): PURE and deterministic stratified tables over already-evaluated historical outcome labels. It reads nothing, writes nothing and changes no weight,
 * tier or decision. Method is deliberately plain (one dimension at a time, no model): small samples overfit, so every stratum carries its sample size and a THIN flag, and a stratum is only
 * called "different" when it is READABLE and its win-rate interval excludes the overall win rate. That is a screening aid, not a proof (many strata are compared; expect some false flags).
 *
 * Same fixed R model as the source scorecards (WIN_T1 +1R, WIN_T2 +2R, WIN_T3 +3R, LOSS_SL -1R, no-entry / expired 0R). UNVERIFIABLE and INVALID_SIGNAL carry no R and are only counted.
 */
import { R_MODEL, round } from "../scorecards/metrics";

export const ATTRIBUTION_VERSION = "outcome-attribution-v1";
export const DEFAULT_MIN_SAMPLE = 30;
const ENTERED = ["WIN_T1", "WIN_T2", "WIN_T3", "LOSS_SL", "EXPIRED_AFTER_ENTRY"];
const IST_OFFSET_MS = 330 * 60_000;

export interface AttributionRow {
  key: string;
  /** Canonical source label, when known. */
  source: string | null;
  market: string | null;
  side: string | null;
  /** Time of the original message. */
  at: Date;
  /** Final outcome of the latest label, or null when the signal was never evaluated. */
  outcome: string | null;
  dataQuality: string | null;
}

export const DIMENSIONS = ["source", "market", "side", "session", "weekday", "dataQuality"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Factors the owner listed that this slice cannot attribute yet, with the reason. Shown, never silently dropped. */
export const UNAVAILABLE_FACTORS: ReadonlyArray<{ factor: string; reason: string }> = [
  { factor: "agentVerdict", reason: "agent verdicts at decision time are not stored for historical signals (shadow runs are log-only, HB-25)" },
  { factor: "confidenceTier", reason: "no confidence is recorded on historical labels" },
  { factor: "expiryProximity", reason: "contract expiry is not carried onto outcome labels in this slice" },
  { factor: "executionEffects", reason: "slippage and fill delay wait for execution-quality analytics (P1 #18)" },
];

export interface Stratum {
  dimension: Dimension;
  value: string;
  /** Labelled signals with a definite R (wins, losses, no-entry, expired). */
  evaluable: number;
  entered: number;
  wins: number;
  losses: number;
  unscored: number;
  winRateEntered: number | null;
  /** 95% Wilson interval for winRateEntered. */
  winRateLow: number | null;
  winRateHigh: number | null;
  expectancyR: number | null;
  totalR: number;
  deltaExpectancyR: number | null;
  /** evaluable below the minimum sample: shown, but not to be read as a finding. */
  thin: boolean;
  reading: "THIN" | "READABLE";
  /** null when thin or undefined; true only when the interval excludes the overall win rate. */
  differsFromOverall: boolean | null;
}
export interface AttributionReport {
  version: string;
  minSample: number;
  totalRows: number;
  notEvaluated: number;
  overall: { evaluable: number; entered: number; wins: number; losses: number; unscored: number; winRateEntered: number | null; expectancyR: number | null; totalR: number; thin: boolean };
  strata: Stratum[];
  unavailable: ReadonlyArray<{ factor: string; reason: string }>;
  statements: string[];
  /** The report is evidence for the owner; it never changes a weight, tier or limit. */
  grantsApproval: false;
  usedForDecisions: false;
}
export interface AttributionOptions { minSample?: number; dimensions?: readonly Dimension[] }

/** 95% Wilson score interval; null for n = 0. */
export function wilson(wins: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96, p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

/** NSE cash session buckets in IST. */
export function sessionOf(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (m < 9 * 60 + 15) return "PRE_OPEN";
  if (m < 10 * 60 + 30) return "OPENING";
  if (m < 14 * 60) return "MIDDAY";
  if (m <= 15 * 60 + 30) return "CLOSING";
  return "AFTER_HOURS";
}
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export const weekdayOf = (at: Date): string => WEEKDAYS[new Date(at.getTime() + IST_OFFSET_MS).getUTCDay()] as string;

function valueOf(r: AttributionRow, d: Dimension): string {
  switch (d) {
    case "source": return r.source ?? "UNKNOWN";
    case "market": return r.market ?? "UNKNOWN";
    case "side": return r.side ? r.side.toUpperCase() : "UNKNOWN";
    case "session": return sessionOf(r.at);
    case "weekday": return weekdayOf(r.at);
    case "dataQuality": return r.dataQuality ?? "UNKNOWN";
  }
}

interface Tally { evaluable: number; entered: number; wins: number; losses: number; unscored: number; totalR: number }
function tally(rows: AttributionRow[]): Tally {
  const t: Tally = { evaluable: 0, entered: 0, wins: 0, losses: 0, unscored: 0, totalR: 0 };
  for (const r of rows) {
    if (r.outcome === null) continue;
    if (r.outcome === "UNVERIFIABLE" || r.outcome === "INVALID_SIGNAL" || !(r.outcome in R_MODEL)) { t.unscored++; continue; }
    t.evaluable++;
    t.totalR += R_MODEL[r.outcome as keyof typeof R_MODEL];
    if (ENTERED.includes(r.outcome)) t.entered++;
    if (r.outcome.startsWith("WIN_")) t.wins++;
    if (r.outcome === "LOSS_SL") t.losses++;
  }
  return t;
}
const rate = (n: number, d: number): number | null => (d === 0 ? null : round(n / d));
const expectancy = (t: Tally): number | null => (t.evaluable === 0 ? null : round(t.totalR / t.evaluable));

export function buildAttribution(rows: readonly AttributionRow[], opts: AttributionOptions = {}): AttributionReport {
  const minSample = Math.max(1, Math.floor(opts.minSample ?? DEFAULT_MIN_SAMPLE));
  const dims = opts.dimensions ?? DIMENSIONS;
  const all = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const overall = tally(all);
  const overallRate = rate(overall.wins, overall.entered);
  const overallExp = expectancy(overall);
  const strata: Stratum[] = [];
  for (const dimension of dims) {
    const groups = new Map<string, AttributionRow[]>();
    for (const r of all) { const v = valueOf(r, dimension); (groups.get(v) ?? groups.set(v, []).get(v) as AttributionRow[]).push(r); }
    for (const value of [...groups.keys()].sort()) {
      const t = tally(groups.get(value) as AttributionRow[]);
      const ci = wilson(t.wins, t.entered);
      const thin = t.evaluable < minSample;
      const differs = thin || ci === null || overallRate === null ? null : ci.low > overallRate || ci.high < overallRate;
      strata.push({
        dimension, value, evaluable: t.evaluable, entered: t.entered, wins: t.wins, losses: t.losses, unscored: t.unscored,
        winRateEntered: rate(t.wins, t.entered), winRateLow: ci?.low ?? null, winRateHigh: ci?.high ?? null,
        expectancyR: expectancy(t), totalR: round(t.totalR),
        deltaExpectancyR: expectancy(t) === null || overallExp === null ? null : round((expectancy(t) as number) - overallExp),
        thin, reading: thin ? "THIN" : "READABLE", differsFromOverall: differs,
      });
    }
  }
  return {
    version: ATTRIBUTION_VERSION, minSample, totalRows: all.length, notEvaluated: all.filter((r) => r.outcome === null).length,
    overall: { evaluable: overall.evaluable, entered: overall.entered, wins: overall.wins, losses: overall.losses, unscored: overall.unscored, winRateEntered: overallRate, expectancyR: overallExp, totalR: round(overall.totalR), thin: overall.evaluable < minSample },
    strata, unavailable: UNAVAILABLE_FACTORS,
    statements: [
      "Descriptive only: strata are compared one dimension at a time and are not causal.",
      "THIN strata (below the minimum sample) are listed for completeness and are not findings.",
      "Many strata are compared, so some READABLE differences will be chance; treat them as questions to investigate.",
      "No weight, tier, limit or decision reads this report.",
    ],
    grantsApproval: false, usedForDecisions: false,
  };
}
