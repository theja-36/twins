import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../packages/config/src/index";

const REQUIRED = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/twins_test",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig safety defaults", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...REQUIRED };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("defaults to paper trading mode and live trading disabled", () => {
    const config = loadConfig();
    expect(config.tradingMode).toBe("paper");
    expect(config.liveTradingEnabled).toBe(false);
  });

  it("treats any non-'true' LIVE_TRADING value as false", () => {
    for (const value of ["1", "yes", "TRUE", "", "maybe"]) {
      process.env.LIVE_TRADING = value;
      expect(loadConfig().liveTradingEnabled).toBe(false);
    }
  });

  it("rejects LIVE_TRADING=true unless TRADING_MODE=live", () => {
    process.env.LIVE_TRADING = "true";
    process.env.TRADING_MODE = "paper";
    expect(() => loadConfig()).toThrow(/Configuration conflict/);
  });

  it("allows LIVE_TRADING=true only when TRADING_MODE=live", () => {
    process.env.LIVE_TRADING = "true";
    process.env.TRADING_MODE = "live";
    const config = loadConfig();
    expect(config.liveTradingEnabled).toBe(true);
    expect(config.tradingMode).toBe("live");
  });

  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("throws when REDIS_URL is missing", () => {
    delete process.env.REDIS_URL;
    expect(() => loadConfig()).toThrow(/REDIS_URL/);
  });

  it("falls back to development/paper for unrecognized values", () => {
    process.env.APP_ENV = "not-a-real-env";
    process.env.TRADING_MODE = "yolo";
    const config = loadConfig();
    expect(config.appEnv).toBe("development");
    expect(config.tradingMode).toBe("paper");
  });
});
