/**
 * Drawdown circuit breaker (P1 #11), advisory. PURE: reads an equity curve and says how deep the peak-to-current drawdown is and what a REDUCE-ONLY response would be. It can recommend smaller
 * size or "no NEW entries"; it never recommends increasing risk and never forces an exit, places nothing and approves nothing. Levels leave with hysteresis (recovering past a threshold is not enough: the
 * drawdown must fall below `hysteresis` x that threshold), so the level does not flap. Bad data fails to CAUTION with a reason, not to NORMAL. This complements the existing daily/weekly loss breakers (which
 * work from recorded loss events); it works from the equity curve.
 */
export const DRAWDOWN_GOVERNOR_VERSION = "drawdown-governor-v1";
export const LEVELS = ["NORMAL", "CAUTION", "REDUCE_ONLY", "HALT_NEW_ENTRIES"] as const;
export type DrawdownLevel = (typeof LEVELS)[number];
export interface EquityPoint { at: string; equity: number }
export interface DrawdownPolicy { cautionPct: number; reducePct: number; haltPct: number; /** In (0,1]: leave a level only below hysteresis x its threshold. */ hysteresis: number; sizeMultipliers: Record<DrawdownLevel, number> }
export const DEFAULT_DRAWDOWN_POLICY: DrawdownPolicy = { cautionPct: 3, reducePct: 5, haltPct: 8, hysteresis: 0.8, sizeMultipliers: { NORMAL: 1, CAUTION: 0.75, REDUCE_ONLY: 0.5, HALT_NEW_ENTRIES: 0 } };
export class DrawdownPolicyError extends Error { constructor(m: string) { super(m); this.name = "DrawdownPolicyError"; } }

export function validateDrawdownPolicy(p: DrawdownPolicy): DrawdownPolicy {
  if (!(p.cautionPct > 0 && p.reducePct > p.cautionPct && p.haltPct > p.reducePct)) throw new DrawdownPolicyError("thresholds must satisfy 0 < caution < reduce < halt");
  if (!(p.hysteresis > 0 && p.hysteresis <= 1)) throw new DrawdownPolicyError("hysteresis must be in (0, 1]");
  const m = p.sizeMultipliers;
  const ok = LEVELS.every((k) => Number.isFinite(m[k]) && m[k] >= 0 && m[k] <= 1) && m.NORMAL === 1 && m.CAUTION >= m.REDUCE_ONLY && m.REDUCE_ONLY >= m.HALT_NEW_ENTRIES;
  if (!ok) throw new DrawdownPolicyError("size multipliers must be in [0,1], NORMAL = 1 and non-increasing with depth (a multiplier above 1 is refused)");
  return p;
}
export interface DrawdownAssessment {
  version: typeof DRAWDOWN_GOVERNOR_VERSION; level: DrawdownLevel; drawdownPct: number | null; peakEquity: number | null; currentEquity: number | null;
  /** Multiplier in [0,1] to apply to NEW position sizes; 0 means no new entries. Never above 1. */
  sizeMultiplier: number; reasons: string[];
  /** Existing positions are never closed by this assessment. */
  forcesExit: false; grantsApproval: false;
}
const levelIndex = (l: DrawdownLevel): number => LEVELS.indexOf(l);
const round = (x: number): number => Math.round(x * 1e4) / 1e4;

export function evaluateDrawdown(points: readonly EquityPoint[], policy: DrawdownPolicy = DEFAULT_DRAWDOWN_POLICY, previous: DrawdownLevel | null = null): DrawdownAssessment {
  const p = validateDrawdownPolicy(policy);
  const invalid = (reason: string): DrawdownAssessment => ({ version: DRAWDOWN_GOVERNOR_VERSION, level: "CAUTION", drawdownPct: null, peakEquity: null, currentEquity: null, sizeMultiplier: p.sizeMultipliers.CAUTION, reasons: [reason], forcesExit: false, grantsApproval: false });
  if (points.length === 0) return invalid("EQUITY_CURVE_EMPTY");
  let peak = -Infinity, prevT = -Infinity;
  for (const pt of points) {
    const t = Date.parse(pt.at);
    if (!Number.isFinite(pt.equity) || pt.equity <= 0 || Number.isNaN(t) || t < prevT) return invalid("EQUITY_DATA_INVALID");
    prevT = t;
    if (pt.equity > peak) peak = pt.equity;
  }
  const current = (points[points.length - 1] as EquityPoint).equity;
  const dd = round(((peak - current) / peak) * 100);
  const raw: DrawdownLevel = dd >= p.haltPct ? "HALT_NEW_ENTRIES" : dd >= p.reducePct ? "REDUCE_ONLY" : dd >= p.cautionPct ? "CAUTION" : "NORMAL";
  const threshold = (l: DrawdownLevel): number => (l === "HALT_NEW_ENTRIES" ? p.haltPct : l === "REDUCE_ONLY" ? p.reducePct : l === "CAUTION" ? p.cautionPct : 0);
  let level = raw;
  const reasons = [`DRAWDOWN_${dd.toFixed(2)}_PCT_FROM_PEAK`];
  // Hysteresis: a level is only left (moving to a shallower one) when the drawdown has fallen below hysteresis x that level's threshold.
  if (previous !== null && levelIndex(raw) < levelIndex(previous) && dd >= p.hysteresis * threshold(previous)) { level = previous; reasons.push("HELD_BY_HYSTERESIS"); }
  return { version: DRAWDOWN_GOVERNOR_VERSION, level, drawdownPct: dd, peakEquity: peak, currentEquity: current, sizeMultiplier: p.sizeMultipliers[level], reasons, forcesExit: false, grantsApproval: false };
}
