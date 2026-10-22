/**
 * Explicit integration-test target configuration. There is NO default database or Redis: the
 * integration suite runs only in one of two named contexts, each with exact target rules, and
 * refuses to start otherwise (see globalSetup.ts). Development configuration is not consulted.
 *
 *  - rehearsal (TWINS_REHEARSAL=1): loopback 127.0.0.1:15432, user `twins`, an EXACT database from
 *    rehearsalTargets.ts, Redis 127.0.0.1:16379.
 *  - ci (TWINS_CI=1): loopback, database `twins_ci`, user `twins_ci`, loopback Redis.
 *  Both: LIVE_TRADING=false. Setting both contexts, or neither, is an error.
 *
 * Diagnostics name the failed rule only; they never print the connection string, user or password.
 */
import { isApprovedRehearsalDatabase } from "./runtime/rehearsalTargets";

export type TestContext = "rehearsal" | "ci";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class TestTargetError extends Error {
  constructor(message: string) {
    super(`integration test target refused: ${message}`);
    this.name = "TestTargetError";
  }
}

function parseUrl(value: string | undefined, name: string, protocols: string[]): URL {
  if (!value) throw new TestTargetError(`${name} is not set (there is no default target; set it explicitly)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestTargetError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new TestTargetError(`${name} has an unexpected scheme`);
  return url;
}

/** Validates the environment and returns the context. Pure: reads only `env`, connects to nothing. */
export function resolveTestTarget(env: NodeJS.ProcessEnv): { context: TestContext; database: string } {
  const rehearsal = env.TWINS_REHEARSAL === "1";
  const ci = env.TWINS_CI === "1";
  if (rehearsal && ci) throw new TestTargetError("both TWINS_REHEARSAL=1 and TWINS_CI=1 are set; choose exactly one context");
  if (!rehearsal && !ci) throw new TestTargetError("no context: set TWINS_REHEARSAL=1 (approved rehearsal database) or TWINS_CI=1 (CI database)");
  const context: TestContext = rehearsal ? "rehearsal" : "ci";

  if (env.LIVE_TRADING !== "false") throw new TestTargetError("LIVE_TRADING must be exactly 'false'");
  if (env.TRADING_MODE === "live") throw new TestTargetError("TRADING_MODE must not be 'live'");

  const db = parseUrl(env.DATABASE_URL, "DATABASE_URL", ["postgresql:", "postgres:"]);
  const redis = parseUrl(env.REDIS_URL, "REDIS_URL", ["redis:"]);
  const database = db.pathname.replace(/^\//, "");
  const user = decodeURIComponent(db.username);

  if (context === "rehearsal") {
    if (`${db.hostname}:${db.port}` !== "127.0.0.1:15432") throw new TestTargetError("rehearsal DATABASE_URL must be 127.0.0.1:15432");
    if (user !== "twins") throw new TestTargetError("rehearsal DATABASE_URL user is not the expected rehearsal user");
    if (!isApprovedRehearsalDatabase(db.pathname)) throw new TestTargetError("rehearsal DATABASE_URL database is not on the exact approved list");
    if (`${redis.hostname}:${redis.port}` !== "127.0.0.1:16379") throw new TestTargetError("rehearsal REDIS_URL must be 127.0.0.1:16379");
  } else {
    if (!LOOPBACK.has(db.hostname)) throw new TestTargetError("CI DATABASE_URL host must be loopback");
    if (database !== "twins_ci") throw new TestTargetError("CI DATABASE_URL database must be exactly twins_ci");
    if (user !== "twins_ci") throw new TestTargetError("CI DATABASE_URL user must be exactly twins_ci");
    if (!LOOPBACK.has(redis.hostname)) throw new TestTargetError("CI REDIS_URL host must be loopback");
  }
  return { context, database };
}

/** For test files: the validated URL. Throws instead of falling back when unset (globalSetup normally stops the run first). */
export function requireTestDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new TestTargetError("DATABASE_URL is not set (there is no default target)");
  return value;
}

export function requireTestRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) throw new TestTargetError("REDIS_URL is not set (there is no default target)");
  return value;
}
