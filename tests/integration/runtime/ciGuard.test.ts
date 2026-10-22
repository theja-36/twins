/**
 * CI target guard. Active only with TWINS_CI=1 (set by .github/workflows/ci.yml); skipped
 * everywhere else. Independent of the rehearsal guard (envGuard.test.ts), whose stricter
 * host/database rules are unchanged. Nothing here connects to any service.
 *
 * Contract: CI runs against throwaway or dedicated test service containers on loopback, in the database
 * `twins_ci` with user `twins_ci`, with LIVE_TRADING=false. Anything else fails loudly,
 * so an accidental dev/staging/production URL can never be used by the CI integration suite.
 */
import { describe, expect, it } from "vitest";

const ci = process.env.TWINS_CI === "1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

describe.skipIf(!ci)("CI environment guard", () => {
  it("DATABASE_URL targets the loopback twins_ci database as user twins_ci", () => {
    const url = new URL(process.env.DATABASE_URL ?? "postgresql://missing");
    expect(LOOPBACK.has(url.hostname)).toBe(true);
    expect(url.pathname).toBe("/twins_ci");
    expect(decodeURIComponent(url.username)).toBe("twins_ci");
  });
  it("REDIS_URL targets loopback and is set explicitly", () => {
    const url = new URL(process.env.REDIS_URL ?? "redis://missing");
    expect(LOOPBACK.has(url.hostname)).toBe(true);
  });
  it("is not pointed at the dev or rehearsal databases", () => {
    // Protection is by database name + user (not port), so a local CI-style run may use the
    // existing loopback test containers while twins_dev / twins_rehearsal_* stay unreachable.
    expect(process.env.DATABASE_URL ?? "").not.toMatch(/twins_dev|twins_rehearsal/);
  });
  it("LIVE_TRADING is false and no live trading mode is configured", () => {
    expect(process.env.LIVE_TRADING).toBe("false");
    expect(process.env.TRADING_MODE).not.toBe("live");
  });
});
