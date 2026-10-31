import type { AgentRulesConfig } from "@twins/agents/src/agents/rules";
import { KiteError } from "./errors";

/**
 * Explicit, validated configuration for the provider / snapshot wiring. Each value records where it comes from:
 *   product_rule        taken from the existing TWINS agent rules (`rules.quotes`), so the adapters and the consumers agree by construction
 *   env_override        set by the operator; validated, and never allowed to exceed the product rule it overrides
 *   unapproved_default  NOT a product decision and NOT tuned: an operational placeholder that needs owner approval before any production use
 */
export interface KiteWiringConfig {
  /** Oldest upstream quote the adapters will serve. Product rule: the point at which the agents themselves treat a quote as UNAVAILABLE. */
  quoteMaxAgeMs: number;
  /** How far an upstream timestamp may be ahead of the local clock. Product rule: `rules.quotes.futureToleranceMinutes`. */
  futureToleranceMs: number;
  /** Largest gap between an option's and its index's upstream times for the index price to be attached as the option's underlying price. UNAPPROVED default. */
  underlyingWindowMs: number;
  /** Strikes each side of the money in an assembled option chain. UNAPPROVED default. */
  chainStrikesEachSide: number;
  provenance: Record<"quoteMaxAgeMs" | "futureToleranceMs" | "underlyingWindowMs" | "chainStrikesEachSide", "product_rule" | "env_override" | "unapproved_default">;
}

export const KITE_WIRING_ENV = {
  quoteMaxAgeSeconds: "TWINS_KITE_QUOTE_MAX_AGE_SECONDS",
  underlyingWindowSeconds: "TWINS_KITE_UNDERLYING_WINDOW_SECONDS",
  chainStrikesEachSide: "TWINS_KITE_CHAIN_STRIKES_EACH_SIDE",
} as const;

/** Operational placeholders (see `underlyingWindowMs`, `chainStrikesEachSide`): used only when the operator sets nothing. Not approved, not tuned. */
export const UNAPPROVED_DEFAULTS = { underlyingWindowMs: 60_000, chainStrikesEachSide: 5 } as const;

const intIn = (raw: string, min: number, max: number): number => {
  if (!/^[0-9]{1,6}$/.test(raw.trim())) throw new KiteError("CONFIG");
  const n = Number(raw);
  if (n < min || n > max) throw new KiteError("CONFIG");
  return n;
};

/** A malformed or out-of-range value THROWS (CONFIG); a silently wrong freshness policy would hide a stale feed. */
export function loadKiteWiringConfig(rules: Pick<AgentRulesConfig, "quotes">, env: Record<string, string | undefined> = process.env): KiteWiringConfig {
  const productMaxMs = rules.quotes.unavailableMinutes * 60_000;
  const prov: KiteWiringConfig["provenance"] = { quoteMaxAgeMs: "product_rule", futureToleranceMs: "product_rule", underlyingWindowMs: "unapproved_default", chainStrikesEachSide: "unapproved_default" };
  let quoteMaxAgeMs = productMaxMs;
  const a = env[KITE_WIRING_ENV.quoteMaxAgeSeconds];
  if (a !== undefined && a !== "") {
    quoteMaxAgeMs = intIn(a, 1, 3600) * 1000;
    if (quoteMaxAgeMs > productMaxMs) throw new KiteError("CONFIG"); // never looser than the consumers' own limit
    prov.quoteMaxAgeMs = "env_override";
  }
  let underlyingWindowMs: number = UNAPPROVED_DEFAULTS.underlyingWindowMs;
  const u = env[KITE_WIRING_ENV.underlyingWindowSeconds];
  if (u !== undefined && u !== "") { underlyingWindowMs = intIn(u, 1, 300) * 1000; prov.underlyingWindowMs = "env_override"; }
  let chainStrikesEachSide: number = UNAPPROVED_DEFAULTS.chainStrikesEachSide;
  const c = env[KITE_WIRING_ENV.chainStrikesEachSide];
  if (c !== undefined && c !== "") { chainStrikesEachSide = intIn(c, 1, 50); prov.chainStrikesEachSide = "env_override"; }
  return { quoteMaxAgeMs, futureToleranceMs: rules.quotes.futureToleranceMinutes * 60_000, underlyingWindowMs, chainStrikesEachSide, provenance: prov };
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** Entry-point guards: a missing / non-positive wiring value is a loud CONFIG error, never a silent NaN comparison. */
export function requireWiring(v: { maxAgeMs?: unknown; futureToleranceMs?: unknown; underlyingWindowMs?: unknown; strikesEachSide?: unknown }): void {
  if ("maxAgeMs" in v && !pos(v.maxAgeMs)) throw new KiteError("CONFIG");
  if ("futureToleranceMs" in v && !(typeof v.futureToleranceMs === "number" && Number.isFinite(v.futureToleranceMs) && v.futureToleranceMs >= 0)) throw new KiteError("CONFIG");
  if ("underlyingWindowMs" in v && !pos(v.underlyingWindowMs)) throw new KiteError("CONFIG");
  if ("strikesEachSide" in v && !(typeof v.strikesEachSide === "number" && Number.isInteger(v.strikesEachSide) && v.strikesEachSide >= 1 && v.strikesEachSide <= 50)) throw new KiteError("CONFIG");
}
