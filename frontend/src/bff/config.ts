/**
 * BFF configuration, read from the SERVER environment on every call (so tests can change it). Nothing here is ever sent to the browser,
 * and no NEXT_PUBLIC_ variable carries a secret or the API address.
 */
export type CookieMode = "host" | "dev";
export interface BffConfig {
  /** The TWINS API on the private network. The browser never calls it. */
  apiBase: string;
  cookieMode: CookieMode;
  /** The public origin as the browser sees it; the same-origin check compares against it. */
  publicOrigin: string | null;
  /** Header set by the TRUSTED reverse proxy with the client address; null = one shared throttle bucket. */
  trustProxyHeader: string | null;
  gallery: boolean;
}
export class ConfigError extends Error { constructor(m: string) { super(m); this.name = "ConfigError"; } }

export function loadConfig(env: Record<string, string | undefined> = process.env): BffConfig {
  const apiBase = (env["TWINS_API_BASE_URL"] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(apiBase)) throw new ConfigError("TWINS_API_BASE_URL must be an origin such as http://127.0.0.1:3000 (no path)");
  const raw = env["TWINS_COOKIE_MODE"] ?? "host";
  if (raw !== "host" && raw !== "dev") throw new ConfigError("TWINS_COOKIE_MODE must be host or dev");
  // Fail safe: the insecure cookie mode is refused in a production build unless it is explicitly allowed (the e2e run does; no deployment may).
  if (raw === "dev" && env["NODE_ENV"] === "production" && env["TWINS_ALLOW_INSECURE_COOKIES"] !== "true") throw new ConfigError("TWINS_COOKIE_MODE=dev is not allowed in a production build");
  const publicOrigin = env["TWINS_PUBLIC_ORIGIN"] ? env["TWINS_PUBLIC_ORIGIN"].replace(/\/+$/, "") : null;
  if (raw === "host" && publicOrigin === null) throw new ConfigError("TWINS_PUBLIC_ORIGIN is required in host mode");
  if (publicOrigin !== null && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(publicOrigin)) throw new ConfigError("TWINS_PUBLIC_ORIGIN must be an origin");
  if (raw === "host" && publicOrigin !== null && !publicOrigin.startsWith("https://")) throw new ConfigError("host mode requires an https public origin");
  const trust = env["TWINS_TRUST_PROXY_HEADER"]?.toLowerCase() ?? null;
  if (trust !== null && !/^[a-z0-9-]{1,64}$/.test(trust)) throw new ConfigError("TWINS_TRUST_PROXY_HEADER must be a header name");
  return { apiBase, cookieMode: raw, publicOrigin, trustProxyHeader: trust, gallery: env["TWINS_ENABLE_DESIGN_GALLERY"] === "true" };
}
