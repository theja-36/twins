import type { StopLossConfig, StopLossInstrumentKind } from "./types";

/**
 * Maximum stop distance as a percentage of the entry/reference price. These defaults are SANITY BOUNDS (a stop further away than this is not a
 * protective stop), NOT risk budgets: the owner's risk budgets (D-007) are a separate, later control. They are configurable and every evidence
 * record states the bound used and whether it came from the default or the environment, so a change is auditable. A malformed override
 * makes the loader throw (the process does not start), it never silently falls back.
 */
export const DEFAULT_MAX_RISK_PCT: Readonly<Record<StopLossInstrumentKind, number>> = { equity: 10, future: 10, option: 70 };

const ENV_NAMES: Record<StopLossInstrumentKind, string> = {
  equity: "TWINS_STOPLOSS_MAX_RISK_PCT_EQUITY",
  future: "TWINS_STOPLOSS_MAX_RISK_PCT_FUTURE",
  option: "TWINS_STOPLOSS_MAX_RISK_PCT_OPTION",
};

export function loadStopLossConfig(env: Record<string, string | undefined> = process.env): StopLossConfig {
  const maxRiskPct = { ...DEFAULT_MAX_RISK_PCT };
  const source: Record<StopLossInstrumentKind, "default" | "env"> = { equity: "default", future: "default", option: "default" };
  for (const kind of Object.keys(ENV_NAMES) as StopLossInstrumentKind[]) {
    const raw = env[ENV_NAMES[kind]];
    if (raw === undefined || raw === "") continue;
    if (!/^[0-9]{1,3}(?:\.[0-9]{1,4})?$/.test(raw)) throw new Error(`${ENV_NAMES[kind]} must be a decimal percentage greater than 0 and at most 100`);
    const value = Number(raw);
    if (!(value > 0 && value <= 100)) throw new Error(`${ENV_NAMES[kind]} must be a decimal percentage greater than 0 and at most 100`);
    maxRiskPct[kind] = value;
    source[kind] = "env";
  }
  return { maxRiskPct, source };
}

export const DEFAULT_STOP_LOSS_CONFIG: StopLossConfig = { maxRiskPct: DEFAULT_MAX_RISK_PCT, source: { equity: "default", future: "default", option: "default" } };
