/**
 * Channel strategy profile (Module 06): what a Telegram channel's signals LOOK LIKE, inferred from its parsed and classified signals. PURE and deterministic, versioned.
 * Everything is DESCRIPTIVE. A "preference" is reported only with enough signals and a clear majority; otherwise it is null with a limitation, never guessed. Strategy confidence
 * describes how much consistent behaviour was observed, NOT whether the channel makes money (performance is a separate, outcome-based analysis).
 */
export const PROFILE_VERSION = "channel-profile-v1";

export interface ChannelSignal {
  id: string; at: Date; underlying: string; optionType: "CE" | "PE" | null; action: "buy" | "sell" | null;
  entryKind: "above" | "below" | "at" | "near" | "range" | "market" | "unspecified";
  setup: string; horizon: string; sessionBucket: string; riskProfile: string;
  stopPresent: boolean; stopDistancePct: number | null; firstTargetDistancePct: number | null; rewardToRisk: readonly number[]; targetCount: number; levelBasisStated: boolean;
  /** Market regime at the time, when one is known (never filled in with a guess). */
  regime?: string | null;
  /** Strike distance from the underlying price in percent, only when the underlying price was known. */
  strikeDistancePct?: number | null;
}

export interface ProfileConfig { minSample: number; majorityShare: number; minClusterSize: number; maxClusters: number; mediumSample: number }
export const DEFAULT_PROFILE_CONFIG: ProfileConfig = { minSample: 20, majorityShare: 0.6, minClusterSize: 5, maxClusters: 8, mediumSample: 50 };

export interface Distribution { counts: Record<string, number>; known: number; unknown: number; top: string | null; topShare: number | null }
export interface Quantiles { n: number; p25: number; median: number; p75: number }
export interface Cluster { key: string; setup: string; horizon: string; optionType: string; entryKind: string; count: number; share: number }
export interface ChannelProfile {
  version: string; sampleSize: number; window: { from: Date | null; to: Date | null };
  entryStyle: Distribution; optionTypePreference: Distribution; underlyings: Distribution; tradingTimes: Distribution; horizons: Distribution; setups: Distribution; marketConditions: Distribution;
  strikeDistancePct: Quantiles | null;
  clusters: Cluster[];
  rules: {
    stop: { presentShare: number | null; distancePct: Quantiles | null; basisStatedShare: number | null };
    targets: { count: Quantiles | null; firstDistancePct: Quantiles | null; rewardToRisk: Quantiles | null };
    risk: { bands: Distribution; noStopShare: number | null };
  };
  strategyConfidence: "UNKNOWN" | "LOW" | "MEDIUM"; limitations: string[];
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;
const isUnknown = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === "" || /^UNKNOWN/i.test(v.trim());

export function distribution(values: ReadonlyArray<string | null | undefined>, cfg: ProfileConfig): Distribution {
  const counts: Record<string, number> = {}; let unknown = 0;
  for (const v of values) { if (isUnknown(v)) { unknown++; continue; } const k = (v as string).trim().toUpperCase(); counts[k] = (counts[k] ?? 0) + 1; }
  const known = values.length - unknown;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  // a "top" is a preference only with enough KNOWN signals and a clear majority of them
  const share = best && known > 0 ? best[1] / known : null;
  const isPref = best !== undefined && known >= cfg.minSample && share !== null && share >= cfg.majorityShare;
  return { counts, known, unknown, top: isPref ? (best as [string, number])[0] : null, topShare: share === null ? null : round(share) };
}

export function quantiles(values: ReadonlyArray<number | null | undefined>): Quantiles | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number): number => { const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return round((v[lo] as number) + ((v[hi] as number) - (v[lo] as number)) * (i - lo)); };
  return { n: v.length, p25: q(0.25), median: q(0.5), p75: q(0.75) };
}

export function buildChannelProfile(signals: readonly ChannelSignal[], override: Partial<ProfileConfig> = {}): ChannelProfile {
  const cfg = { ...DEFAULT_PROFILE_CONFIG, ...override };
  const n = signals.length;
  const times = signals.map((s) => s.at.getTime());
  const buys = signals.filter((s) => s.action !== "sell");
  // clusters: recurring (setup, horizon, option type, entry kind) combinations; unknown parts stay UNKNOWN and are shown as such
  const groups = new Map<string, Cluster>();
  for (const s of signals) {
    const key = [s.setup || "UNKNOWN", s.horizon || "UNKNOWN", s.optionType ?? "UNKNOWN", s.entryKind].join("|");
    const g = groups.get(key) ?? { key, setup: s.setup || "UNKNOWN", horizon: s.horizon || "UNKNOWN", optionType: s.optionType ?? "UNKNOWN", entryKind: s.entryKind, count: 0, share: 0 };
    g.count++; groups.set(key, g);
  }
  const clusters = [...groups.values()].filter((c) => c.count >= cfg.minClusterSize).map((c) => ({ ...c, share: round(c.count / Math.max(1, n)) }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)).slice(0, cfg.maxClusters);
  const withStop = signals.filter((s) => s.stopPresent).length;
  const entryStyle = distribution(signals.map((s) => (s.entryKind === "unspecified" ? null : s.entryKind)), cfg);
  const limitations: string[] = ["descriptive statistics of the channel's own messages: not performance, not a prediction, not advice"];
  if (n < cfg.minSample) limitations.push(`only ${n} signal(s); at least ${cfg.minSample} are needed before any preference is reported`);
  if (signals.every((s) => s.strikeDistancePct == null)) limitations.push("strike distance is unknown: no underlying price was supplied");
  if (signals.every((s) => isUnknown(s.regime))) limitations.push("market conditions are unknown: no market regime was supplied");
  if (n > 0 && signals.filter((s) => isUnknown(s.horizon)).length / n > 0.5) limitations.push("most signals state no trading horizon");
  return {
    version: PROFILE_VERSION, sampleSize: n, window: { from: n ? new Date(Math.min(...times)) : null, to: n ? new Date(Math.max(...times)) : null },
    entryStyle, optionTypePreference: distribution(signals.map((s) => s.optionType), cfg), underlyings: distribution(signals.map((s) => s.underlying), cfg),
    tradingTimes: distribution(signals.map((s) => s.sessionBucket), cfg), horizons: distribution(signals.map((s) => s.horizon), cfg), setups: distribution(signals.map((s) => s.setup), cfg),
    marketConditions: distribution(signals.map((s) => s.regime), cfg), strikeDistancePct: quantiles(signals.map((s) => s.strikeDistancePct)), clusters,
    rules: {
      stop: { presentShare: n ? round(withStop / n) : null, distancePct: quantiles(signals.map((s) => s.stopDistancePct)), basisStatedShare: n ? round(signals.filter((s) => s.levelBasisStated).length / n) : null },
      targets: { count: quantiles(signals.map((s) => s.targetCount)), firstDistancePct: quantiles(signals.map((s) => s.firstTargetDistancePct)), rewardToRisk: quantiles(buys.map((s) => s.rewardToRisk[0])) },
      risk: { bands: distribution(signals.map((s) => s.riskProfile), cfg), noStopShare: n ? round(1 - withStop / n) : null },
    },
    strategyConfidence: n < 10 ? "UNKNOWN" : n < cfg.mediumSample || clusters.length === 0 ? "LOW" : "MEDIUM", limitations,
  };
}
