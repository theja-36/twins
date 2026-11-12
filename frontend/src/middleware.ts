/**
 * Edge middleware: (1) a Content-Security-Policy with a fresh nonce on every response, (2) a cheap "is there a session cookie" gate for pages.
 * (2) is a convenience redirect ONLY. It never decides authorization: the server layout verifies the session with the backend, and the backend authorises every request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/bff/csp";
import { cookieNames } from "@/bff/security";

export function middleware(req: NextRequest): NextResponse {
  const hostMode = (process.env["TWINS_COOKIE_MODE"] ?? "host") === "host";
  const nonce = newNonce(), csp = buildCsp(nonce, { dev: process.env["NODE_ENV"] !== "production", hostMode });
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/"), isLogin = pathname === "/login";
  if (!isApi && !isLogin && !req.cookies.get(cookieNames(hostMode ? "host" : "dev").session)) {
    const to = req.nextUrl.clone(); to.pathname = "/login"; to.search = "";
    return harden(NextResponse.redirect(to), csp, hostMode);
  }
  const headers = new Headers(req.headers); headers.set("x-nonce", nonce); headers.set("content-security-policy", csp);
  return harden(NextResponse.next({ request: { headers } }), csp, hostMode);
}
/** CSP on every response; HSTS only in host mode (HTTPS deployment), so a plain-http development run never pins HTTPS. Read at request time, never baked into the build. */
function harden(res: NextResponse, csp: string, hostMode: boolean): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  if (hostMode) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return res;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
