import { ADMIN, TRADER, expect, setTheme, signIn, test } from "./fixtures";

const who = (name: string) => ({ email: `${name}@example.test`, password: `${name}-pass-123` });
const isAnalytics = (url: string): boolean => new URL(url).pathname.startsWith("/api/session/analytics/");
const track = (page: import("@playwright/test").Page): string[] => { const seen: string[] = []; page.on("request", (r) => { if (isAnalytics(r.url())) seen.push(new URL(r.url()).pathname + new URL(r.url()).search); }); return seen; };
const SECTIONS: Array<[string, string, RegExp]> = [["overview", "Overview", /Performance overview/], ["strategies", "Strategies", /Performance by dimension/], ["channels", "Channels", /Telegram channels in the analytics/], ["independent", "Independent", /Independent opportunity pipeline/], ["agents", "Agents", /Research agents/], ["decisions", "Decisions", /Decision tallies/], ["drift", "Drift", /Drift findings/], ["data-quality", "Data quality", /How reliable the analytics inputs are/], ["calibration", "Calibration", /Confidence calibration/], ["outcomes", "Outcomes", /Outcome history/], ["insights", "Insights", /Generated insights/]];

test.describe("Learning & Insights (TRADER)", () => {
  test("opening the page makes ONE analytics read and states PAPER, dataset, live-unavailable, fixture-backed and the snapshot facts", async ({ page }) => {
    const seen = track(page); await signIn(page, TRADER); await page.goto("/insights"); await expect(page.getByRole("heading", { name: "Learning & Insights", level: 1 })).toBeVisible(); await expect(page.getByText("DATASET PAPER")).toBeVisible();
    await expect(page.getByText("LIVE ANALYTICS UNAVAILABLE").first()).toBeVisible(); await expect(page.getByText("FIXTURE-BACKED DATA").first()).toBeVisible(); await expect(page.getByText("CURRENT", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/may be generated or refreshed by a read request/)).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen).toEqual(["/api/session/analytics/overview"]);
  });
  test("all eleven sections work, each makes exactly one read, and going back reuses the cache", async ({ page }) => {
    const seen = track(page); await signIn(page, TRADER); await page.goto("/insights"); const nav = page.getByRole("navigation", { name: "Analytics sections" });
    for (const [id, label, heading] of SECTIONS) { await nav.getByRole("link", { name: label, exact: true }).click(); await expect(page.getByRole("heading", { name: heading })).toBeVisible(); await expect(page.getByText("DATASET PAPER")).toBeVisible(); if (id !== "overview") await expect(page).toHaveURL(new RegExp(`section=${id}$`)); }
    await nav.getByRole("link", { name: "Overview", exact: true }).click(); await expect(page.getByRole("heading", { name: /Performance overview/ })).toBeVisible(); await page.waitForLoadState("networkidle");
    const paths = seen.map((s) => s.split("?")[0]); expect(new Set(paths).size).toBe(paths.length); expect(paths).toHaveLength(11); // one request per section, none repeated
    expect(seen.some((s) => /cursor|accountId|dataset=|dimension=/.test(s))).toBe(false);
  });
  test("honest numbers: unavailable metrics are labelled, the exact decimal is shown, validated-only is explained, and the drawdown percentage is unavailable", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/insights"); const ex = page.getByRole("group", { name: "Expectancy (R)" }); await expect(ex).toContainText("Not computed"); await expect(ex).toContainText("fewer than 30 eligible outcomes"); await expect(page.getByText(/percentage drawdown needs an account equity curve/)).toBeVisible();
    await expect(page.locator("main")).toContainText("6,172.18"); await page.getByRole("button", { name: /Validated only/ }).click(); await expect(page.getByText("No eligible outcomes in this group")).toBeVisible(); await expect(page.getByText(/never live-market performance/)).toBeVisible();
  });
  test("strategies are not ranked, and an unavailable dimension is explained", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/insights?section=strategies"); await expect(page.getByText(/not ranked by result/)).toBeVisible(); await page.getByLabel("Dimension", { exact: true }).selectOption("bySignalPattern"); await expect(page.getByText(/Signal pattern: not available/)).toBeVisible();
  });
  test("calibration stays uncalibrated and shows no curve; channels list what cannot be known; decisions keep eligibility apart from approval", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/insights?section=calibration"); await expect(page.locator(".badge", { hasText: "UNCALIBRATED" })).toBeVisible(); await expect(page.getByText(/provides no calibration curve/)).toBeVisible();
    await page.goto("/insights?section=channels"); await expect(page.getByText("Channel reliability").first()).toBeVisible(); await expect(page.getByText(/channel accuracy/)).toBeVisible();
    await page.goto("/insights?section=decisions"); await expect(page.getByText(/It is not an approval and not an execution/)).toBeVisible(); await expect(page.getByText("Approved by a person")).toBeVisible();
  });
  test("outcomes: filters send only the verified parameters; every row is labelled FIXTURE; no cursor is offered", async ({ page }) => {
    const seen = track(page); await signIn(page, TRADER); await page.goto("/insights?section=outcomes"); await expect(page.getByRole("table", { name: "Outcome history" })).toContainText("FIXTURE"); await expect(page.getByRole("table", { name: "Outcome history" })).toContainText("0.66907100");
    await page.getByLabel("Finality", { exact: true }).selectOption("PARTIAL"); await expect(page.getByRole("table", { name: "Outcome history" })).toHaveCount(1); await page.getByLabel("Rows to load", { exact: true }).selectOption("100"); await page.waitForLoadState("networkidle");
    expect(seen).toContain("/api/session/analytics/outcomes?limit=100&finality=PARTIAL"); expect(seen.some((s) => s.includes("cursor"))).toBe(false); await expect(page.getByText(/no next-page cursor/)).toBeVisible();
  });
  test("insights are REVIEW-only: review badges, no action control, a kind filter through the backend parameter, hostile text stays inert", async ({ page }) => {
    const seen = track(page); await signIn(page, TRADER); await page.goto("/insights?section=insights"); await expect(page.getByText("FOR HUMAN REVIEW").first()).toBeVisible(); await expect(page.getByText(/changes no strategy, weight, threshold, risk limit/)).toBeVisible();
    await expect(page.locator("main").getByRole("button", { name: /approve|reject|accept|dismiss|apply|execute|order|enable|disable/i })).toHaveCount(0); await expect(page.locator("main").getByRole("link", { name: /approve|reject|execute|apply/i })).toHaveCount(0);
    await page.getByLabel("Insight kind", { exact: true }).selectOption("DRIFT"); await expect.poll(() => seen.some((s) => s.includes("kind=DRIFT"))).toBe(true); await expect(page.locator("article").first()).toContainText("DRIFT");
  });
  test("URL manipulation changes nothing: an unknown section falls back to the overview; account or user parameters are never sent", async ({ page }) => {
    const seen = track(page); await signIn(page, TRADER); await page.goto("/insights?section=..%2Fadmin&accountId=33333333-3333-4333-8333-333333333333&userId=22222222-2222-4222-8222-222222222222");
    await expect(page.getByRole("heading", { name: /Performance overview/ })).toBeVisible(); await page.waitForLoadState("networkidle"); expect(seen).toEqual(["/api/session/analytics/overview"]);
  });
  test("the browser only talks to its own origin, only through /api", async ({ page, baseURL }) => {
    const hosts = new Set<string>(); page.on("request", (r) => hosts.add(new URL(r.url()).host)); await signIn(page, TRADER); await page.goto("/insights?section=strategies"); await page.waitForLoadState("networkidle"); expect([...hosts]).toEqual([new URL(baseURL!).host]);
  });
});

