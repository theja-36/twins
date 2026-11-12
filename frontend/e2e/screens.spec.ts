import { ADMIN, TRADER, expect, signIn, test } from "./fixtures";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test.describe("Overview (TRADER)", () => {
  test("shows real, source-labelled regions and never an invented balance or P&L", async ({ page }) => {
    await signIn(page, TRADER); await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByText("Live trading is disabled. Everything")).toBeVisible();
    await expect(page.getByText("The latest scans ran on synthetic fixture data")).toBeVisible();
    await expect(page.getByRole("region", { name: /Needs your decision/ }).or(page.locator("section[aria-labelledby=dec-h]")).first()).toContainText("1");
    await expect(page.getByRole("table", { name: "Open paper positions" })).toContainText("INDCO2");
    await expect(page.getByText("Unrealised result is NOT AVAILABLE")).toBeVisible();
    await expect(page.locator("section[aria-labelledby=na-h]")).toContainText("Portfolio equity and cash balance");
    await expect(page.locator("main")).not.toContainText(/unrealised (profit|p&l)\s*[:₹\d]/i);
  });
  test("quick links reach the other screens", async ({ page }) => {
    await signIn(page, TRADER); await page.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: "Opportunities" }).click(); await expect(page).toHaveURL(/\/opportunities$/);
  });
});

test.describe("Opportunity discovery", () => {
  test("both origins are present and distinguished by text", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/opportunities"); const t = page.getByRole("table", { name: "Candidates" });
    await expect(t.getByText("Telegram-originated").first()).toBeVisible(); await expect(t.getByText("Independently discovered").first()).toBeVisible(); await expect(t.getByText("FIXTURE").first()).toBeVisible();
    await expect(page.getByText("calculates no score")).toBeVisible();
  });
  test("origin filter is applied by the backend and kept in the URL", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/opportunities"); await page.getByLabel("Origin").selectOption("INDEPENDENT");
    await expect(page).toHaveURL(/source=INDEPENDENT/); const t = page.getByRole("table", { name: "Candidates" }); await expect(t.getByText("Independently discovered").first()).toBeVisible(); await expect(t.getByText("Telegram-originated")).toHaveCount(0);
  });
  test("paging: 25 per page, then the remainder", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/opportunities"); const rows = page.getByRole("table", { name: "Candidates" }).locator("tbody tr");
    await expect(rows).toHaveCount(25); await page.getByRole("button", { name: "Next" }).click(); await expect(page).toHaveURL(/page=2/); await expect(rows).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled(); await page.getByRole("button", { name: "Previous" }).click(); await expect(rows).toHaveCount(25);
  });
  test("the text filter narrows loaded rows only, and says so", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/opportunities"); await page.getByLabel("Find in this page").fill("INDCO4");
    await expect(page.getByRole("table", { name: "Candidates" }).locator("tbody tr")).toHaveCount(1); await expect(page.getByText("does not search the backend")).toBeVisible();
    await page.getByLabel("Find in this page").fill("zzzz"); await expect(page.getByText(/No loaded row matches/)).toBeVisible();
  });
  test("an empty result explains itself", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/opportunities?state=EXPIRED"); await expect(page.getByText("No candidates yet")).toBeVisible(); await expect(page.getByText("No candidates match these filters")).toBeVisible();
  });
  test("ADMIN can browse the shared list", async ({ page }) => {
    await signIn(page, ADMIN); await page.goto("/opportunities"); await expect(page.getByRole("table", { name: "Candidates" })).toBeVisible();
  });
});

