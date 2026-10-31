import { KiteError } from "./errors";

/** Variable NAMES only; values come from the environment of the process (an env file outside the repo) and are never logged. */
export const KITE_ENV = {
  apiKey: "TWINS_KITE_API_KEY",
  apiSecret: "TWINS_KITE_API_SECRET",
  accessToken: "TWINS_KITE_ACCESS_TOKEN", // optional: a token obtained by the documented exchange; the server still decides whether it is valid
} as const;

export interface KiteConfig { apiKey: string; apiSecret?: string; accessToken?: string }

const KEY = /^[A-Za-z0-9]{8,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function loadKiteConfig(env: Record<string, string | undefined> = process.env): KiteConfig {
  const apiKey = env[KITE_ENV.apiKey];
  if (!apiKey || !KEY.test(apiKey)) throw new KiteError("CONFIG");
  const apiSecret = env[KITE_ENV.apiSecret];
  if (apiSecret !== undefined && apiSecret !== "" && !KEY.test(apiSecret)) throw new KiteError("CONFIG");
  const accessToken = env[KITE_ENV.accessToken];
  if (accessToken !== undefined && accessToken !== "" && !TOKEN.test(accessToken)) throw new KiteError("CONFIG");
  return { apiKey, ...(apiSecret ? { apiSecret } : {}), ...(accessToken ? { accessToken } : {}) };
}

/** Presence only, for status output. */
export const describeKiteConfig = (env: Record<string, string | undefined> = process.env): Record<string, "set" | "unset"> =>
  Object.fromEntries(Object.values(KITE_ENV).map((n) => [n, env[n] ? "set" : "unset"]));
