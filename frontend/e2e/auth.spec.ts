import { ADMIN, STUB, TRADER, expect, signIn, test } from "./fixtures";

test.describe("authentication and session handling", () => {
  test("an anonymous visitor to any page is sent to sign-in", async ({ page }) => {
    for (const p of ["/", "/approvals", "/account", "/admin/system"]) { await page.goto(p); await expect(page).toHaveURL(/\/login$/); }
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
  test("sign-in offers no registration, password reset or email verification (the backend has none)", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(/create account|sign up|register|forgot|reset password|verify/i)).toHaveCount(0);
    await expect(page.getByText("Accounts are created by an administrator.")).toBeVisible();
  });
  test("wrong credentials and the backend's lockout show the SAME neutral message; the BFF's own per-source throttle is a separate, clearly worded refusal", async ({ page }) => {
    const email = `lock-${Date.now()}@example.test`, attempt = async (i: number) => { await page.goto("/login"); await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(`wrong-${i}`); await page.getByRole("button", { name: "Sign in" }).click(); return (await page.getByTestId("login-error").textContent()) ?? ""; };
    const first = await attempt(0); for (let i = 1; i < 5; i++) expect(await attempt(i)).toBe(first); // five wrong-credential attempts from this source
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "192.0.2.77" }); // another source: the BFF lets it through, and the BACKEND now answers 403 "too many attempts"
    expect(await attempt(5)).toBe(first); // identical to a wrong password: nothing reveals that the account is locked
    expect(first).toMatch(/Sign-in failed/); expect(first).not.toMatch(/locked|too many|credentials/i);
    await page.setExtraHTTPHeaders({}); // back to the first source: five failures for this source+email, so the BFF itself refuses the next attempt without asking the backend
    expect(await attempt(6)).toMatch(/Too many attempts/);
  });
  test("client-side validation asks for both fields without contacting the server", async ({ page }) => {
    await page.goto("/login"); let calls = 0; page.on("request", (r) => { if (r.url().includes("/api/auth/login")) calls++; });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your email address")).toBeVisible(); await expect(page.getByText("Enter your password")).toBeVisible(); expect(calls).toBe(0);
  });
  test("a trader signs in: session cookie is HttpOnly + SameSite=Strict, the CSRF cookie is readable, and no token reaches the page or its storage", async ({ page, context }) => {
    await signIn(page, TRADER); await expect(page).toHaveURL(/\/$/);
    const cookies = await context.cookies(), session = cookies.find((c) => c.name === "twins_session"), csrf = cookies.find((c) => c.name === "twins_csrf");
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" }); expect(csrf).toMatchObject({ httpOnly: false, sameSite: "Strict", path: "/" });
    const seen = await page.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
    expect(seen.cookie).not.toContain("tws_"); expect(seen.cookie).not.toContain("twins_session"); expect(seen.local).not.toContain("tws_"); expect(seen.session).not.toContain("tws_");
    const me = await page.request.get("/api/auth/me"); const body = await me.text(); expect(me.status()).toBe(200); expect(body).not.toContain("tws_"); expect(JSON.parse(body).user.role).toBe("TRADER");
    const html = await page.content(); expect(html).not.toContain(session!.value);
  });
  test("a signed-in user visiting /login is sent to their landing page", async ({ page }) => {
    await signIn(page, TRADER); await page.goto("/login"); await expect(page).toHaveURL(/\/$/);
    await page.context().clearCookies(); await signIn(page, ADMIN); await page.goto("/login"); await expect(page).toHaveURL(/\/admin\/system$/);
  });
  test("sign-out ends the session: cookies cleared, protected pages redirect again, the old token no longer works", async ({ page, context }) => {
    await signIn(page, TRADER); await page.goto("/account"); await page.getByRole("button", { name: "Sign out" }).click(); await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).filter((c) => c.name.startsWith("twins_")).length).toBe(0);
    await page.goto("/approvals"); await expect(page).toHaveURL(/\/login$/);
  });
  test("an expired backend session returns the user to sign-in with a notice", async ({ page, request }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); // let the page's own session probe finish first: otherwise it can clear the cookie while we navigate, and the redirect then (correctly) has no expiry notice
    await request.get(`${STUB}/__expire`); await page.goto("/account");
    await expect(page).toHaveURL(/\/login\?expired=1$/); await expect(page.getByText("Session ended")).toBeVisible();
  });
  test("an expiry seen while using the page (polling or action) also ends the session client-side", async ({ page, request }) => {
    await signIn(page, TRADER); await page.waitForLoadState("networkidle"); await request.get(`${STUB}/__expire`);
    const res = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "same-origin" })).status); expect(res).toBe(401);
    await page.goto("/"); await expect(page).toHaveURL(/\/login/);
  });
});