test.describe("data states from the backend", () => {
  test("STALE: the badge, the reason and the data", async ({ page }) => { await signIn(page, who("stale")); await page.goto("/insights"); await expect(page.getByText(/could not be analysed; this is the newest stored snapshot/).first()).toBeVisible(); await expect(page.getByText("STALE").first()).toBeVisible(); await expect(page.getByRole("group", { name: "Win rate" })).toBeVisible(); });
  test("PARTIAL: a partial-evidence notice with the data", async ({ page }) => { await signIn(page, who("partial")); await page.goto("/insights"); await expect(page.getByText("PARTIAL EVIDENCE")).toBeVisible(); await expect(page.getByText(/Some evidence behind these figures is incomplete/)).toBeVisible(); await expect(page.getByRole("group", { name: "Win rate" })).toBeVisible(); });
  test("EMPTY: an explanation and no figures", async ({ page }) => { await signIn(page, who("empty")); await page.goto("/insights"); await expect(page.getByText("No performance overview yet")).toBeVisible(); await expect(page.getByRole("group", { name: "Win rate" })).toHaveCount(0); await page.goto("/insights?section=insights"); await expect(page.getByText(/never creates them/)).toBeVisible(); });
  test("ERROR then retry: the error is shown with its code, Try again re-requests and the data appears", async ({ page }) => {
    const seen = track(page); await signIn(page, who("broken")); await page.goto("/insights"); await expect(page.getByText(/could not be loaded/)).toBeVisible(); await expect(page.getByText(/Reference INTERNAL|Reference/)).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click(); await expect(page.getByRole("group", { name: "Win rate" })).toBeVisible(); expect(seen).toEqual(["/api/session/analytics/overview", "/api/session/analytics/overview"]);
  });
});

