/**
 * Position-sizing configuration (Stage 3 / Task 2). Same pattern as the stop-loss bounds: documented defaults, strict environment overrides, a malformed
 * value makes the loader throw (the process does not start; it never silently falls back), and every sizing record states the configuration it used.
 * These are SIZING defaults, not the final portfolio limits (a later task).
 */
export interface SizingConfig {
  /** Per-trade maximum risk as a percentage of available capital. */
  maxRiskPct: number;
  /** Optional absolute per-trade cap (currency); the effective cap is the smaller of the two. */
  maxRiskAmount: number | null;
  /** Share of the per-trade cap a tier may use, in percent. */
  tierPct: { HIGH: number; MEDIUM: number; LOW: number };
  /** Confidence score (0-100) at or above which the confidence tier is HIGH / MEDIUM; anything above 0 below that is LOW; 0 or absent is UNKNOWN. */
  confidenceMin: { HIGH: number; MEDIUM: number };
  /** Available capital from configuration; null = not configured (nothing can be sized). */
  availableCapital: number | null;
  source: Record<string, "default" | "env">;
}

export const SIZING_CONFIG_VERSION = "sizing-config-v1";
/** No configuration may exceed this share of capital per trade: a hard capital-protection ceiling, not a tunable. */
export const HARD_MAX_RISK_PCT = 5;

export const DEFAULT_SIZING = { maxRiskPct: 1, tierPct: { HIGH: 100, MEDIUM: 50, LOW: 25 }, confidenceMin: { HIGH: 75, MEDIUM: 50 } } as const;

const DECIMAL = /^[0-9]{1,12}(?:\.[0-9]{1,6})?$/;

function read(env: Record<string, string | undefined>, name: string, min: number, max: number, minInclusive = false): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!DECIMAL.test(raw) || !(minInclusive ? v >= min : v > min) || !(v <= max)) throw new Error(`${name} must be a decimal ${minInclusive ? "at least" : "greater than"} ${min} and at most ${max}`);
  return v;
}

export function loadSizingConfig(env: Record<string, string | undefined> = process.env): SizingConfig {
  const source: SizingConfig["source"] = {};
  const pick = <T extends number | null>(key: string, value: number | undefined, fallback: T): number | T => {
    source[key] = value === undefined ? "default" : "env";
    return value === undefined ? fallback : value;
  };
  const maxRiskPct = pick("maxRiskPct", read(env, "TWINS_SIZING_MAX_RISK_PCT", 0, HARD_MAX_RISK_PCT), DEFAULT_SIZING.maxRiskPct) as number;
  const maxRiskAmount = pick("maxRiskAmount", read(env, "TWINS_SIZING_MAX_RISK_AMOUNT", 0, 1e12), null);
  const HIGH = pick("tierHigh", read(env, "TWINS_SIZING_TIER_PCT_HIGH", 0, 100, true), DEFAULT_SIZING.tierPct.HIGH) as number;
  const MEDIUM = pick("tierMedium", read(env, "TWINS_SIZING_TIER_PCT_MEDIUM", 0, 100, true), DEFAULT_SIZING.tierPct.MEDIUM) as number;
  const LOW = pick("tierLow", read(env, "TWINS_SIZING_TIER_PCT_LOW", 0, 100, true), DEFAULT_SIZING.tierPct.LOW) as number;
  if (!(HIGH >= MEDIUM && MEDIUM >= LOW)) throw new Error("TWINS_SIZING_TIER_PCT_* must satisfy HIGH >= MEDIUM >= LOW");
  const cHigh = pick("confidenceHigh", read(env, "TWINS_SIZING_CONFIDENCE_HIGH_MIN", 0, 100), DEFAULT_SIZING.confidenceMin.HIGH) as number;
  const cMed = pick("confidenceMedium", read(env, "TWINS_SIZING_CONFIDENCE_MEDIUM_MIN", 0, 100), DEFAULT_SIZING.confidenceMin.MEDIUM) as number;
  if (!(cHigh > cMed)) throw new Error("TWINS_SIZING_CONFIDENCE_HIGH_MIN must be greater than TWINS_SIZING_CONFIDENCE_MEDIUM_MIN");
  const availableCapital = pick("availableCapital", read(env, "TWINS_SIZING_AVAILABLE_CAPITAL", 0, 1e13), null);
  return { maxRiskPct, maxRiskAmount, tierPct: { HIGH, MEDIUM, LOW }, confidenceMin: { HIGH: cHigh, MEDIUM: cMed }, availableCapital, source };
}

export const DEFAULT_SIZING_CONFIG: SizingConfig = loadSizingConfig({});
