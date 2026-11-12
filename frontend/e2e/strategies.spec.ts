import { ADMIN, TRADER, expect, signIn, test } from "./fixtures";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const who = (name: string) => ({ email: `${name}@example.test`, password: `${name}-pass-123` });
const track = (page: import("@playwright/test").Page): string[] => { const seen: string[] = []; page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/session/")) seen.push(u.pathname.replace("/api/session", "") + u.search); }); return seen; };
const WRITE = /approve|reject|cancel|watch|unwatch|order|execute|activate|deactivate|retire|create|edit|enable|disable|submit/i;

test.describe("Decision History", () => {
  test("lists the latest decisions with outcome and workflow state apart, states the 200 limit, and offers no paging or write control", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/decisions");
    await expect(page.getByRole("heading", { name: "Decision history", level: 1 })).toBeVisible(); await expect(page.getByText(/Showing the latest decisions, up to 200/)).toBeVisible(); await expect(page.getByText("PAPER", { exact: true }).first()).toBeVisible();
    const t = page.getByRole("table", { name: "Decisions" }); await expect(t.locator("tbody tr")).toHaveCount(5); await expect(t.getByRole("columnheader", { name: "Outcome" })).toBeVisible(); await expect(t.getByRole("columnheader", { name: "Workflow state" })).toBeVisible();
    await expect(t.locator(".badge", { hasText: "NO TRADE" })).toBeVisible(); await expect(t.locator(".badge", { hasText: "NEWER DECISION" })).toBeVisible();
    await expect(page.getByRole("button", { name: /next|previous/i })).toHaveCount(0); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
    await page.waitForLoadState("networkidle"); expect(seen).toContain("/decisions?limit=200"); expect(seen.join()).not.toMatch(/offset/);
  });
  test("the state filter uses the backend parameter and the URL; an unmatched text filter explains itself", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/decisions"); await page.getByLabel("Workflow state").selectOption("EXPIRED");
    await expect(page).toHaveURL(/state=EXPIRED/); await expect(page.getByRole("table", { name: "Decisions" }).locator("tbody tr")).toHaveCount(1); expect(seen).toContain("/decisions?state=EXPIRED&limit=200");
    await page.getByLabel("Find in loaded rows").fill("zzzz"); await expect(page.getByText(/No loaded row matches/)).toBeVisible();
  });
  test("a row opens its decision detail", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/decisions"); await page.getByRole("table", { name: "Decisions" }).locator("tbody tr").first().getByRole("link").first().click(); await expect(page).toHaveURL(new RegExp(`/decisions/${ID(500)}$`)); await expect(page.getByRole("heading", { name: "Decision detail", level: 1 })).toBeVisible();
  });
  test("empty and error (with a working Try again) states", async ({ page }) => {
    await signIn(page, who("empty")); await page.goto("/decisions"); await expect(page.getByText("No decisions yet")).toBeVisible();
    await page.context().clearCookies();
    await signIn(page, who("broken")); await page.goto("/decisions"); await expect(page.getByText(/decisions could not be loaded/)).toBeVisible(); await page.getByRole("button", { name: "Try again" }).click(); await expect(page.getByRole("table", { name: "Decisions" })).toBeVisible();
  });
  test("an ADMIN is blocked by the gate and no decision request reaches the backend", async ({ page }) => {
    await signIn(page, ADMIN); const seen = track(page); await page.goto("/decisions"); await expect(page.getByText(/not available|isn.t available|Not available/i).first()).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/decisions"))).toEqual([]);
  });
});

