import { TRADER, expect, signIn, test } from "./fixtures";

test.describe("security headers and CSP", () => {
  test("pages carry a nonce-based CSP, frame and sniffing protection; the API is never cached", async ({ page }) => {
    const res = await page.goto("/login"); const h = res!.headers(), csp = h["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/); expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/); for (const d of ["frame-ancestors 'none'", "connect-src 'self'", "form-action 'self'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(d);
    expect(h["x-frame-options"]).toBe("DENY"); expect(h["x-content-type-options"]).toBe("nosniff"); expect(h["referrer-policy"]).toBe("same-origin"); expect(h["x-powered-by"]).toBeUndefined(); expect(h["permissions-policy"]).toContain("camera=()");
    const api = await page.request.get("/api/auth/me"); expect(api.headers()["cache-control"]).toContain("no-store");
    const nonces = new Set<string>(); for (let i = 0; i < 3; i++) nonces.add(((await (await page.request.get("/login")).headers())["content-security-policy"] ?? "").match(/nonce-([^']+)/)?.[1] ?? ""); expect(nonces.size).toBe(3);
  });
  test("no CSP violation on sign-in, the signed-in shell, the account page or the design gallery (scripts, styles and fonts all load under the policy)", async ({ page }) => {
    const bad: string[] = []; page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(m.text()); });
    await page.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => console.error(`Refused to: ${e.violatedDirective} ${e.blockedURI}`)); });
    await page.goto("/login"); await signIn(page, TRADER); for (const p of ["/", "/account", "/design-system", "/paper"]) { await page.goto(p); await page.waitForLoadState("networkidle"); }
    expect(bad).toEqual([]);
  });
  test("the page loads nothing from another origin", async ({ page }) => {
    const origins = new Set<string>(); page.on("request", (r) => origins.add(new URL(r.url()).origin)); await signIn(page, TRADER); await page.goto("/design-system"); await page.waitForLoadState("networkidle");
    expect([...origins]).toEqual(["http://127.0.0.1:3100"]);
  });
  test("the design gallery is on only when explicitly enabled (it is, for this run)", async ({ page }) => { await signIn(page, TRADER); const r = await page.goto("/design-system"); expect(r?.status()).toBe(200); await expect(page.getByRole("heading", { name: "Components and states" })).toBeVisible(); });
});
