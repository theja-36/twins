import { test as base, expect, type Page } from "@playwright/test";

export const STUB = "http://127.0.0.1:4010";
export const TRADER = { email: "trader@example.test", password: "trader-pass-123" };
export const ADMIN = { email: "admin@example.test", password: "admin-pass-123" };
let n = 0;
/** Every test gets its own client address (the BFF throttles per source), so tests never throttle each other. */
export const test = base.extend({
  context: async ({ browser }, use) => { n += 1; const c = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${(n % 250) + 1}` } }); await use(c); await c.close(); },
  page: async ({ context }, use) => { await use(await context.newPage()); },
});
export { expect };
export async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto("/login"); await page.getByLabel("Email").fill(who.email); await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}
export async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> { await page.addInitScript((t) => { try { localStorage.setItem("twins-theme", t); } catch { /* storage blocked */ } }, theme); }
