export type AppEnv = "development" | "staging" | "production";
export type TradingMode = "paper" | "shadow" | "live";

export interface TwinsConfig {
  appEnv: AppEnv;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
  databaseUrl: string;
  redisUrl: string;
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function parseAppEnv(raw: string | undefined): AppEnv {
  if (raw === "development" || raw === "staging" || raw === "production") {
    return raw;
  }
  return "development";
}

function parseTradingMode(raw: string | undefined): TradingMode {
  if (raw === "paper" || raw === "shadow" || raw === "live") {
    return raw;
  }
  return "paper";
}

/**
 * LIVE_TRADING must be the literal string "true", set explicitly.
 * Any missing, malformed, or ambiguous value resolves to false.
 * This is the system's default-safe posture (spec section 40).
 */
function parseLiveTrading(raw: string | undefined): boolean {
  return raw === "true";
}

export function loadConfig(): TwinsConfig {
  const appEnv = parseAppEnv(readEnv("APP_ENV"));
  const tradingMode = parseTradingMode(readEnv("TRADING_MODE"));
  const liveTradingEnabled = parseLiveTrading(readEnv("LIVE_TRADING"));

  if (liveTradingEnabled && tradingMode !== "live") {
    throw new Error(
      "Configuration conflict: LIVE_TRADING=true requires TRADING_MODE=live.",
    );
  }

  const databaseUrl = readEnv("DATABASE_URL");
  const redisUrl = readEnv("REDIS_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!redisUrl) throw new Error("REDIS_URL is required.");

  return {
    appEnv,
    tradingMode,
    liveTradingEnabled,
    databaseUrl,
    redisUrl,
  };
}
