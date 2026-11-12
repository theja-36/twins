import { ADMIN, STUB, TRADER, expect, signIn, test } from "./fixtures";

const railLinks = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "Primary" }).getByRole("link");

test.describe("TRADER and ADMIN are separated", () => {
  test("TRADER: the five workspaces, the account selector, no administration", async ({ page }) => {
    await signIn(page, TRADER); await expect(page.getByTestId("role-chip")).toHaveText("Trader");
    for (const w of ["DECIDE", "UNDERSTAND", "CONTROL", "REVIEW", "OPERATE"]) await expect(page.getByText(w, { exact: true })).toBeVisible();
    await expect(railLinks(page).filter({ hasText: "Approval Center" })).toBeVisible(); await expect(railLinks(page).filter({ hasText: "Platform overview" })).toHaveCount(0); await expect(railLinks(page).filter({ hasText: "Users & Access" })).toHaveCount(0);
    await expect(page.getByTestId("account-single")).toContainText("Paper account");
  });
  test("TRADER reaches a screen and sees an honest placeholder with UNAVAILABLE where the backend has no capability", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/paper");
    await expect(page.getByRole("heading", { name: "Paper Trading", level: 1 })).toBeVisible(); await expect(page.getByText("This screen is built in Stage 09.3")).toBeVisible();
    await expect(page.getByText("There is no browser route to request execution")).toBeVisible(); await expect(page.getByText("NOT AVAILABLE").first()).toBeVisible();
  });
  test("TRADER opening an ADMIN page is told it is not available (no data, no redirect loop)", async ({ page }) => {
    await signIn(page, TRADER);
    for (const p of ["/admin/system", "/admin/users"]) { await page.goto(p); await expect(page.getByRole("heading", { name: "Not available to you" })).toBeVisible(); await expect(page).toHaveURL(new RegExp(`${p}$`)); }
  });
  test("ADMIN: lands on Platform overview, sees only shared intelligence, administration and the account", async ({ page }) => {
    await signIn(page, ADMIN); await expect(page).toHaveURL(/\/admin\/system$/); await expect(page.getByTestId("role-chip")).toHaveText("Administrator"); await expect(page.getByText("Administration console")).toBeVisible();
    const names = (await railLinks(page).allTextContents()).map((t) => t.trim()).sort(); expect(names).toEqual(["Account", "Market Intelligence", "Opportunities", "Platform overview", "Research", "Users & Access"]);
    await expect(page.getByTestId("account-single")).toHaveCount(0);
  });
  test("ADMIN is never shown a private screen: the Overview redirects, every private URL says 'Not available to administrators'", async ({ page }) => {
    await signIn(page, ADMIN); await page.goto("/"); await expect(page).toHaveURL(/\/admin\/system$/);
    for (const p of ["/approvals", "/paper", "/portfolio", "/capital-risk", "/insights", "/decisions", "/performance"]) { await page.goto(p); await expect(page.getByRole("heading", { name: "Not available to administrators" }), p).toBeVisible(); }
  });
  test("ADMIN reaching the private API through the relay gets the backend's 404 (the BFF is not the authority)", async ({ page }) => {
    await signIn(page, ADMIN); const r = await page.request.get("/api/session/accounts"); expect(r.status()).toBe(404); expect((await r.json()).error).toBe("NOT_FOUND");
    const t = await page.request.get("/api/session/opportunities/candidates"); expect(t.status()).toBe(200); // shared intelligence is allowed for an administrator
  });
  test("the relay is not a proxy: platform routes, writes, unknown paths and bad queries are refused; the backend never sees a cookie or key", async ({ page, request }) => {
    await request.get(`${STUB}/__reset`); await signIn(page, TRADER);
    for (const p of ["/api/session/health", "/api/session/system/config", "/api/session/intelligence/source", "/api/session/paper/state", "/api/session/accounts/.."]) expect((await page.request.get(p)).status(), p).toBe(404);
    expect((await page.request.get("/api/session/portfolio")).status()).toBe(422);
    const post = await page.request.post("/api/session/accounts", { headers: { origin: "http://127.0.0.1:3100" }, data: {} }); expect(post.status()).toBe(405);
    expect((await page.request.get("/api/session/accounts")).status()).toBe(200);
    const log = (await (await request.get(`${STUB}/__log`)).json()).log as Array<{ path: string; hasCookie: boolean; hasApiKey: boolean; headers: string[] }>;
    expect(log.some((l) => l.path === "/accounts")).toBe(true); expect(log.every((l) => !l.hasCookie && !l.hasApiKey)).toBe(true);
    for (const l of log) expect(l.headers.every((h) => ["accept", "authorization", "content-type", "content-length", "host", "connection", "accept-language", "accept-encoding", "user-agent", "sec-fetch-mode", "cache-control", "pragma"].includes(h))).toBe(true);
    expect(log.some((l) => ["/health", "/system/config", "/intelligence/source", "/paper/state"].includes(l.path))).toBe(false);
  });
  test("state-changing requests fail closed: no Origin, wrong Origin and a missing CSRF token are all refused", async ({ page, request }) => {
    await signIn(page, TRADER);
    expect((await request.post("/api/auth/login", { data: { email: TRADER.email, password: TRADER.password } })).status()).toBe(403); // no Origin
    expect((await page.request.post("/api/auth/login", { headers: { origin: "https://evil.example" }, data: { email: TRADER.email, password: TRADER.password } })).status()).toBe(403);
    expect((await page.request.post("/api/auth/logout", { headers: { origin: "http://127.0.0.1:3100" }, data: {} })).status()).toBe(403); // right origin, no CSRF header
    expect((await page.request.get("/api/auth/me")).status()).toBe(200); // the session survived every refused attempt
  });
});
