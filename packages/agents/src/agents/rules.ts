import { AgentContractError } from "../contract";

/**
 * Rule configuration of the first two research agents (Stage 5 / Task 2). Conservative defaults; a malformed override THROWS at start-up (no silent fallback).
 *
 *   TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES / _ADVERSE_MINUTES / _BLOCK_MINUTES   10 / 30 / 120 (strictly increasing)
 *   TWINS_AGENT_SIGNAL_FUTURE_TOLERANCE_MINUTES                                      5 (a signal time further in the future is impossible -> BLOCKING)
 *   TWINS_AGENT_TARGET_ORDERING                strict | non_strict (default strict: targets must improve strictly)
 *   TWINS_AGENT_TARGET_ORDER_VIOLATION         ADVERSE | BLOCKING (default ADVERSE)
 *   TWINS_AGENT_REVISION_AMBIGUOUS             ADVERSE | BLOCKING (default BLOCKING: an ambiguous revision group is non-actionable)
 *   TWINS_AGENT_INSTRUMENT_REFERENCE           none | file:<path to a twins-instrument-reference-v1 .json> (default none)
 *   TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS        1-730 (default 90)
 *   TWINS_AGENT_EXPIRY_BEYOND_HORIZON          ADVERSE | BLOCKING (default ADVERSE)
 *   TWINS_AGENT_MISSING_LOT_SIZE               ADVERSE | BLOCKING (default BLOCKING: a derivative without a lot size / multiplier cannot be sized)
 *   TWINS_AGENT_REFERENCE_MAX_AGE_DAYS         1-365 (default 30; an older reference snapshot is a CAUTION)
 * Enable / disable and weights use the engine settings (TWINS_AGENT_ENGINE_DISABLED_AGENTS, TWINS_AGENT_ENGINE_WEIGHTS).
 */
export const AGENT_RULES_VERSION = "agent-rules-v1";
export type Severity2 = "ADVERSE" | "BLOCKING";
export interface AgentRulesConfig {
  version: string;
  signal: { staleCautionMinutes: number; staleAdverseMinutes: number; staleBlockMinutes: number; futureToleranceMinutes: number; targetOrdering: "strict" | "non_strict"; targetOrderViolation: Severity2; ambiguousRevision: Severity2 };
  instrument: { maxExpiryHorizonDays: number; beyondHorizon: Severity2; missingLotSize: Severity2; referenceMaxAgeDays: number; referenceSource: string };
}
export const DEFAULT_AGENT_RULES: AgentRulesConfig = {
  version: AGENT_RULES_VERSION,
  signal: { staleCautionMinutes: 10, staleAdverseMinutes: 30, staleBlockMinutes: 120, futureToleranceMinutes: 5, targetOrdering: "strict", targetOrderViolation: "ADVERSE", ambiguousRevision: "BLOCKING" },
  instrument: { maxExpiryHorizonDays: 90, beyondHorizon: "ADVERSE", missingLotSize: "BLOCKING", referenceMaxAgeDays: 30, referenceSource: "none" },
};
const bad = (what: string): never => { throw new AgentContractError("INVALID_ENGINE_CONFIG", `invalid agent rules configuration: ${what}`); };
const int = (env: Record<string, string | undefined>, name: string, def: number, lo: number, hi: number): number => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d{1,4}$/.test(v) || Number(v) < lo || Number(v) > hi) bad(name);
  return Number(v);
};
const pick = <T extends string>(env: Record<string, string | undefined>, name: string, allowed: readonly T[], def: T): T => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!(allowed as readonly string[]).includes(v)) bad(name);
  return v as T;
};

export function validateAgentRules(c: AgentRulesConfig): AgentRulesConfig {
  const s = c.signal, i = c.instrument;
  if (!(s.staleCautionMinutes >= 1 && s.staleCautionMinutes < s.staleAdverseMinutes && s.staleAdverseMinutes < s.staleBlockMinutes && s.staleBlockMinutes <= 10_080)) bad("staleness thresholds must be strictly increasing");
  if (!(s.futureToleranceMinutes >= 0 && s.futureToleranceMinutes <= 60)) bad("future tolerance");
  if (!(i.maxExpiryHorizonDays >= 1 && i.maxExpiryHorizonDays <= 730) || !(i.referenceMaxAgeDays >= 1 && i.referenceMaxAgeDays <= 365)) bad("instrument horizon / age");
  if (!(i.referenceSource === "none" || /^file:.{1,400}$/.test(i.referenceSource))) bad("instrument reference source");
  return c;
}
export function loadAgentRulesConfig(env: Record<string, string | undefined> = process.env): AgentRulesConfig {
  const d = DEFAULT_AGENT_RULES;
  return validateAgentRules({
    version: AGENT_RULES_VERSION,
    signal: {
      staleCautionMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES", d.signal.staleCautionMinutes, 1, 10_080), staleAdverseMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_ADVERSE_MINUTES", d.signal.staleAdverseMinutes, 1, 10_080),
      staleBlockMinutes: int(env, "TWINS_AGENT_SIGNAL_STALE_BLOCK_MINUTES", d.signal.staleBlockMinutes, 1, 10_080), futureToleranceMinutes: int(env, "TWINS_AGENT_SIGNAL_FUTURE_TOLERANCE_MINUTES", d.signal.futureToleranceMinutes, 0, 60),
      targetOrdering: pick(env, "TWINS_AGENT_TARGET_ORDERING", ["strict", "non_strict"], d.signal.targetOrdering), targetOrderViolation: pick(env, "TWINS_AGENT_TARGET_ORDER_VIOLATION", ["ADVERSE", "BLOCKING"], d.signal.targetOrderViolation),
      ambiguousRevision: pick(env, "TWINS_AGENT_REVISION_AMBIGUOUS", ["ADVERSE", "BLOCKING"], d.signal.ambiguousRevision),
    },
    instrument: {
      maxExpiryHorizonDays: int(env, "TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS", d.instrument.maxExpiryHorizonDays, 1, 730), beyondHorizon: pick(env, "TWINS_AGENT_EXPIRY_BEYOND_HORIZON", ["ADVERSE", "BLOCKING"], d.instrument.beyondHorizon),
      missingLotSize: pick(env, "TWINS_AGENT_MISSING_LOT_SIZE", ["ADVERSE", "BLOCKING"], d.instrument.missingLotSize), referenceMaxAgeDays: int(env, "TWINS_AGENT_REFERENCE_MAX_AGE_DAYS", d.instrument.referenceMaxAgeDays, 1, 365),
      referenceSource: env["TWINS_AGENT_INSTRUMENT_REFERENCE"] === undefined || env["TWINS_AGENT_INSTRUMENT_REFERENCE"] === "" ? d.instrument.referenceSource : (env["TWINS_AGENT_INSTRUMENT_REFERENCE"] as string),
    },
  });
}
