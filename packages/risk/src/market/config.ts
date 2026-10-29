/**
 * Market-risk gate configuration (Stage 3 / Task 5): trading sessions, expiry rules, data freshness, liquidity and spread thresholds. Same pattern as the other
 * risk configuration: documented conservative defaults, strict environment overrides, a malformed value makes the loader throw (no silent fallback). The
 * numeric thresholds are proposed defaults, NOT calibrated to real market data (none is integrated); the owner must review them (D-059).
 */
export type InstrumentKind = "equity" | "future" | "option";
export const INSTRUMENT_KINDS: readonly InstrumentKind[] = ["equity", "future", "option"];

export interface SessionDef {
  /** IANA time zone. */
  timezone: string;
  /** Local HH:MM, inclusive. */
  open: string;
  /** Local HH:MM, exclusive. */
  close: string;
  /** ISO weekdays that trade (1 = Monday ... 7 = Sunday). */
  days: readonly number[];
}

export interface KindThresholds {
  minBidQty: number;
  minAskQty: number;
  maxSpreadPct: number;
  minVolume: number;
  /** null = open interest is not applicable / not required. */
  minOpenInterest: number | null;
  /** Largest allowed distance between the decision's entry price (premium) and the last traded price, in percent. */
  maxEntryDeviationPct: number;
}

export interface MarketRiskConfig {
  sessions: Record<string, SessionDef>;
  /** Minimum time to expiry (minutes) for a NEW approval-eligible decision. */
  minMinutesToExpiry: { option: number; future: number };
  expiryDay: { block: boolean; liquidityMultiplier: number; spreadMultiplier: number };
  maxDataAgeSeconds: number;
  thresholds: Record<InstrumentKind, KindThresholds>;
  source: Record<string, "default" | "env">;
}

export const MARKET_CONFIG_VERSION = "market-config-v1";

export const DEFAULT_SESSIONS: Readonly<Record<string, SessionDef>> = {
  IN: { timezone: "Asia/Kolkata", open: "09:15", close: "15:30", days: [1, 2, 3, 4, 5] },
  US: { timezone: "America/New_York", open: "09:30", close: "16:00", days: [1, 2, 3, 4, 5] },
  JP: { timezone: "Asia/Tokyo", open: "09:00", close: "15:00", days: [1, 2, 3, 4, 5] },
};
/** Market (exchange / segment) code -> session key. An unknown market has NO session and is never approved. */
export const MARKET_SESSION_KEYS: Readonly<Record<string, string>> = {
  NSE: "IN", BSE: "IN", NFO: "IN", BFO: "IN", NSEFO: "IN", BSEFO: "IN",
  NYSE: "US", NASDAQ: "US", AMEX: "US", ARCA: "US", US: "US",
  TSE: "JP", JPX: "JP", OSE: "JP", TYO: "JP", JP: "JP",
};

export const DEFAULT_THRESHOLDS: Readonly<Record<InstrumentKind, KindThresholds>> = {
  equity: { minBidQty: 100, minAskQty: 100, maxSpreadPct: 0.5, minVolume: 10_000, minOpenInterest: null, maxEntryDeviationPct: 5 },
  future: { minBidQty: 50, minAskQty: 50, maxSpreadPct: 0.5, minVolume: 1_000, minOpenInterest: 10_000, maxEntryDeviationPct: 5 },
  option: { minBidQty: 50, minAskQty: 50, maxSpreadPct: 5, minVolume: 100, minOpenInterest: 1_000, maxEntryDeviationPct: 25 },
};

const NUM = /^[0-9]{1,12}(?:\.[0-9]{1,6})?$/;
function num(env: Record<string, string | undefined>, name: string, min: number, max: number, minExclusive = false): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!NUM.test(raw) || !(minExclusive ? v > min : v >= min) || !(v <= max)) throw new Error(`${name} must be a decimal ${minExclusive ? "greater than" : "at least"} ${min} and at most ${max}`);
  return v;
}
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `HH:MM-HH:MM@Zone` (weekdays Monday-Friday), e.g. `09:15-15:30@Asia/Kolkata`. */
export function parseSession(name: string, raw: string): SessionDef {
  const m = /^(\d\d:\d\d)-(\d\d:\d\d)@([A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2})$/.exec(raw);
  if (!m || !HHMM.test(m[1] as string) || !HHMM.test(m[2] as string) || (m[1] as string) >= (m[2] as string)) throw new Error(`${name} must look like HH:MM-HH:MM@Area/City with the open before the close`);
  try { new Intl.DateTimeFormat("en-US", { timeZone: m[3] as string }); } catch { throw new Error(`${name} names an unknown time zone`); }
  return { timezone: m[3] as string, open: m[1] as string, close: m[2] as string, days: [1, 2, 3, 4, 5] };
}

