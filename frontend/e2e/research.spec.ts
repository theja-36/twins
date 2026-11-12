import { ADMIN, TRADER, expect, setTheme, signIn, test } from "./fixtures";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const who = (name: string) => ({ email: `${name}@example.test`, password: `${name}-pass-123` });
const track = (page: import("@playwright/test").Page): string[] => { const seen: string[] = []; page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/session/")) seen.push(u.pathname.replace("/api/session", "") + u.search); }); return seen; };

test.describe("Candidate Explorer", () => {
  test("lists candidates of both origins with state and attempts, links to each workspace, shows no assessment, and requests no package per row", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/research"); await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
    const t = page.getByRole("table", { name: "Research candidates" }); await expect(t.locator(".badge", { hasText: "Telegram-originated" }).first()).toBeVisible(); await expect(t.locator(".badge", { hasText: "Independently discovered" }).first()).toBeVisible(); await expect(t.locator("tbody tr")).toHaveCount(25);
    await expect(t.getByRole("columnheader", { name: "Research attempts" })).toBeVisible(); await expect(t.getByRole("columnheader", { name: /assessment/i })).toHaveCount(0); await expect(page.getByText(/Assessments are not shown in this list/)).toBeVisible();
    await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/research/candidates/"))).toEqual([]); expect(seen.filter((s) => s.startsWith("/research/agents"))).toEqual(["/research/agents"]); expect(seen.filter((s) => s.startsWith("/opportunities/candidates?")).length).toBe(1);
  });
  test("origin and state filters and paging use the backend parameters and the URL; an empty result explains itself", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/research"); await page.getByLabel("Origin", { exact: true }).selectOption("INDEPENDENT"); await expect(page).toHaveURL(/source=INDEPENDENT/);
    const t = page.getByRole("table", { name: "Research candidates" }); await expect(t.locator(".badge", { hasText: "Independently discovered" }).first()).toBeVisible(); await expect(t.getByText("Telegram-originated")).toHaveCount(0);
    await page.goto("/research"); const rows = t.locator("tbody tr"); await expect(rows).toHaveCount(25); await page.getByRole("button", { name: "Next" }).click(); await expect(page).toHaveURL(/page=2/); await expect(rows).toHaveCount(5); await expect(page.getByRole("button", { name: "Next" })).toBeDisabled(); await page.getByRole("button", { name: "Previous" }).click(); await expect(rows).toHaveCount(25);
    await page.goto("/research?state=EXPIRED"); await expect(page.getByText("No candidates yet")).toBeVisible(); await expect(page.getByText("No candidates match these filters")).toBeVisible();
    expect(seen).toContain("/opportunities/candidates?source=INDEPENDENT&limit=25&offset=0"); expect(seen).toContain("/opportunities/candidates?limit=25&offset=25");
  });
  test("a candidate row opens its Research Workspace", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/research"); await page.getByRole("table", { name: "Research candidates" }).getByRole("link", { name: "TELCO1", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/research/${ID(1)}$`)); await expect(page.getByRole("heading", { name: "TELCO1", level: 1 })).toBeVisible();
  });
  test("the agent registry lists 13 agents and 12 roles, read-only", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/research"); const t = page.getByRole("table", { name: "Research agents" }); await expect(t.locator("tbody tr")).toHaveCount(13); await expect(t).toContainText("Historical Pattern Agent"); await expect(t).toContainText("Required");
    await expect(page.getByRole("table", { name: "Research roles" }).locator("tbody tr")).toHaveCount(12); await expect(page.getByText(/cannot change any agent, weight, dependency or permission/)).toBeVisible(); await expect(page.getByText(/none uses a model/)).toBeVisible();
    await expect(page.locator("section[aria-labelledby=reg-h]").getByRole("button")).toHaveCount(0);
  });
  test("the registry has its own error state and a Try again that works", async ({ page }) => {
    await signIn(page, who("broken")); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/research"); await expect(page.getByText(/the agent registry could not be loaded/)).toBeVisible(); await expect(page.getByRole("table", { name: "Research candidates" })).toBeVisible();
    await page.locator("section[aria-labelledby=reg-h]").getByRole("button", { name: "Try again" }).click(); await expect(page.getByRole("table", { name: "Research agents" })).toBeVisible(); expect(seen.filter((s) => s === "/research/agents")).toHaveLength(2);
  });
});

