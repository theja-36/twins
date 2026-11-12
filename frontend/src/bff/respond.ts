/** Response helpers: JSON bodies are fixed-shape, never contain a token, and are never cached. */
import { NextResponse } from "next/server";
import type { BffConfig } from "./config";
import { clearOptions, cookieNames } from "./security";

const NO_STORE = { "cache-control": "no-store, max-age=0", pragma: "no-cache" };
export function json(status: number, body: unknown, init: { headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}
export function noContent(): NextResponse { return new NextResponse(null, { status: 204, headers: NO_STORE }); }
export function clearSession(res: NextResponse, cfg: BffConfig): NextResponse {
  const n = cookieNames(cfg.cookieMode);
  res.cookies.set(n.session, "", clearOptions(cfg)); res.cookies.set(n.csrf, "", { ...clearOptions(cfg), httpOnly: false });
  return res;
}
/** Neutral errors the browser may see: `{ error, message }`, never an upstream detail. */
export const neutral = {
  unauthenticated: () => json(401, { error: "UNAUTHENTICATED", message: "authentication required" }),
  forbidden: () => json(403, { error: "FORBIDDEN", message: "request refused" }),
  notFound: () => json(404, { error: "NOT_FOUND", message: "not found" }),
  validation: () => json(422, { error: "VALIDATION", message: "invalid request" }),
  tooMany: () => json(429, { error: "FORBIDDEN", message: "too many attempts, try again later" }),
  unavailable: () => json(503, { error: "DEPENDENCY_UNAVAILABLE", message: "service temporarily unavailable" }),
  internal: () => json(502, { error: "INTERNAL", message: "unexpected response" }),
  config: () => json(500, { error: "INTERNAL", message: "server configuration error" }),
};
