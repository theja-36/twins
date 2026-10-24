import { inspect } from "node:util";

/**
 * Configuration of the approval bot. Everything comes from environment variables (a host-side env file used only by this service);
 * nothing is hardcoded and no value is ever echoed in an error message (the message names the variable and the rule).
 */
export class BotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotConfigError";
  }
}

export const DEFAULT_API_BASE = "https://api.telegram.org";
const TOKEN = /^[0-9]{6,12}:[A-Za-z0-9_-]{30,60}$/;
const APPROVER_ID = /^[1-9][0-9]{4,15}$/;
const CHANNEL_IDENTIFIER = /^tg_chat_-100[0-9]{9,13}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/;

export class BotConfig {
  constructor(
    readonly token: string,
    readonly approverId: number,
    readonly databaseUrl: string,
    readonly hmacKey: Buffer,
    readonly sourceChannels: readonly string[],
    readonly channelLabel: string,
    readonly cardTtlSeconds: number,
    readonly pollIntervalSeconds: number,
    readonly maxPerHour: number,
    readonly maxPerDay: number,
    readonly maxPerCycle: number,
    readonly apiBase: string,
    readonly active: boolean,
  ) {}
  toJSON(): string {
    return "<BotConfig redacted>";
  }
  [inspect.custom](): string {
    return "<BotConfig redacted>";
  }
}

function intIn(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new BotConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new BotConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function need(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new BotConfigError(`${name} is not set`);
  return value;
}

/** A database host must be internal: a bare service/container name, localhost or a private/loopback address - never a public DNS name. */
function internalHost(host: string): boolean {
  if (host === "localhost" || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return true; // bare name (no dots)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function loadBotConfig(env: Record<string, string | undefined>): BotConfig {
  const token = need(env, "TWINS_BOT_TOKEN");
  if (!TOKEN.test(token)) throw new BotConfigError("TWINS_BOT_TOKEN has an unexpected format");
  const approver = need(env, "TWINS_BOT_APPROVER_ID");
  if (!APPROVER_ID.test(approver)) throw new BotConfigError("TWINS_BOT_APPROVER_ID must be a positive numeric Telegram user id");

  const dbRaw = need(env, "TWINS_BOT_DATABASE_URL");
  let url: URL;
  try {
    url = new URL(dbRaw);
  } catch {
    throw new BotConfigError("TWINS_BOT_DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new BotConfigError("TWINS_BOT_DATABASE_URL must be a postgres URL");
  if (decodeURIComponent(url.username) !== "twins_bot") throw new BotConfigError("TWINS_BOT_DATABASE_URL must use the restricted role twins_bot");
  if (url.password === "") throw new BotConfigError("TWINS_BOT_DATABASE_URL has no password");
  if (!internalHost(url.hostname)) throw new BotConfigError("TWINS_BOT_DATABASE_URL must point to an internal host");

  const key = need(env, "TWINS_BOT_HMAC_KEY");
  if (!HEX64.test(key)) throw new BotConfigError("TWINS_BOT_HMAC_KEY must be 64 hex characters");

  const channels = need(env, "TWINS_BOT_SOURCE_CHANNELS").split(",").map((s) => s.trim());
  if (channels.length < 1 || channels.length > 3 || new Set(channels).size !== channels.length || !channels.every((c) => CHANNEL_IDENTIFIER.test(c))) {
    throw new BotConfigError("TWINS_BOT_SOURCE_CHANNELS must list 1-3 distinct channel identifiers (tg_chat_-100...)");
  }
  const label = env["TWINS_BOT_CHANNEL_LABEL"] ?? "signal channel";
  if (!LABEL.test(label)) throw new BotConfigError("TWINS_BOT_CHANNEL_LABEL has an unexpected format");

  // The API base can only be moved to a loopback address (tests); in production it is always api.telegram.org.
  let apiBase = DEFAULT_API_BASE;
  const override = env["TWINS_BOT_TEST_API_BASE"];
  if (override !== undefined && override !== "") {
    let u: URL;
    try {
      u = new URL(override);
    } catch {
      throw new BotConfigError("TWINS_BOT_TEST_API_BASE is not a valid URL");
    }
    if (!(u.hostname === "127.0.0.1" || u.hostname === "localhost") || u.protocol !== "http:") throw new BotConfigError("TWINS_BOT_TEST_API_BASE must be a loopback http URL");
    apiBase = u.origin;
  }

  return new BotConfig(
    token,
    Number(approver),
    dbRaw,
    Buffer.from(key, "hex"),
    channels,
    label,
    intIn(env, "TWINS_BOT_CARD_TTL_SECONDS", 4 * 3600, 300, 86400),
    intIn(env, "TWINS_BOT_POLL_INTERVAL_SECONDS", 30, 5, 300),
    intIn(env, "TWINS_BOT_MAX_PER_HOUR", 20, 1, 100),
    intIn(env, "TWINS_BOT_MAX_PER_DAY", 100, 1, 500),
    intIn(env, "TWINS_BOT_MAX_PER_CYCLE", 5, 1, 20),
    apiBase,
    env["TWINS_BOT_ACTIVE"] === "true",
  );
}