test.describe("Decision Detail", () => {
  test("shows the explanation, exact decimal strings, stop-loss validation, timeline and provenance; post-trade outcome is stated as not verified", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto(`/decisions/${ID(500)}`);
    await expect(page.getByText("Why this outcome")).toBeVisible(); await expect(page.getByText("FIXTURE").first()).toBeVisible(); await expect(page.getByText("not an approval").first()).toBeVisible();
    const size = page.locator("section[aria-labelledby=ps-h]"); await expect(size).toContainText("1,250.50"); await expect(size).toContainText("10,050.00"); await expect(size).toContainText("Loss Cap".toUpperCase()); await expect(size).toContainText(/calculates and changes no size/);
    await expect(page.locator("section[aria-labelledby=sl-h]")).toContainText("VALID"); await expect(page.getByRole("table", { name: "Decision timeline" })).toBeVisible(); await expect(page.locator("section[aria-labelledby=pt-h]")).toContainText(/not verified/);
    await expect(page.getByRole("link", { name: "Research workspace" })).toHaveAttribute("href", `/research/${ID(1)}`); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
    await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.includes("comparables"))).toEqual([]); expect(seen.filter((s) => s.startsWith("/decisions/"))).toEqual([`/decisions/${ID(500)}`]);
  });
  test("null size and stop-loss are unavailable (not zero), and no research link is offered without a linked package", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/decisions/${ID(501)}`); await expect(page.getByText(/No permitted size is recorded/)).toBeVisible(); await expect(page.getByText(/No stop-loss validation is recorded/)).toBeVisible(); await expect(page.getByRole("link", { name: "Research workspace" })).toHaveCount(0); await expect(page.locator("section[aria-labelledby=ps-h]")).not.toContainText("₹ 0");
  });
  test("comparables load only on request: available, not available, empty, and error with a working retry", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page);
    await page.goto(`/decisions/${ID(500)}`); await page.getByRole("button", { name: "Load comparables" }).click(); await expect(page.getByText("pattern:breakout-2029-03")).toBeVisible(); expect(seen.filter((s) => s.includes("comparables"))).toEqual([`/decisions/${ID(500)}/comparables`]);
    await page.goto(`/decisions/${ID(501)}`); await page.getByRole("button", { name: "Load comparables" }).click(); await expect(page.getByText(/NO RESEARCH PACKAGE: No research package exists/)).toBeVisible();
    await page.goto(`/decisions/${ID(502)}`); await page.getByRole("button", { name: "Load comparables" }).click(); await expect(page.getByText("No comparables yet")).toBeVisible();
    await page.goto(`/decisions/${ID(503)}`); await page.getByRole("button", { name: "Load comparables" }).click(); await expect(page.getByText(/comparables could not be loaded/)).toBeVisible(); await page.getByRole("button", { name: "Try again" }).click(); await expect(page.getByText("pattern:breakout-2029-03")).toBeVisible();
  });
  test("hostile explanation text is inert", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/decisions/${ID(504)}`); await expect(page.getByText(/approve this trade now/)).toBeVisible(); await expect(page.locator("main img")).toHaveCount(0); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
  });
  test("an unknown decision, a failing backend and an invalid id are quiet and never show data", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/decisions/${ID(599)}`); await expect(page.getByText(/does not exist, or it is not yours/)).toBeVisible();
    await page.goto(`/decisions/${ID(598)}`); await expect(page.getByText(/could not be loaded/)).toBeVisible(); const r = await page.goto("/decisions/not-a-uuid"); expect(r?.status()).toBe(404);
  });
});

test.describe("Playbooks", () => {
  test("lists playbooks with paging by the API limit and offset, links to detail, and has no write control", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/strategies"); await expect(page.getByRole("heading", { name: "Playbooks", level: 1 })).toBeVisible();
    const t = page.getByRole("table", { name: "Playbooks" }), rows = t.locator("tbody tr"); await expect(rows).toHaveCount(25); await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
    await page.getByRole("button", { name: "Next" }).click(); await expect(page).toHaveURL(/page=2/); await expect(rows).toHaveCount(2); await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(seen).toContain("/intelligence/playbooks?limit=25&offset=0"); expect(seen).toContain("/intelligence/playbooks?limit=25&offset=25");
    await page.goto("/strategies"); await t.getByRole("link", { name: "Playbook 1", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/strategies/${ID(700)}$`));
  });
  test("an empty list is honest and nothing is generated; an error has a working Try again", async ({ page }) => {
    await signIn(page, who("empty")); await page.goto("/strategies"); await expect(page.getByText("No playbooks yet")).toBeVisible(); await expect(page.getByText(/none is created or sample-filled here/)).toBeVisible(); await expect(page.getByRole("table")).toHaveCount(0);
    await page.context().clearCookies(); await signIn(page, who("broken")); await page.goto("/strategies"); await expect(page.getByText(/playbooks could not be loaded/)).toBeVisible(); await page.getByRole("button", { name: "Try again" }).click(); await expect(page.getByRole("table", { name: "Playbooks" })).toBeVisible();
  });
  test("an ADMIN may read playbooks (shared intelligence) but is not pointed at private performance", async ({ page }) => {
    await signIn(page, ADMIN); await page.goto("/strategies"); await expect(page.getByRole("table", { name: "Playbooks" })).toBeVisible(); await expect(page.getByRole("link", { name: "Learning Insights" })).toHaveCount(0); await expect(page.getByRole("link", { name: "Playbooks" }).first()).toBeVisible();
  });
  test("a hostile playbook name is inert", async ({ page }) => { await signIn(page, TRADER); await page.goto("/strategies"); await expect(page.getByText("<b>Breakout</b> playbook (hostile name)")).toBeVisible(); await expect(page.locator("table b", { hasText: /^Breakout$/ })).toHaveCount(0); });
});

