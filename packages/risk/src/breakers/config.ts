/**
 * Loss circuit-breaker configuration (Stage 3 / Task 4). Daily 2% / weekly 5% of capital by default; a warning at 75% of a limit. The period boundary is a
 * fixed UTC offset (IST, +05:30, no DST). Strict environment overrides; a malformed value throws.
 */
export interface BreakerConfig {
  dailyLossPct: number;
  weeklyLossPct: number;
  warnPct: number;
  utcOffsetMinutes: number;
  source: Record<string, "default" | "env">;
}
export const DEFAULT_BREAKER = { dailyLossPct: 2, weeklyLossPct: 5, warnPct: 75, utcOffsetMinutes: 330 } as const;
const DECIMAL = /^[0-9]{1,3}(?:\.[0-9]{1,4})?$/;

function dec(env: Record<string, string | undefined>, name: string, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!DECIMAL.test(raw) || !(v > 0 && v <= max)) throw new Error(`${name} must be a decimal greater than 0 and at most ${max}`);
  return v;
}

export function loadBreakerConfig(env: Record<string, string | undefined> = process.env): BreakerConfig {
  const d = dec(env, "TWINS_BREAKER_DAILY_LOSS_PCT", 100);
  const w = dec(env, "TWINS_BREAKER_WEEKLY_LOSS_PCT", 100);
  const warn = dec(env, "TWINS_BREAKER_WARN_PCT", 99);
  const offRaw = env["TWINS_BREAKER_UTC_OFFSET_MINUTES"];
  if (offRaw !== undefined && offRaw !== "" && (!/^-?[0-9]{1,4}$/.test(offRaw) || Number(offRaw) < -720 || Number(offRaw) > 840)) throw new Error("TWINS_BREAKER_UTC_OFFSET_MINUTES must be a whole number from -720 to 840");
  const off = offRaw === undefined || offRaw === "" ? undefined : Number(offRaw);
  const cfg = {
    dailyLossPct: d ?? DEFAULT_BREAKER.dailyLossPct, weeklyLossPct: w ?? DEFAULT_BREAKER.weeklyLossPct, warnPct: warn ?? DEFAULT_BREAKER.warnPct, utcOffsetMinutes: off ?? DEFAULT_BREAKER.utcOffsetMinutes,
    source: { dailyLossPct: d === undefined ? "default" : "env", weeklyLossPct: w === undefined ? "default" : "env", warnPct: warn === undefined ? "default" : "env", utcOffsetMinutes: off === undefined ? "default" : "env" } as BreakerConfig["source"],
  };
  if (cfg.weeklyLossPct < cfg.dailyLossPct) throw new Error("TWINS_BREAKER_WEEKLY_LOSS_PCT must not be below TWINS_BREAKER_DAILY_LOSS_PCT");
  return cfg;
}
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = loadBreakerConfig({});