export function loadMarketRiskConfig(env: Record<string, string | undefined> = process.env): MarketRiskConfig {
  const source: MarketRiskConfig["source"] = {};
  const pick = <T>(key: string, value: T | undefined, fallback: T): T => { source[key] = value === undefined ? "default" : "env"; return value === undefined ? fallback : value; };
  const sessions: Record<string, SessionDef> = { ...DEFAULT_SESSIONS };
  for (const key of Object.keys(DEFAULT_SESSIONS)) {
    const raw = env[`TWINS_MARKET_SESSION_${key}`];
    source[`session.${key}`] = raw === undefined || raw === "" ? "default" : "env";
    if (raw !== undefined && raw !== "") sessions[key] = parseSession(`TWINS_MARKET_SESSION_${key}`, raw);
  }
  const blockRaw = env["TWINS_MARKET_EXPIRY_DAY_BLOCK"];
  if (blockRaw !== undefined && blockRaw !== "" && blockRaw !== "true" && blockRaw !== "false") throw new Error("TWINS_MARKET_EXPIRY_DAY_BLOCK must be true or false");
  const thresholds = {} as Record<InstrumentKind, KindThresholds>;
  for (const kind of INSTRUMENT_KINDS) {
    const K = kind.toUpperCase();
    const d = DEFAULT_THRESHOLDS[kind];
    const minQty = num(env, `TWINS_MARKET_MIN_QTY_${K}`, 1, 1e9);
    thresholds[kind] = {
      minBidQty: pick(`${kind}.minBidQty`, minQty, d.minBidQty), minAskQty: pick(`${kind}.minAskQty`, minQty, d.minAskQty),
      maxSpreadPct: pick(`${kind}.maxSpreadPct`, num(env, `TWINS_MARKET_MAX_SPREAD_PCT_${K}`, 0, 100, true), d.maxSpreadPct),
      minVolume: pick(`${kind}.minVolume`, num(env, `TWINS_MARKET_MIN_VOLUME_${K}`, 0, 1e12), d.minVolume),
      minOpenInterest: pick(`${kind}.minOpenInterest`, num(env, `TWINS_MARKET_MIN_OI_${K}`, 0, 1e12), d.minOpenInterest),
      maxEntryDeviationPct: pick(`${kind}.maxEntryDeviationPct`, num(env, `TWINS_MARKET_MAX_ENTRY_DEVIATION_PCT_${K}`, 0, 100, true), d.maxEntryDeviationPct),
    };
  }
  return {
    sessions,
    minMinutesToExpiry: {
      option: pick("minMinutesToExpiry.option", num(env, "TWINS_MARKET_MIN_MINUTES_TO_EXPIRY_OPTION", 0, 100_000), 30),
      future: pick("minMinutesToExpiry.future", num(env, "TWINS_MARKET_MIN_MINUTES_TO_EXPIRY_FUTURE", 0, 100_000), 30),
    },
    expiryDay: {
      block: pick("expiryDay.block", blockRaw === undefined || blockRaw === "" ? undefined : blockRaw === "true", false),
      liquidityMultiplier: pick("expiryDay.liquidityMultiplier", num(env, "TWINS_MARKET_EXPIRY_DAY_LIQUIDITY_MULT", 1, 100), 2),
      spreadMultiplier: pick("expiryDay.spreadMultiplier", num(env, "TWINS_MARKET_EXPIRY_DAY_SPREAD_MULT", 0, 1, true), 0.5),
    },
    maxDataAgeSeconds: pick("maxDataAgeSeconds", num(env, "TWINS_MARKET_MAX_DATA_AGE_SECONDS", 1, 86_400), 60),
    thresholds,
    source,
  };
}
export const DEFAULT_MARKET_CONFIG: MarketRiskConfig = loadMarketRiskConfig({});
