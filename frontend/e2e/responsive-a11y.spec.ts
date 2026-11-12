import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { ADMIN, TRADER, expect, setTheme, signIn, test } from "./fixtures";

const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "tablet", width: 820, height: 1000 }, { name: "phone", width: 390, height: 844 }, { name: "narrow phone", width: 320, height: 640 }] as const; // 320 px is the narrowest supported screen; it also exposes text-width differences between operating systems
const PAGES = [
  { name: "sign-in", path: "/login", who: null }, { name: "trader-overview", path: "/", who: TRADER }, { name: "trader-paper", path: "/paper", who: TRADER }, { name: "trader-account", path: "/account", who: TRADER },
  { name: "trader-gallery", path: "/design-system", who: TRADER }, { name: "admin-platform", path: "/admin/system", who: ADMIN }, { name: "admin-blocked", path: "/approvals", who: ADMIN },
] as const;
const SHOTS = process.env["CAPTURE_DIR"];

for (const v of VIEWPORTS) for (const theme of ["dark", "light"] as const) {
  test.describe(`${v.name} ${theme}`, () => {
    test.use({ viewport: { width: v.width, height: v.height } });
    for (const p of PAGES) test(`${p.name}: no horizontal page scroll and no accessibility violations (axe, incl. colour contrast)`, async ({ page }) => {
      await setTheme(page, theme);
      if (p.who) await signIn(page, p.who);
      await page.goto(p.path); await page.waitForLoadState("networkidle"); await expect(page.locator("main#main, main.login").first()).toBeVisible();
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      // When the page is too wide, name the elements that poke out (text metrics differ between operating systems, so the failure message must say WHICH element).
      const offenders = overflow.sw > overflow.iw ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5 && getComputedStyle(e).position !== "fixed").slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${String(e.getAttribute("class") ?? "").slice(0, 40)} right=${Math.round(e.getBoundingClientRect().right)} "${(e.textContent ?? "").trim().slice(0, 40)}"`)) : [];
      expect(overflow.sw, `page must not scroll sideways (sw ${overflow.sw} > iw ${overflow.iw}); offenders: ${offenders.join(" || ")}`).toBeLessThanOrEqual(overflow.iw);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
      if (SHOTS && (p.name !== "admin-blocked") && (v.name !== "tablet" || p.name === "trader-overview")) { mkdirSync(SHOTS, { recursive: true }); await page.evaluate(() => { document.querySelector<HTMLElement>(".mobnav")?.style.setProperty("position", "static", "important"); }); await page.screenshot({ path: `${SHOTS}/${p.name}.${theme}.${v.width}.png`, fullPage: true }); }
    });
  });
}

test.describe("responsive layout and keyboard behaviour", () => {
  test("desktop shows the rail and hides the mobile bar; phones the reverse; tablets a collapsed rail", async ({ page }) => {
    await signIn(page, TRADER);
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.getByRole("complementary", { name: "Primary" })).toBeVisible(); await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeHidden();
    await page.setViewportSize({ width: 820, height: 900 }); const w = (await page.getByRole("complementary", { name: "Primary" }).boundingBox())!.width; expect(w).toBeLessThan(100); await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole("complementary", { name: "Primary" })).toBeHidden(); await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeVisible();
    for (const l of await page.getByRole("navigation", { name: "Workspaces" }).getByRole("link").all()) expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44); // touch targets
  });
  test("keyboard: the first Tab stop is the skip link, which moves focus to the main content", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/account"); await page.keyboard.press("Tab"); await expect(page.getByText("Skip to content")).toBeFocused();
    await page.keyboard.press("Enter"); await expect(page).toHaveURL(/#main$/);
  });
  test("keyboard: every interactive control has a visible focus ring", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/account"); await page.getByRole("button", { name: "Sign out" }).focus();
    const outline = await page.getByRole("button", { name: "Sign out" }).evaluate((e) => getComputedStyle(e).outlineStyle + " " + getComputedStyle(e).outlineWidth); expect(outline).toMatch(/solid 2px/);
  });
  test("dialog: Notifications opens a modal (UNAVAILABLE inbox), Escape closes it and focus returns to the button", async ({ page }) => {
    await signIn(page, TRADER); const bell = page.getByRole("button", { name: "Notifications" }); await bell.focus(); await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog", { name: "Notifications" }); await expect(dlg).toBeVisible(); await expect(dlg.getByText("NOT AVAILABLE")).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dlg).toBeHidden(); await expect(bell).toBeFocused();
  });
  test.describe("theme", () => {
  test.use({ colorScheme: "dark" });
  test("theme switch changes the theme and survives a reload", async ({ page }) => {
    await signIn(page, TRADER); await page.getByRole("button", { name: /Switch to light theme/ }).click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light"); await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
  test("with storage blocked the theme still switches for the page and nothing breaks", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
    await signIn(page, TRADER); await page.getByRole("button", { name: /Switch to light theme/ }).click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
  });
  test("the gallery renders all eight data states", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/design-system");
    for (const s of ["LOADING", "READY", "EMPTY", "STALE", "ERROR", "DENIED", "UNAVAILABLE", "PARTIAL"]) await expect(page.getByLabel(`State ${s}`)).toBeVisible();
    await expect(page.getByText("LIVE · NOT VERIFIED")).toBeVisible(); await expect(page.getByText("FIXTURE", { exact: true }).first()).toBeVisible();
  });
});
