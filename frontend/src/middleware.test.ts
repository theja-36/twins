import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

const env = process.env as Record<string, string | undefined>;
const set = (m: string | undefined) => { if (m === undefined) delete env["TWINS_COOKIE_MODE"]; else env["TWINS_COOKIE_MODE"] = m; };
afterEach(() => set("dev"));
const call = (path: string, cookie?: string) => middleware(new NextRequest(`https://desk.example.test${path}`, cookie ? { headers: { cookie } } : {}));

describe("middleware", () => {
  it("every response carries a nonce CSP; the nonce differs per request", () => {
    const a = call("/login").headers.get("content-security-policy") ?? "", b = call("/login").headers.get("content-security-policy") ?? "";
    expect(a).toMatch(/nonce-/); expect(a).not.toBe(b);
  });
  it("without a session cookie, pages redirect to sign-in; /login and /api pass through", () => {
    set("dev");
    for (const p of ["/", "/approvals", "/account", "/admin/system", "/design-system"]) { const r = call(p); expect(r.status, p).toBe(307); expect(new URL(r.headers.get("location")!).pathname).toBe("/login"); expect(r.headers.get("content-security-policy")).toBeTruthy(); }
    expect(call("/login").status).toBe(200); expect(call("/api/auth/me").status).toBe(200);
  });
  it("with a session cookie (any value: presence only, the layout verifies it with the backend) pages pass", () => { set("dev"); expect(call("/approvals", "twins_session=x").status).toBe(200); });
  it("host mode expects the __Host- cookie name and sends HSTS; dev mode never sends HSTS", () => {
    set("host"); expect(call("/approvals", "twins_session=x").status).toBe(307); expect(call("/approvals", "__Host-twins_session=x").status).toBe(200); expect(call("/login").headers.get("strict-transport-security")).toContain("max-age=");
    set("dev"); expect(call("/login").headers.get("strict-transport-security")).toBeNull();
  });
});