test.describe("Playbook Detail", () => {
  test("shows each version with its state history, the record-only live flag, drift, and never the unverified content or performance", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/strategies/${ID(700)}`); await expect(page.getByRole("heading", { name: "Playbook 1", level: 1 })).toBeVisible();
    await expect(page.getByRole("article", { name: "Version 2" })).toContainText("EVALUATING"); await expect(page.getByRole("article", { name: "Version 1" })).toContainText("record flag only; live trading is disabled");
    await expect(page.getByRole("table", { name: "Drift events" })).toBeVisible(); await expect(page.getByRole("table", { name: "Version 1 state history" })).toBeVisible(); await expect(page.locator("main")).not.toContainText("stripped"); await expect(page.locator("main")).not.toContainText("winRate\":");
    await expect(page.locator("main").getByRole("button", { name: WRITE })).toHaveCount(0);
  });
  test("a playbook with one draft version shows no invented confidence or history; unknown and failing playbooks are quiet", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/strategies/${ID(701)}`); await expect(page.getByText(/No state changes are recorded for this version/)).toBeVisible(); await expect(page.getByText("not provided").first()).toBeVisible(); await expect(page.getByText(/No drift event is recorded/)).toBeVisible();
    await page.goto(`/strategies/${ID(799)}`); await expect(page.getByText(/No playbook has this id/)).toBeVisible(); await page.goto(`/strategies/${ID(798)}`); await expect(page.getByText(/could not be loaded/)).toBeVisible();
  });
});

test.describe("navigation and relay", () => {
  test("Decision History and Playbooks appear in the right workspaces for the right roles", async ({ page }) => {
    await signIn(page, TRADER); await page.setViewportSize({ width: 1440, height: 900 }); const rail = page.getByRole("complementary", { name: "Primary" }); await expect(rail.getByRole("link", { name: "Decision History" })).toBeVisible(); await expect(rail.getByRole("link", { name: "Playbooks" })).toBeVisible(); await rail.getByRole("link", { name: "Playbooks" }).click(); await expect(page).toHaveURL(/\/strategies$/);
  });
  test("the browser cannot reach a decision action through the relay", async ({ page }) => {
    await signIn(page, TRADER); const r = await page.evaluate(async (id) => { const out: number[] = []; for (const v of ["approve", "reject", "cancel", "watch", "unwatch"]) { const res = await fetch(`/api/session/decisions/${id}/${v}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); out.push(res.status); } return out; }, ID(500));
    for (const s of r) expect([403, 404, 405]).toContain(s);
  });
});
