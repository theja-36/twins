/**
 * Request-security primitives of the BFF. All of them FAIL CLOSED: anything missing, malformed or ambiguous is a refusal.
 * Pure functions over Request/strings so they are unit-tested without a server.
 */
import type { BffConfig, CookieMode } from "./config";

/** Opaque session token issued by the backend: `tws_` + 43 base64url characters (packages/auth/src/tokens.ts). */
export const SESSION_TOKEN = /^tws_[A-Za-z0-9_-]{43}$/;
/** Our own CSRF token: 32 random bytes, base64url (43 characters). */
export const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const isSessionToken = (v: unknown): v is string => typeof v === "string" && SESSION_TOKEN.test(v);
export const isCsrfToken = (v: unknown): v is string => typeof v === "string" && CSRF_TOKEN.test(v);

export function newCsrfToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Constant-time string comparison (length is not secret here: both sides are fixed-format tokens). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const cookieNames = (mode: CookieMode): { session: string; csrf: string } => mode === "host" ? { session: "__Host-twins_session", csrf: "__Host-twins_csrf" } : { session: "twins_session", csrf: "twins_csrf" };
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>(); if (!header || header.length > 8192) return out;
  for (const part of header.split(";")) { const i = part.indexOf("="); if (i < 1) continue; const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if (!out.has(k)) out.set(k, v); }
  return out;
}
export function readSession(req: Request, cfg: BffConfig): string | null {
  const v = parseCookies(req.headers.get("cookie")).get(cookieNames(cfg.cookieMode).session);
  return isSessionToken(v) ? v : null;
}

/**
 * Fail-closed same-origin check for state-changing requests. The browser ALWAYS sends `Origin` on a cross-origin or POST request, so a missing Origin is a refusal
 * (not a pass), a `Sec-Fetch-Site` other than same-origin is a refusal, and the Origin must equal the public origin exactly.
 */
export function sameOrigin(req: Request, cfg: BffConfig): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  // Host mode always has a configured public origin. Without one (dev mode only) the origin is rebuilt from the Host header the browser used:
  // the framework's request URL can report a different host name (localhost for 127.0.0.1), which would wrongly refuse same-origin requests.
  const u = new URL(req.url), host = req.headers.get("host"), expected = cfg.publicOrigin ?? (host ? `${u.protocol}//${host}` : u.origin);
  return origin === expected;
}
/** Double-submit CSRF: the header must equal the readable CSRF cookie, and both must have the exact format. */
export function csrfOk(req: Request, cfg: BffConfig): boolean {
  const cookie = parseCookies(req.headers.get("cookie")).get(cookieNames(cfg.cookieMode).csrf), header = req.headers.get("x-csrf-token");
  return isCsrfToken(cookie) && isCsrfToken(header) && safeEqual(cookie, header);
}

export interface CookieOptions { httpOnly: boolean; secure: boolean; sameSite: "strict"; path: "/"; expires?: Date; maxAge?: number }
/** HttpOnly, SameSite=Strict, Path=/ and (host mode) Secure with no Domain: exactly what the `__Host-` prefix requires. */
export const sessionCookieOptions = (cfg: BffConfig, expires: Date): CookieOptions => ({ httpOnly: true, secure: cfg.cookieMode === "host", sameSite: "strict", path: "/", expires });
/** The CSRF cookie must be readable by the page script (double submit), so it is NOT HttpOnly; it carries no secret of the backend. */
export const csrfCookieOptions = (cfg: BffConfig, expires: Date): CookieOptions => ({ httpOnly: false, secure: cfg.cookieMode === "host", sameSite: "strict", path: "/", expires });
export const clearOptions = (cfg: BffConfig): CookieOptions => ({ httpOnly: true, secure: cfg.cookieMode === "host", sameSite: "strict", path: "/", expires: new Date(0), maxAge: 0 });