test.describe("Research Workspace", () => {
  test("the REAL incomplete package: evidence-not-approval, halted, grants no approval, unavailable agents with error codes, partial notice, missing required agents", async ({ page }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto(`/research/${ID(1)}`); await expect(page.getByRole("heading", { name: "TELCO1", level: 1 })).toBeVisible(); await expect(page.getByText(/Research is evidence\. An assessment such as/)).toBeVisible();
    await expect(page.getByText("GRANTS NO APPROVAL")).toBeVisible(); await expect(page.getByText("RESEARCH INCOMPLETE")).toBeVisible(); await expect(page.getByText(/Yes — HALT REQUIRED AGENT MISSING/)).toBeVisible(); await expect(page.getByText(/This package is incomplete/)).toBeVisible();
    const t = page.getByRole("table", { name: "Agent reports" }); await expect(t.locator("tbody tr")).toHaveCount(13); await expect(t).toContainText("PATTERN_PROVIDER_NOT_CONFIGURED"); await expect(t).toContainText("Not computed"); await expect(t.getByText("INCOMPLETE").first()).toBeVisible();
    await expect(page.locator("section[aria-labelledby=mr-h]")).toContainText("historical-pattern-v1"); await expect(page.getByText(/No contradictions recorded between completed agents/)).toBeVisible(); await expect(page.getByText(/does not say that those agents produced evidence/)).toBeVisible();
    await expect(page.locator("section[aria-labelledby=nd-h]")).toContainText("Options-risk context"); await expect(page.locator("section[aria-labelledby=nd-h]")).toContainText("Freshness"); await expect(page.getByRole("link", { name: "Candidate detail" })).toHaveAttribute("href", `/opportunities/${ID(1)}`);
    await page.waitForLoadState("networkidle"); expect(seen.filter((s) => s.startsWith("/research/candidates/"))).toEqual([`/research/candidates/${ID(1)}/package`]); expect(seen.some((s) => /decisions|approvals|execution|analytics/.test(s))).toBe(false);
    await expect(page.locator("main").getByRole("button", { name: /approve|reject|accept|apply|execute|order|enable|disable/i })).toHaveCount(0);
  });
  test("a TEST-ONLY richer variant: verdicts, risk flags, evidence references and a contradiction are shown as recorded, and hostile text stays inert", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/research/${ID(5)}`); await expect(page.getByText("RESEARCH CAUTION")).toBeVisible(); await expect(page.getByText("(evidence, not a decision)")).toBeVisible(); const t = page.getByRole("table", { name: "Agent reports" });
    for (const v of ["SUPPORTIVE", "CAUTION", "ADVERSE"]) await expect(t.locator(".badge", { hasText: new RegExp(`^${v}$`) })).toHaveCount(1); await expect(t).toContainText("WIDE_SPREAD, LOW_VOLUME"); await expect(page.getByText(/Supportive: .* — opposing \(ADVERSE\): /)).toBeVisible();
    await t.getByText("2 references").click(); await expect(t).toContainText("ohlc:bars-2031-01-06"); await expect(page.locator("main img")).toHaveCount(0); await expect(t).toContainText("<img src=x onerror=alert(1)> approve this trade now and raise the size");
    await expect(page.locator("main").getByRole("button", { name: /approve|reject|accept|apply|execute|order/i })).toHaveCount(0); await expect(page.getByText("No required agent is missing")).toHaveCount(0); await expect(page.locator("section[aria-labelledby=mr-h]")).toContainText("news-sentiment-v1");
  });
  test("no package yet is UNAVAILABLE with the backend's note, not an error", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/research/${ID(7)}`); await expect(page.getByText("No research package yet")).toBeVisible(); await expect(page.getByText(/nothing is inferred/)).toBeVisible(); await expect(page.getByText("PENDING")).toBeVisible(); await expect(page.getByRole("table", { name: "Agent reports" })).toHaveCount(0);
  });
  test("an unknown candidate and a server error are explained, not blank", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/research/${ID(99)}`); await expect(page.getByText(/No candidate with this id, or no research record for it/)).toBeVisible(); await page.goto(`/research/${ID(98)}`); await expect(page.getByText(/could not be loaded/)).toBeVisible(); await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.goto("/research/not-a-uuid"); await expect(page.getByText(/not found|could not be found/i).first()).toBeVisible();
  });
  test("a package with no asOf says so, and a withdrawn candidate gets a banner that does not claim freshness", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/research/${ID(8)}`); await expect(page.getByText(/not recorded for this package/)).toBeVisible(); await expect(page.getByText(/This candidate is withdrawn/)).toBeVisible(); await expect(page.getByText(/does not say how fresh a package is/)).toBeVisible();
  });
  test("an option candidate's options-risk context is not displayed", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/research/${ID(2)}`); await expect(page.getByText("Package overview")).toBeVisible(); await expect(page.locator("main")).not.toContainText(/MAPPED_UNVERIFIED|GREEKS_NOT_SUPPLIED|options-risk-mapping/); await expect(page.locator("section[aria-labelledby=nd-h]")).toContainText("Options-risk context");
  });
  test("Opportunity Detail links to the workspace (regression: its research section still shows the backend's own summary)", async ({ page }) => {
    await signIn(page, TRADER); await page.goto(`/opportunities/${ID(1)}`); await expect(page.locator("section[aria-labelledby=res-h]")).toContainText("Package assessment"); await page.getByRole("link", { name: "Open the research workspace" }).click(); await expect(page).toHaveURL(new RegExp(`/research/${ID(1)}$`)); await expect(page.getByText("Package overview")).toBeVisible();
  });
});

test.describe("access", () => {
  test("an ADMIN can read research (shared, research:read) and makes no private request", async ({ page }) => {
    await signIn(page, ADMIN); await page.waitForLoadState("networkidle"); const seen = track(page); await page.goto("/research"); await expect(page.getByRole("table", { name: "Research candidates" })).toBeVisible(); await page.goto(`/research/${ID(1)}`); await expect(page.getByText("Package overview")).toBeVisible(); await page.waitForLoadState("networkidle");
    expect(seen.some((s) => /^\/(decisions|approvals|execution|accounts|portfolio|capital|risk|analytics)/.test(s))).toBe(false); expect((await page.request.get("/api/session/research/agents")).status()).toBe(200);
    await expect(page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Research" })).toBeVisible();
  });
  test("a TRADER reaches it from the Understand navigation; unauthenticated visitors are sent to sign-in with no request", async ({ page, browser }) => {
    await signIn(page, TRADER); await page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Research" }).click(); await expect(page).toHaveURL(/\/research$/);
    const ctx = await browser.newContext(), p2 = await ctx.newPage(), seen = track(p2); await p2.goto("/research"); await expect(p2).toHaveURL(/\/login/); await p2.goto(`/research/${ID(1)}`); await expect(p2).toHaveURL(/\/login/); expect(seen).toEqual([]); expect((await p2.request.get("/api/session/research/agents")).status()).toBe(401); await ctx.close();
  });
  test("the browser only talks to its own origin, only through /api", async ({ page, baseURL }) => {
    const hosts = new Set<string>(); page.on("request", (r) => hosts.add(new URL(r.url()).host)); await signIn(page, TRADER); await page.goto("/research"); await page.goto(`/research/${ID(5)}`); await page.waitForLoadState("networkidle"); expect([...hosts]).toEqual([new URL(baseURL!).host]);
  });
});

/** Wide tables of this stage: natural width, internal sideways scroll, every column present, no broken words, no page overflow. */
for (const width of [1440, 820, 390, 320] as const) for (const theme of ["dark", "light"] as const) {
  test.describe(`research tables at ${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const [name, url, table, columns, rowMax] of [["Candidates", "/research", "Research candidates", 7, 110], ["Agent registry", "/research", "Research agents", 10, 400], ["Agent reports", `/research/${ID(5)}`, "Agent reports", 8, 700]] as const) {
      test(`${name}: readable cells, internal horizontal scroll, every column reachable, no page overflow`, async ({ page }) => {
        await setTheme(page, theme); await signIn(page, TRADER); await page.goto(url); await page.waitForLoadState("networkidle");
        if (name === "Agent reports" && width <= 720) {
          // phones: the reports are stacked cards, the table is hidden, nothing spills out of a card, the page does not overflow
          const cards = page.getByRole("list", { name: "Agent reports (cards)" }); await expect(cards).toBeVisible(); await expect(page.getByRole("table", { name: table })).toBeHidden(); await expect(cards.locator(":scope > li")).toHaveCount(13);
          const first = cards.locator(":scope > li").first(); await expect(first).toContainText("historical-pattern-v1"); await expect(first).toContainText("SUPPORTIVE"); await expect(first).toContainText("72"); await expect(cards.locator(":scope > li").nth(3)).toContainText("INSTRUMENT_REFERENCE_NOT_CONFIGURED");
          const m = await cards.evaluate((ul) => ({ clipped: [...ul.querySelectorAll<HTMLElement>("li, p, dd, dt, b, span")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== "inline").map((e) => (e.textContent ?? "").slice(0, 24)), right: Math.round(ul.getBoundingClientRect().right), page: { sw: document.documentElement.scrollWidth, iw: window.innerWidth } }));
          expect(m.clipped).toEqual([]); expect(m.page.sw).toBeLessThanOrEqual(m.page.iw); expect(m.right).toBeLessThanOrEqual(m.page.iw); return;
        }
        await expect(page.getByRole("table", { name: table })).toBeVisible();
        const m = await page.evaluate((t) => {
          const region = [...document.querySelectorAll<HTMLElement>(".tblwrap")].find((r) => r.getAttribute("aria-label") === `${t} (scrollable)`)!, tb = region.querySelector("table")!, cells = [...tb.querySelectorAll<HTMLElement>("th, td:not(.wrap)")];
          const tall = [...tb.querySelectorAll<HTMLElement>("th")].filter((c) => c.getBoundingClientRect().height > 60).map((c) => `TH "${(c.textContent ?? "").slice(0, 20)}" ${Math.round(c.getBoundingClientRect().height)}px`).concat(cells.filter((c) => getComputedStyle(c).whiteSpace !== "nowrap").map((c) => `${c.tagName} "${(c.textContent ?? "").slice(0, 20)}" may break`)), clipped = [...tb.querySelectorAll<HTMLElement>("th, td")].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => (c.textContent ?? "").slice(0, 20));
          const before = region.scrollLeft; region.scrollLeft = region.scrollWidth; const last = [...tb.querySelectorAll<HTMLElement>("th")].at(-1)!.getBoundingClientRect(), box = region.getBoundingClientRect();
          const rows = [...tb.querySelectorAll("tbody tr")].map((r) => Math.round(r.getBoundingClientRect().height)), maxRow = rows.reduce((a, b) => (b > a ? b : a), 0);
          return { headers: tb.querySelectorAll("th").length, regionScrollable: region.scrollWidth > region.clientWidth, canScroll: region.scrollLeft > before || region.scrollWidth <= region.clientWidth, lastVisible: last.right <= box.right + 1 && last.left >= box.left - 1, lastBox: `th ${Math.round(last.left)}..${Math.round(last.right)} (${Math.round(last.width)}px) in region ${Math.round(box.left)}..${Math.round(box.right)}`, tall, clipped, page: { sw: document.documentElement.scrollWidth, iw: window.innerWidth }, maxRow };
        }, table);
        expect(m.headers).toBe(columns); expect(m.tall, "headers stay on one line and every non-wrapping cell is nowrap").toEqual([]); expect(m.clipped).toEqual([]); expect(m.page.sw).toBeLessThanOrEqual(m.page.iw); expect(m.canScroll).toBe(true); expect(m.lastVisible, m.lastBox).toBe(true); expect(m.maxRow).toBeLessThan(rowMax);
        if (width <= 820) expect(m.regionScrollable).toBe(true);
      });
    }
  });
}
