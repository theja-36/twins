import { ADMIN, TRADER, expect, signIn, test } from "./fixtures";

const who = (name: string) => ({ email: `${name}@example.test`, password: `${name}-pass-123` });
const track = (page: import("@playwright/test").Page): string[] => { const seen: string[] = []; page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/session/")) seen.push(u.pathname.replace("/api/session", "") + u.search); }); return seen; };
const WRITE = /approve|reject|cancel|watch|unwatch|execute|activate|deactivate|retire|create|edit|enable|disable|submit|exit position|move stop/i;

test.describe("Portfolio", () => {
  test("shows the REAL facts as sent: realised result, '0' allocated notional, capital NOT PROVIDED (never zero), the backend note and what is unavailable", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: "Portfolio", level: 1 })).toBeVisible(); const facts = page.locator("section[aria-labelledby=pf-h]");
    await expect(facts).toContainText("6,746.40"); await expect(facts.getByText("not provided").first()).toBeVisible(); await expect(facts).toContainText("no live portfolio source is connected"); await expect(facts).toContainText("no capital profile is in force");
    const na = page.locator("section[aria-labelledby=na-h]"); for (const t of ["Unrealised result", "Mark price", "Live balance"]) await expect(na).toContainText(t);
    await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/portfolio"))).toEqual(["/portfolio?accountId=33333333-3333-4333-8333-333333333333"]); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
    await expect(page.getByText("PAPER", { exact: true }).first()).toBeVisible();
  });
  test("capital figures appear as strings when a profile is in force", async ({ page }) => {
    await signIn(page, who("capital")); await page.goto("/portfolio"); const facts = page.locator("section[aria-labelledby=pf-h]"); await expect(facts).toContainText("15,00,000.50"); await expect(facts).toContainText("20,00,000"); await expect(facts).not.toContainText("no capital profile is in force");
  });
  test("an account with nothing recorded shows the backend's own '0' and unavailable capital; an error has a working Try again", async ({ page }) => {
    await signIn(page, who("empty")); await page.goto("/portfolio"); const facts = page.locator("section[aria-labelledby=pf-h]"); await expect(facts.getByText("not provided").first()).toBeVisible(); await expect(facts.getByText("0", { exact: true }).first()).toBeVisible();
    await page.context().clearCookies(); await signIn(page, who("broken")); await page.goto("/portfolio"); await expect(page.getByText(/portfolio facts could not be loaded/)).toBeVisible(); await page.getByRole("button", { name: "Try again" }).click(); await expect(page.locator("section[aria-labelledby=pf-h]")).toContainText("Open positions");
  });
  test("an ADMIN is blocked by the gate and no portfolio request reaches the backend", async ({ page }) => {
    await signIn(page, ADMIN); const seen = track(page); await page.goto("/portfolio"); await expect(page.getByRole("heading", { name: "Not available to administrators" })).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/portfolio"))).toEqual([]);
  });
});