test.describe("Opportunity detail", () => {
  test("TRADER sees evidence-first detail with honest unavailable sections and their own decisions", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/opportunities/${ID(1)}`);
    await expect(page.getByRole("heading", { name: "TELCO1", level: 1 })).toBeVisible(); await expect(page.getByText("Proposal only")).toBeVisible(); await expect(page.getByText("This candidate was built on synthetic fixture data")).toBeVisible();
    const ev = page.locator("section[aria-labelledby=ev-h]"); await expect(ev).toContainText("setup"); await expect(ev).toContainText("reward risk screen");
    await expect(page.locator("section[aria-labelledby=liq-h]")).toContainText("NOT AVAILABLE"); await expect(page.locator("section[aria-labelledby=ctx-h]")).toContainText("No trader-authorised route");
    await expect(page.getByRole("link", { name: "Open the research workspace" })).toBeVisible(); await expect(page.getByRole("table", { name: "Decisions for this candidate" })).toContainText("PENDING");
    await expect(page.getByRole("button", { name: /approve|reject|execute|order/i })).toHaveCount(0);
  });
  test("an option candidate shows strike, type and expiry as recorded", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/opportunities/${ID(2)}`); await expect(page.getByRole("heading", { level: 1 })).toContainText("INDCO2 24,500 CE"); await expect(page.getByRole("heading", { level: 1 })).toContainText("exp 2031-01-30");
  });
  test("a candidate with no decision says so", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/opportunities/${ID(4)}`); await expect(page.getByText("No decision has been made on this candidate yet")).toBeVisible();
  });
  test("unknown ids and server errors are explained, not blank", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/opportunities/${ID(99)}`); await expect(page.getByText("could not be loaded")).toBeVisible();
    await page.goto(`/opportunities/${ID(98)}`); await expect(page.getByText("could not be loaded")).toBeVisible(); await page.goto("/opportunities/not-a-uuid"); await expect(page.getByText(/not found|could not be found/i).first()).toBeVisible();
  });
  test("ADMIN sees the shared candidate but never private decisions, and the browser never asks for them", async ({ page }) => {
    const asked: string[] = []; page.on("request", (r) => { asked.push(new URL(r.url()).pathname); });
    await signIn(page, ADMIN); await page.goto(`/opportunities/${ID(1)}`); await expect(page.getByRole("heading", { name: "TELCO1", level: 1 })).toBeVisible();
    await expect(page.getByText("Decisions are private to traders")).toBeVisible(); expect(asked.some((p) => /\/api\/session\/(decisions|approvals|execution)/.test(p))).toBe(false);
  });
});

test.describe("Market intelligence", () => {
  test("shows channel health, scans and candidate counts, and lists what is not available", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/market"); await expect(page.getByRole("heading", { name: "Market intelligence", level: 1 })).toBeVisible();
    const ch = page.getByRole("table", { name: "Telegram channels" }); await expect(ch).toContainText("Desk alpha"); await expect(ch).toContainText("SILENT"); await expect(page.getByText("1 of 2 channels are stale, silent")).toBeVisible();
    await expect(page.getByRole("table", { name: "Latest opportunity scans" })).toContainText("FIXTURE");
    const na = page.locator("section[aria-labelledby=na-h]"); for (const t of ["Market regime", "Live quotes and prices", "News feed", "Options chain, Greeks, implied volatility", "Economic events calendar"]) await expect(na).toContainText(t);
    await expect(page.getByText("No live market data")).toBeVisible();
  });
  test("ADMIN can read it too", async ({ page }) => { await signIn(page, ADMIN); await page.goto("/market"); await expect(page.getByRole("table", { name: "Telegram channels" })).toBeVisible(); });
});

test.describe("the browser stays on its own origin", () => {
  test("every request goes to this app, and only through /api", async ({ page, baseURL }) => {
    const hosts = new Set<string>(), apis = new Set<string>(); page.on("request", (r) => { const u = new URL(r.url()); hosts.add(u.host); if (u.pathname.startsWith("/api/")) apis.add(u.pathname); });
    await signIn(page, TRADER); for (const p of ["/", "/market", "/opportunities", `/opportunities/${ID(1)}`]) { await page.goto(p); await page.waitForLoadState("networkidle"); }
    expect([...hosts]).toEqual([new URL(baseURL!).host]); expect([...apis].every((p) => p.startsWith("/api/session/") || p.startsWith("/api/auth/"))).toBe(true);
  });
});
