/**
 * Portfolio open-risk and correlation limits (Stage 3 / Task 3): configuration. Same pattern as the stop-loss and sizing configuration: documented
 * defaults, strict environment overrides, a malformed value makes the loader throw (no silent fallback), and every evaluation stores the limits it used.
 * These are PORTFOLIO limits, separate from the per-trade sizing cap (1%) and its hard 5% ceiling.
 */
export interface PortfolioConfig {
  /** Percent of capital. */
  maxTotalRiskPct: number;
  /** Optional absolute cap on total planned risk (currency). */
  maxTotalRiskAmount: number | null;
  maxGroupRiskPct: number;
  maxUnderlyingRiskPct: number;
  maxMarketRiskPct: number;
  /** The tighter group: same underlying AND same expiry. */
  maxExpiryRiskPct: number;
  maxActive: number;
  maxActivePerGroup: number;
  maxActivePerUnderlying: number;
  maxActivePerExpiry: number;
  /** Correlation groups: group name -> underlying symbols. An underlying in no group is its own group. */
  correlationGroups: Record<string, string[]>;
  source: Record<string, "default" | "env">;
}

export const PORTFOLIO_CONFIG_VERSION = "portfolio-config-v1";
export const DEFAULT_CORRELATION_GROUPS: Readonly<Record<string, readonly string[]>> = { INDIA_INDEX: ["NIFTY", "BANKNIFTY"] };

export const DEFAULT_PORTFOLIO = {
  maxTotalRiskPct: 3, maxGroupRiskPct: 2, maxUnderlyingRiskPct: 1.5, maxMarketRiskPct: 3, maxExpiryRiskPct: 1,
  maxActive: 5, maxActivePerGroup: 3, maxActivePerUnderlying: 2, maxActivePerExpiry: 2,
} as const;

const DECIMAL = /^[0-9]{1,12}(?:\.[0-9]{1,6})?$/;
const INTEGER = /^[1-9][0-9]{0,3}$/;
const GROUP_NAME = /^[A-Z][A-Z0-9_]{1,39}$/;
const SYMBOL = /^[A-Z0-9&-]{1,30}$/;

function pct(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!DECIMAL.test(raw) || !(v > 0 && v <= 100)) throw new Error(`${name} must be a decimal percentage greater than 0 and at most 100`);
  return v;
}
function count(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!INTEGER.test(raw)) throw new Error(`${name} must be a whole number from 1 to 9999`);
  return Number(raw);
}

/** `NAME=SYM,SYM;NAME2=SYM` (or `NONE` for no groups). A symbol may belong to one group only. */
export function parseCorrelationGroups(raw: string): Record<string, string[]> {
  if (raw.trim().toUpperCase() === "NONE") return {};
  const groups: Record<string, string[]> = {};
  const seen = new Map<string, string>();
  for (const part of raw.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, members, ...rest] = part.split("=");
    if (rest.length > 0 || !name || !members || !GROUP_NAME.test(name.trim())) throw new Error("TWINS_PORTFOLIO_CORRELATION_GROUPS must look like NAME=SYMBOL,SYMBOL;NAME2=SYMBOL");
    const key = name.trim();
    if (groups[key]) throw new Error(`TWINS_PORTFOLIO_CORRELATION_GROUPS defines ${key} twice`);
    const symbols = members.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0 || symbols.some((s) => !SYMBOL.test(s))) throw new Error("TWINS_PORTFOLIO_CORRELATION_GROUPS has an invalid symbol");
    for (const s of symbols) {
      if (seen.has(s)) throw new Error(`TWINS_PORTFOLIO_CORRELATION_GROUPS: ${s} is in both ${seen.get(s)} and ${key}`);
      seen.set(s, key);
    }
    groups[key] = symbols;
  }
  return groups;
}

export function loadPortfolioConfig(env: Record<string, string | undefined> = process.env): PortfolioConfig {
  const source: PortfolioConfig["source"] = {};
  const pick = <T>(key: string, value: T | undefined, fallback: T): T => { source[key] = value === undefined ? "default" : "env"; return value === undefined ? fallback : value; };
  const amountRaw = env["TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT"];
  if (amountRaw !== undefined && amountRaw !== "" && (!DECIMAL.test(amountRaw) || !(Number(amountRaw) > 0))) throw new Error("TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT must be a decimal greater than 0");
  const groupsRaw = env["TWINS_PORTFOLIO_CORRELATION_GROUPS"];
  source["correlationGroups"] = groupsRaw === undefined || groupsRaw === "" ? "default" : "env";
  return {
    maxTotalRiskPct: pick("maxTotalRiskPct", pct(env, "TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT"), DEFAULT_PORTFOLIO.maxTotalRiskPct),
    maxTotalRiskAmount: pick("maxTotalRiskAmount", amountRaw === undefined || amountRaw === "" ? undefined : Number(amountRaw), null as number | null),
    maxGroupRiskPct: pick("maxGroupRiskPct", pct(env, "TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT"), DEFAULT_PORTFOLIO.maxGroupRiskPct),
    maxUnderlyingRiskPct: pick("maxUnderlyingRiskPct", pct(env, "TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT"), DEFAULT_PORTFOLIO.maxUnderlyingRiskPct),
    maxMarketRiskPct: pick("maxMarketRiskPct", pct(env, "TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT"), DEFAULT_PORTFOLIO.maxMarketRiskPct),
    maxExpiryRiskPct: pick("maxExpiryRiskPct", pct(env, "TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT"), DEFAULT_PORTFOLIO.maxExpiryRiskPct),
    maxActive: pick("maxActive", count(env, "TWINS_PORTFOLIO_MAX_ACTIVE"), DEFAULT_PORTFOLIO.maxActive),
    maxActivePerGroup: pick("maxActivePerGroup", count(env, "TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP"), DEFAULT_PORTFOLIO.maxActivePerGroup),
    maxActivePerUnderlying: pick("maxActivePerUnderlying", count(env, "TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING"), DEFAULT_PORTFOLIO.maxActivePerUnderlying),
    maxActivePerExpiry: pick("maxActivePerExpiry", count(env, "TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY"), DEFAULT_PORTFOLIO.maxActivePerExpiry),
    correlationGroups: groupsRaw === undefined || groupsRaw === "" ? Object.fromEntries(Object.entries(DEFAULT_CORRELATION_GROUPS).map(([k, v]) => [k, [...v]])) : parseCorrelationGroups(groupsRaw),
    source,
  };
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = loadPortfolioConfig({});
