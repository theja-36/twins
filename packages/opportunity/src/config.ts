/**
 * Independent Opportunity Engine configuration (Stage 05). Strict: a malformed value THROWS (start-up fails closed). DISABLED by default, and an empty universe scans nothing.
 * The data-source label is the operator's declaration of what the configured provider is; the only providers that exist today are in-memory and file snapshots, so the default is FIXTURE.
 */
export const OPPORTUNITY_CONFIG_VERSION = "opportunity-config-v1";
export type OpportunityDataSource = "FIXTURE" | "LIVE" | "HISTORICAL";
export interface OpportunityConfig {
  enabled: boolean;
  /** Underlyings to scan, upper case. Empty means nothing is scanned (reported as UNAVAILABLE, never as an empty success). */
  universe: readonly string[];
  exchange: string;
  dataSource: OpportunityDataSource;
  /** A series whose newest bar is older than this is STALE and skipped. */
  maxBarAgeMinutes: number;
  /** Higher timeframes (seconds) built by resampling the provider's series, used for multi-timeframe confluence. */
  confluenceTimeframesSeconds: readonly number[];
  candidateTtlMinutes: number;
  maxCandidatesPerScan: number;
  /** Candidates ranked below this are recorded as skipped, not created. */
  minRankScore: number;
  researchMaxAttempts: number;
  researchBatchSize: number;
  /** An IN_RESEARCH candidate untouched for this long is treated as abandoned and released. */
  researchLeaseMinutes: number;
  /** A price older than this cannot revalidate a candidate. */
  maxPriceAgeMinutes: number;
}
export const DEFAULT_OPPORTUNITY_CONFIG: OpportunityConfig = {
  enabled: false, universe: [], exchange: "NSE", dataSource: "FIXTURE", maxBarAgeMinutes: 30, confluenceTimeframesSeconds: [3600], candidateTtlMinutes: 240,
  maxCandidatesPerScan: 10, minRankScore: 40, researchMaxAttempts: 3, researchBatchSize: 5, researchLeaseMinutes: 15, maxPriceAgeMinutes: 10,
};
const bool = (n: string, v: string | undefined, d: boolean): boolean => { if (v === undefined || v === "") return d; if (v === "true") return true; if (v === "false") return false; throw new Error(`${n} must be exactly "true" or "false"`); };
const int = (n: string, v: string | undefined, d: number, lo: number, hi: number): number => {
  if (v === undefined || v === "") return d;
  const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${n} must be an integer between ${lo} and ${hi}`); return x;
};
export function validateOpportunityConfig(c: OpportunityConfig): OpportunityConfig {
  if (!/^[A-Z]{2,10}$/.test(c.exchange)) throw new Error("the exchange must be 2-10 upper-case letters");
  for (const u of c.universe) if (!/^[A-Z0-9&_-]{1,20}$/.test(u)) throw new Error(`the universe entry "${u.slice(0, 24)}" is not a valid underlying`);
  if (new Set(c.universe).size !== c.universe.length) throw new Error("the universe has duplicates");
  if (c.universe.length > 200) throw new Error("the universe is limited to 200 underlyings");
  if (c.minRankScore < 0 || c.minRankScore > 100) throw new Error("the minimum rank score must be between 0 and 100");
  for (const s of c.confluenceTimeframesSeconds) if (!Number.isInteger(s) || s < 60 || s > 86_400) throw new Error("a confluence timeframe must be 60..86400 seconds");
  return c;
}
export function loadOpportunityConfig(env: Record<string, string | undefined> = process.env): OpportunityConfig {
  const d = DEFAULT_OPPORTUNITY_CONFIG;
  const ds = env["TWINS_OPPORTUNITY_DATA_SOURCE"] ?? d.dataSource;
  if (ds !== "FIXTURE" && ds !== "LIVE" && ds !== "HISTORICAL") throw new Error("TWINS_OPPORTUNITY_DATA_SOURCE must be FIXTURE, LIVE or HISTORICAL");
  const list = (env["TWINS_OPPORTUNITY_UNIVERSE"] ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const tfs = (env["TWINS_OPPORTUNITY_CONFLUENCE_SECONDS"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  return validateOpportunityConfig({
    enabled: bool("TWINS_OPPORTUNITY_ENABLED", env["TWINS_OPPORTUNITY_ENABLED"], d.enabled), universe: list, exchange: (env["TWINS_OPPORTUNITY_EXCHANGE"] ?? d.exchange).toUpperCase(), dataSource: ds,
    maxBarAgeMinutes: int("TWINS_OPPORTUNITY_MAX_BAR_AGE_MINUTES", env["TWINS_OPPORTUNITY_MAX_BAR_AGE_MINUTES"], d.maxBarAgeMinutes, 1, 10_080),
    confluenceTimeframesSeconds: tfs.length ? tfs : d.confluenceTimeframesSeconds,
    candidateTtlMinutes: int("TWINS_OPPORTUNITY_TTL_MINUTES", env["TWINS_OPPORTUNITY_TTL_MINUTES"], d.candidateTtlMinutes, 5, 10_080),
    maxCandidatesPerScan: int("TWINS_OPPORTUNITY_MAX_PER_SCAN", env["TWINS_OPPORTUNITY_MAX_PER_SCAN"], d.maxCandidatesPerScan, 1, 100),
    minRankScore: int("TWINS_OPPORTUNITY_MIN_RANK", env["TWINS_OPPORTUNITY_MIN_RANK"], d.minRankScore, 0, 100),
    researchMaxAttempts: int("TWINS_OPPORTUNITY_RESEARCH_ATTEMPTS", env["TWINS_OPPORTUNITY_RESEARCH_ATTEMPTS"], d.researchMaxAttempts, 1, 10),
    researchBatchSize: int("TWINS_OPPORTUNITY_RESEARCH_BATCH", env["TWINS_OPPORTUNITY_RESEARCH_BATCH"], d.researchBatchSize, 1, 50),
    researchLeaseMinutes: int("TWINS_OPPORTUNITY_RESEARCH_LEASE_MINUTES", env["TWINS_OPPORTUNITY_RESEARCH_LEASE_MINUTES"], d.researchLeaseMinutes, 1, 1440),
    maxPriceAgeMinutes: int("TWINS_OPPORTUNITY_MAX_PRICE_AGE_MINUTES", env["TWINS_OPPORTUNITY_MAX_PRICE_AGE_MINUTES"], d.maxPriceAgeMinutes, 1, 1440),
  });
}
