import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "./csp";

describe("Content-Security-Policy", () => {
  const prod = buildCsp("abc123", { dev: false, hostMode: true });
  it("scripts run only from this origin or with the per-request nonce; no inline or eval in production", () => {
    const script = prod.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    expect(script).toContain("'nonce-abc123'"); expect(script).not.toContain("'unsafe-inline'"); expect(script).not.toContain("'unsafe-eval'");
  });
  it("styles need the nonce (style attributes are the only inline allowance)", () => { expect(prod).toContain("style-src 'self' 'nonce-abc123'"); expect(prod).toContain("style-src-attr 'unsafe-inline'"); });
  it("the browser can talk only to this origin (never the API), cannot be framed, and forms post only here", () => {
    for (const d of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "object-src 'none'", "font-src 'self'"]) expect(prod).toContain(d);
    expect(prod).not.toMatch(/https?:\/\//);
  });
  it("host mode upgrades insecure requests; dev mode allows eval for the dev server only", () => {
    expect(prod).toContain("upgrade-insecure-requests"); expect(buildCsp("n", { dev: true, hostMode: false })).not.toContain("upgrade-insecure-requests"); expect(buildCsp("n", { dev: true, hostMode: false })).toContain("'unsafe-eval'");
  });
  it("nonces are fresh and base64", () => { const a = newNonce(), b = newNonce(); expect(a).not.toBe(b); expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/); });
});