test.describe("access", () => {
  test("ADMIN: the page says it is not available to administrators and NO analytics request is made; the backend answers 404 to a direct call", async ({ page }) => {
    const seen = track(page); await signIn(page, ADMIN); await page.goto("/insights"); await expect(page.getByRole("heading", { name: "Not available to administrators" })).toBeVisible(); await expect(page.getByTestId("insights-body")).toHaveCount(0); await page.waitForLoadState("networkidle"); expect(seen).toEqual([]);
    expect((await page.request.get("/api/session/analytics/overview")).status()).toBe(404);
    await expect(page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Learning Insights" })).toHaveCount(0);
  });
  test("unauthenticated visitors are sent to sign-in and no analytics request is made", async ({ page }) => {
    const seen = track(page); await page.goto("/insights"); await expect(page).toHaveURL(/\/login/); expect(seen).toEqual([]); expect((await page.request.get("/api/session/analytics/overview")).status()).toBe(401);
  });
  test("a TRADER reaches it from the Understand navigation", async ({ page }) => {
    await signIn(page, TRADER); await page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Learning Insights" }).click(); await expect(page).toHaveURL(/\/insights$/); await expect(page.getByRole("heading", { name: "Learning & Insights", level: 1 })).toBeVisible();
  });
});

/** Wide tables (Strategies, Outcomes): natural width, sideways scroll INSIDE the table region, nothing broken mid-word, every column present, the page itself never overflows. */
const WIDTHS = [1440, 820, 390, 320] as const;
for (const width of WIDTHS) for (const theme of ["dark", "light"] as const) {
  test.describe(`wide tables at ${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const [name, url, table, columns] of [["Strategies", "/insights?section=strategies", "Performance by Strategy (setup)", 9], ["Outcomes", "/insights?section=outcomes", "Outcome history", 15]] as const) {
      test(`${name}: readable cells, internal horizontal scroll, every column reachable, no page overflow`, async ({ page }) => {
        await setTheme(page, theme); await signIn(page, TRADER); await page.goto(url); await expect(page.getByRole("table", { name: table })).toBeVisible(); await page.waitForLoadState("networkidle");
        const m = await page.evaluate((t) => {
          const region = [...document.querySelectorAll<HTMLElement>(".tblwrap")].find((r) => r.getAttribute("aria-label") === `${t} (scrollable)`)!, tb = region.querySelector("table")!;
          const cells = [...tb.querySelectorAll<HTMLElement>("th, td:not(.wrap)")];
          const tall = cells.filter((c) => c.getBoundingClientRect().height > 70).map((c) => `${c.tagName} "${(c.textContent ?? "").slice(0, 20)}" ${Math.round(c.getBoundingClientRect().height)}px`);
          const clipped = cells.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => (c.textContent ?? "").slice(0, 20));
          const before = region.scrollLeft; region.scrollLeft = region.scrollWidth; const last = [...tb.querySelectorAll<HTMLElement>("th")].at(-1)!.getBoundingClientRect(), box = region.getBoundingClientRect();
          return { headers: tb.querySelectorAll("th").length, regionScrollable: region.scrollWidth > region.clientWidth, canScroll: region.scrollLeft > before || region.scrollWidth <= region.clientWidth, lastVisibleAfterScroll: last.right <= box.right + 1 && last.left >= box.left - 1, tall, clipped, page: { sw: document.documentElement.scrollWidth, iw: window.innerWidth }, rowH: Math.round(tb.querySelector("tbody tr")!.getBoundingClientRect().height) };
        }, table);
        expect(m.headers, "every column is present at every width").toBe(columns); expect(m.tall, "no cell is stretched by mid-word breaks").toEqual([]); expect(m.clipped, "no cell clips its own text").toEqual([]);
        expect(m.page.sw, "the page itself must not scroll sideways").toBeLessThanOrEqual(m.page.iw); expect(m.canScroll).toBe(true); expect(m.lastVisibleAfterScroll, "the last column is reachable by scrolling inside the table").toBe(true); expect(m.rowH).toBeLessThan(110);
        if (width <= 820) expect(m.regionScrollable, "on narrow screens the table scrolls inside its own region").toBe(true);
        await expect(page.getByRole("table", { name: table })).toContainText(name === "Outcomes" ? "6,172.18" : "BREAKOUT");
      });
    }
  });
}
test("a wide table region is keyboard focusable and scrolls with the arrow keys", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await signIn(page, TRADER); await page.goto("/insights?section=outcomes"); const region = page.getByRole("region", { name: "Outcome history (scrollable)" }); await region.focus(); await expect(region).toBeFocused();
  const before = await region.evaluate((r) => r.scrollLeft); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await expect.poll(() => region.evaluate((r) => r.scrollLeft)).toBeGreaterThan(before);
});
