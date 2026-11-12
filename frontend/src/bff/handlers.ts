/**
 * BFF request handlers. Route files only forward to these, so every behaviour here is unit-tested without a running server.
 *
 * What the BFF is and is not: it holds the session token server-side (the browser never sees it), refuses cross-origin writes, throttles sign-in per source,
 * validates what crosses it, and relays only allow-listed reads. It is NOT a security boundary for private data: the backend authorises every request
 * (permission, role, ownership, RLS). A BFF check is never described, or relied on, as equivalent to backend authorization.
 */
import { ConfigError, loadConfig, type BffConfig } from "./config";
import { checkQuery, matchRoute } from "./allowlist";
import { clearSession, json, neutral, noContent } from "./respond";
import { cookieNames, csrfCookieOptions, csrfOk, isCsrfToken, newCsrfToken, parseCookies, readSession, sameOrigin, sessionCookieOptions } from "./security";
import { LoginBody, MeResponse, PublicUser, UpstreamError, UpstreamLogin, relaySchemaFor } from "./schemas";
import { clientKey, loginAttempts, loginFailures, type WindowCounter } from "./throttle";
import { callUpstream, type Fetcher } from "./upstream";
import type { NextResponse } from "next/server";

export interface Deps { cfg?: BffConfig; fetcher?: Fetcher; attempts?: WindowCounter; failures?: WindowCounter }
function config(d: Deps): BffConfig | NextResponse { if (d.cfg) return d.cfg; try { return loadConfig(); } catch (e) { if (e instanceof ConfigError) return neutral.config(); throw e; } }
const isResponse = (v: BffConfig | NextResponse): v is NextResponse => "status" in v && "headers" in v;
const MAX_BODY = 4096;

async function readJson(req: Request): Promise<unknown | undefined> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return undefined;
  const text = await req.text(); if (text.length > MAX_BODY) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** POST /api/auth/login */
export async function login(req: Request, d: Deps = {}): Promise<NextResponse> {
  const cfg = config(d); if (isResponse(cfg)) return cfg;
  if (!sameOrigin(req, cfg)) return neutral.forbidden();
  const parsed = LoginBody.safeParse(await readJson(req)); if (!parsed.success) return neutral.validation();
  const ip = clientKey(req, cfg.trustProxyHeader), email = parsed.data.email.trim().toLowerCase(), pair = `${ip}|${email}`, attempts = d.attempts ?? loginAttempts, failures = d.failures ?? loginFailures;
  if (!attempts.hit(ip) || failures.blocked(pair)) return neutral.tooMany();
  const up = await callUpstream(cfg, "/auth/login", { method: "POST", body: { email, password: parsed.data.password }, ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
  if (up.networkError) return neutral.unavailable();
  if (up.status === 401 || up.status === 403) { failures.hit(pair); return json(401, { error: "UNAUTHENTICATED", message: "sign-in failed" }); } // wrong credentials and lockout look identical to the browser
  if (up.status === 422) return neutral.validation();
  const ok = up.status === 200 ? UpstreamLogin.safeParse(up.json) : null;
  if (!ok || !ok.success) return neutral.internal();
  failures.reset(pair);
  const expires = new Date(Date.parse(ok.data.expiresAt)), n = cookieNames(cfg.cookieMode), res = json(200, { user: ok.data.user });
  res.cookies.set(n.session, ok.data.token, sessionCookieOptions(cfg, expires));
  res.cookies.set(n.csrf, newCsrfToken(), csrfCookieOptions(cfg, expires)); // rotated on every sign-in
  return res;
}

/** POST /api/auth/logout: same-origin and CSRF required; the cookies are cleared even if the backend cannot be reached. */
export async function logout(req: Request, d: Deps = {}): Promise<NextResponse> {
  const cfg = config(d); if (isResponse(cfg)) return cfg;
  if (!sameOrigin(req, cfg) || !csrfOk(req, cfg)) return neutral.forbidden();
  const token = readSession(req, cfg);
  if (token) await callUpstream(cfg, "/auth/logout", { method: "POST", token, ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
  return clearSession(noContent(), cfg);
}

/** GET /api/auth/me: the session probe. A 401 from the backend ends the session here (cookies cleared). */
export async function me(req: Request, d: Deps = {}): Promise<NextResponse> {
  const cfg = config(d); if (isResponse(cfg)) return cfg;
  const token = readSession(req, cfg); if (!token) return neutral.unauthenticated();
  const up = await callUpstream(cfg, "/auth/me", { token, ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
  if (up.networkError) return neutral.unavailable();
  if (up.status === 401) return clearSession(neutral.unauthenticated(), cfg);
  const ok = up.status === 200 ? MeResponse.safeParse(up.json) : null; if (!ok || !ok.success) return neutral.internal();
  const res = json(200, { user: ok.data.user }), n = cookieNames(cfg.cookieMode);
  if (!isCsrfToken(parseCookies(req.headers.get("cookie")).get(n.csrf))) res.cookies.set(n.csrf, newCsrfToken(), csrfCookieOptions(cfg, new Date(Date.now() + 8 * 3600_000)));
  return res;
}

/** GET /api/session/<path>: relays ONE allow-listed backend read. No other method, path, query key or query value gets through. */
export async function relay(req: Request, segments: string[], d: Deps = {}): Promise<NextResponse> {
  const cfg = config(d); if (isResponse(cfg)) return cfg;
  if (req.method !== "GET") return json(405, { error: "FORBIDDEN", message: "method not allowed" }, { headers: { allow: "GET" } });
  const url = new URL(req.url), match = matchRoute("GET", `/${segments.join("/")}`);
  if (!match) return neutral.notFound();
  const q = checkQuery(match.entry, url.searchParams); if (!q.ok) return neutral.validation();
  const token = readSession(req, cfg); if (!token) return neutral.unauthenticated();
  const up = await callUpstream(cfg, `/${segments.join("/")}${q.query}`, { token, ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
  if (up.networkError) return neutral.unavailable();
  if (up.status === 401) return clearSession(neutral.unauthenticated(), cfg);
  if (up.status === 200) { const ok = relaySchemaFor(match.entry.id).safeParse(up.json); return ok.success ? json(200, ok.data) : neutral.internal(); }
  const err = UpstreamError.safeParse(up.json);
  if (err.success && up.status >= 400 && up.status < 600) return json(up.status, err.data);
  return up.status === 503 ? neutral.unavailable() : neutral.internal();
}

/** For server components: the signed-in user, or why there is none. Never returns the token. */
export async function serverSession(cookieHeader: string | null, d: Deps = {}): Promise<{ user: PublicUser } | { error: "UNAUTHENTICATED" | "UNAVAILABLE" }> {
  let cfg: BffConfig; try { cfg = d.cfg ?? loadConfig(); } catch { return { error: "UNAVAILABLE" }; }
  const token = readSession(new Request("http://internal.invalid/", { headers: cookieHeader ? { cookie: cookieHeader } : {} }), cfg); if (!token) return { error: "UNAUTHENTICATED" };
  const up = await callUpstream(cfg, "/auth/me", { token, ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
  if (up.networkError || up.status >= 500) return { error: "UNAVAILABLE" };
  const ok = up.status === 200 ? MeResponse.safeParse(up.json) : null;
  return ok && ok.success ? { user: ok.data.user } : { error: "UNAUTHENTICATED" };
}
