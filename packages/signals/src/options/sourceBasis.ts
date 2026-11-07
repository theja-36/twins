import type { OptionsClaim } from "./types";

/**
 * Per-source DEFAULT level basis (owner decision 2026-11-07, fix 2 of the stop-loss investigation). Some channels state option stops without saying "premium". When the owner has explicitly
 * configured a source as premium-quoted, a claim from that source whose basis is `unspecified` is read as `premium` ONLY IF every guard holds: the basis is silent (no marker, no conflict), a stop and a
 * strike exist, and the stop is below `maxStopPctOfStrike` percent of the strike (a stop that small cannot be an underlying level). The change is never silent: the claim carries
 * `levelBasisInference` with the rule, the source default and the measured ratio. Anything else stays `unspecified`, so the mandatory-stop rule still refuses to guess. No source is configured by default.
 */
export const SOURCE_BASIS_RULE = "source-default-premium-v1";
export const DEFAULT_MAX_STOP_PCT_OF_STRIKE = 10;
export const SOURCE_BASIS_ENV = "TWINS_SOURCE_DEFAULT_LEVEL_BASIS";

export interface LevelBasisInference { rule: typeof SOURCE_BASIS_RULE; sourceDefault: "premium"; stopPctOfStrike: number; maxStopPctOfStrike: number }
export type InferredClaim = OptionsClaim & { levelBasisInference?: LevelBasisInference };

export interface SourceBasisConfig { premiumSources: ReadonlySet<string>; maxStopPctOfStrike: number }
export const NO_SOURCE_BASIS: SourceBasisConfig = { premiumSources: new Set(), maxStopPctOfStrike: DEFAULT_MAX_STOP_PCT_OF_STRIKE };
export class SourceBasisConfigError extends Error { constructor(m: string) { super(m); this.name = "SourceBasisConfigError"; } }

/**
 * `TWINS_SOURCE_DEFAULT_LEVEL_BASIS` = comma-separated `<source>=premium` entries (the source is the channel identifier or label; characters limited to the importer contract's set). Only `premium`
 * is accepted. Absent or empty => no source configured. Anything malformed is a configuration error (fail closed at start-up).
 */
export function parseSourceBasisConfig(env: Record<string, string | undefined>, maxStopPctOfStrike = DEFAULT_MAX_STOP_PCT_OF_STRIKE): SourceBasisConfig {
  const raw = env[SOURCE_BASIS_ENV];
  if (raw === undefined || raw.trim() === "") return { ...NO_SOURCE_BASIS, maxStopPctOfStrike };
  if (!(maxStopPctOfStrike > 0 && maxStopPctOfStrike <= 25)) throw new SourceBasisConfigError("maxStopPctOfStrike must be in (0, 25]");
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const m = /^\s*([A-Za-z0-9_.:@ -]{1,80}?)\s*=\s*premium\s*$/.exec(part);
    if (!m) throw new SourceBasisConfigError(`${SOURCE_BASIS_ENV} entries must look like <source>=premium`);
    set.add(m[1] as string);
  }
  return { premiumSources: set, maxStopPctOfStrike };
}

/** Pure. Returns the claim unchanged unless every guard holds; never touches action, entry, stop, targets or expiry. */
export function applySourceDefaultBasis(claim: OptionsClaim, source: string | null, cfg: SourceBasisConfig): InferredClaim {
  if (source === null || !cfg.premiumSources.has(source)) return claim;
  if (claim.levelBasis !== "unspecified" || claim.levelBasisConflict) return claim;
  if (claim.stopLoss === null || claim.strike === null || !(claim.stopLoss > 0) || !(claim.strike > 0)) return claim;
  const pct = (claim.stopLoss / claim.strike) * 100;
  if (!(pct < cfg.maxStopPctOfStrike)) return claim;
  return { ...claim, levelBasis: "premium", levelBasisInference: { rule: SOURCE_BASIS_RULE, sourceDefault: "premium", stopPctOfStrike: Math.round(pct * 1e4) / 1e4, maxStopPctOfStrike: cfg.maxStopPctOfStrike } };
}