test.describe("Paper Trading", () => {
  test("positions and simulated orders from real engine output: exact strings and scale, the latest-200 and account-filter limits stated, nothing private shown", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/paper"); await expect(page.getByRole("heading", { name: "Paper trading", level: 1 })).toBeVisible();
    const pt = page.getByRole("table", { name: "Positions" }), ot = page.getByRole("table", { name: "Simulated orders" }); await expect(pt.locator("tbody tr")).toHaveCount(3); await expect(ot.locator("tbody tr")).toHaveCount(4);
    await expect(ot).toContainText("4,500.00000000"); await expect(ot).toContainText("100.0500000000000000"); await expect(pt).toContainText("104 · 108 · 112"); await expect(pt).toContainText("INDCO2");
    await expect(page.getByText(/up to 200/).first()).toBeVisible(); await expect(page.getByText(/cannot filter by account/).first()).toBeVisible();
    const html = await page.locator("main").innerHTML(); expect(html).not.toMatch(/sebiPct|brokerage|feeVersion|stampDuty|must never reach the browser|userId/);
    await page.waitForLoadState("networkidle"); const reads = seen.filter((s) => s.startsWith("/execution")); expect(reads).toEqual(["/execution/positions?limit=200", "/execution/orders?limit=200"]); expect(seen.join()).not.toMatch(/offset|accountId=/);
    await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0); await expect(page.getByText(/no browser route to request a paper execution/)).toBeVisible();
  });
  test("fills and events load only on request, for one row, and events show kind and time only", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/paper"); await expect(page.getByRole("table", { name: "Simulated orders" })).toBeVisible(); expect(seen.some((s) => /fills|events/.test(s))).toBe(false);
    await page.getByRole("button", { name: /Show fills for TE[0-9A-F]{7} entry/ }).click(); const fills = page.getByRole("table", { name: "Fills" }); await expect(fills).toContainText("100.05000000"); await expect(fills).toContainText("FIXTURE"); expect(seen.filter((s) => /fills/.test(s))).toHaveLength(1);
    await page.getByRole("row", { name: /TE[0-9A-F]{7} .*CLOSED/ }).getByRole("button", { name: /Show events/ }).click(); const ev = page.getByRole("table", { name: "Position events" }); await expect(ev.locator("tbody tr")).toHaveCount(10); await expect(ev).toContainText("STOP HIT"); await expect(ev).not.toContainText(/realizedPnl|openQuantity|9220/);
    await page.getByRole("button", { name: "Close" }).first().click(); await expect(page.getByRole("table", { name: /Fills|Position events/ })).toHaveCount(0);
  });
  test("the status filters are the API's own parameters, and an OPEN position's null fields read 'not closed' and 'none', never zero", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/paper"); await expect(page.getByRole("table", { name: "Positions" })).toBeVisible();
    await page.locator("#p-status").selectOption("OPEN"); await expect(page.getByRole("table", { name: "Positions" }).locator("tbody tr")).toHaveCount(2); expect(seen).toContain("/execution/positions?status=OPEN&limit=200"); await expect(page.getByText("not closed").first()).toBeVisible();
    await page.locator("#o-status").selectOption("PARTIALLY_FILLED"); await expect(page.getByRole("table", { name: "Simulated orders" }).locator("tbody tr")).toHaveCount(1); expect(seen).toContain("/execution/orders?status=PARTIALLY_FILLED&limit=200");
  });
  test("hostile text from the backend is inert", async ({ page }) => { await signIn(page, TRADER); await page.goto("/paper"); await expect(page.getByText(/approve this fill now/).first()).toBeVisible(); await expect(page.locator("main img")).toHaveCount(0); });
  test("empty and error (with a working Try again) states", async ({ page }) => {
    await signIn(page, who("empty")); await page.goto("/paper"); await expect(page.getByText("No positions yet")).toBeVisible(); await expect(page.getByText("No simulated orders yet")).toBeVisible();
    await page.context().clearCookies(); await signIn(page, who("broken")); await page.goto("/paper"); await expect(page.getByText(/positions could not be loaded/)).toBeVisible(); await page.getByRole("button", { name: "Try again" }).first().click(); await expect(page.getByRole("table", { name: "Positions" })).toBeVisible();
  });
  test("an ADMIN is blocked and no paper request reaches the backend", async ({ page }) => {
    await signIn(page, ADMIN); const seen = track(page); await page.goto("/paper"); await expect(page.getByRole("heading", { name: "Not available to administrators" })).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/execution"))).toEqual([]);
  });
  test("the browser cannot write through the relay on any paper route", async ({ page }) => {
    await signIn(page, TRADER); const r = await page.evaluate(async () => { const out: number[] = []; for (const p of ["/execution/orders", "/execution/positions", "/portfolio", "/execution/orders/00000000-0000-4000-8000-000000000621/fills"]) for (const m of ["POST", "PUT", "DELETE"]) { const res = await fetch(`/api/session${p}`, { method: m, headers: { "content-type": "application/json" }, body: m === "DELETE" ? null : "{}" }); out.push(res.status); } return out; });
    for (const s of r) expect([403, 404, 405]).toContain(s);
  });
});

test.describe("Outcomes & Performance", () => {
  test("shows ONE recorded-result section at a time with FIXTURE and PAPER labels; switching sections is a link and an unknown section falls back", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/performance"); await expect(page.getByRole("heading", { name: "Outcomes & performance", level: 1 })).toBeVisible();
    await expect(page.getByText("LIVE PERFORMANCE UNAVAILABLE")).toBeVisible(); await expect(page.getByText(/not linked to a decision here/)).toBeVisible(); const nav = page.getByRole("navigation", { name: "Performance sections" }); await expect(nav.getByRole("link")).toHaveCount(4);
    await expect(page.getByTestId("insights-body")).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/analytics"))).toEqual(["/analytics/overview"]);
    await nav.getByRole("link", { name: "Outcomes" }).click(); await expect(page).toHaveURL(/section=outcomes/); await expect(page.getByText("FIXTURE").first()).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/analytics/outcomes")).length).toBe(1);
    await page.goto("/performance?section=bogus"); await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page"); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
  });
  test("an ADMIN is blocked and no analytics request reaches the backend", async ({ page }) => {
    await signIn(page, ADMIN); const seen = track(page); await page.goto("/performance"); await expect(page.getByRole("heading", { name: "Not available to administrators" })).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/analytics"))).toEqual([]);
  });
  test("the navigation reaches Portfolio, Paper Trading and Outcomes & Performance", async ({ page }) => {
    await signIn(page, TRADER); await page.setViewportSize({ width: 1440, height: 900 }); const rail = page.getByRole("complementary", { name: "Primary" });
    await rail.getByRole("link", { name: "Portfolio" }).click(); await expect(page).toHaveURL(/\/portfolio$/); await rail.getByRole("link", { name: "Paper Trading" }).click(); await expect(page).toHaveURL(/\/paper$/); await rail.getByRole("link", { name: "Outcomes & Performance" }).click(); await expect(page).toHaveURL(/\/performance$/);
  });
});

test.describe("Decision Detail: linked paper activity", () => {
  test("loads only on request; orders by the API's decision filter, positions matched by decision id; no outcome is linked", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/decisions/00000000-0000-4000-8000-000000000500"); await expect(page.getByText("Why this outcome")).toBeVisible(); expect(seen.some((s) => s.startsWith("/execution"))).toBe(false);
    await page.getByRole("button", { name: "Load linked paper activity" }).click(); await expect(page.getByRole("table", { name: "Linked paper orders" })).toBeVisible(); await expect(page.getByRole("table", { name: "Linked paper positions" })).toBeVisible();
    expect(seen).toContain("/execution/orders?decisionId=00000000-0000-4000-8000-000000000500&limit=200"); await expect(page.getByText(/No recorded outcome is linked to a decision/)).toBeVisible();
  });
});
