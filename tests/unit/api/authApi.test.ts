import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";

const PW = "correct horse battery staple";
function build(registrationOpen = true) {
  const store = memoryAuthStore(), events: string[] = [];
  const auth = new AuthService({ store, audit: async (e) => { events.push(e.type); }, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen } });
  const app = Fastify(); registerAuthRoutes(app, { auth });
  const call = (method: "GET" | "POST", url: string, body?: unknown, token?: string) => app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, store, auth, call, events };
}
async function admin(b: ReturnType<typeof build>) {
  const a = await b.auth.bootstrapAdmin({ email: "root@example.com", password: PW });
  const r = (await b.call("POST", "/auth/login", { email: "root@example.com", password: PW })).json();
  return { id: a.id, token: r.token as string };
}

describe("auth routes", () => {
  it("register -> login -> me -> logout, and the token stops working", async () => {
    const b = build();
    expect((await b.call("POST", "/auth/register", { email: "a@example.com", password: PW })).statusCode).toBe(201);
    const login = (await b.call("POST", "/auth/login", { email: "a@example.com", password: PW })).json();
    expect(login.token).toMatch(/^tws_/);
    const me = await b.call("GET", "/auth/me", undefined, login.token);
    expect(me.statusCode).toBe(200); expect(me.json().user).toMatchObject({ email: "a@example.com", role: "TRADER" });
    expect(me.body).not.toMatch(/hash|scrypt|password/i);
    expect((await b.call("POST", "/auth/logout", undefined, login.token)).statusCode).toBe(204);
    expect((await b.call("GET", "/auth/me", undefined, login.token)).statusCode).toBe(401);
  });
  it("a role, isAdmin or isActive field is REFUSED on registration, login and password change (G-13)", async () => {
    const b = build();
    for (const extra of [{ role: "ADMIN" }, { isAdmin: true }, { isActive: true }, { roles: ["ADMIN"] }]) {
      const r = await b.call("POST", "/auth/register", { email: "x@example.com", password: PW, ...extra });
      expect(r.statusCode, JSON.stringify(extra)).toBe(422); expect(r.json().error).toBe("VALIDATION");
    }
    expect(b.store.users.size).toBe(0);
    await b.call("POST", "/auth/register", { email: "a@example.com", password: PW });
    expect((await b.call("POST", "/auth/login", { email: "a@example.com", password: PW, role: "ADMIN" })).statusCode).toBe(422);
    const t = (await b.call("POST", "/auth/login", { email: "a@example.com", password: PW })).json().token;
    expect((await b.call("POST", "/auth/change-password", { currentPassword: PW, newPassword: "another long password 1", role: "ADMIN" }, t)).statusCode).toBe(422);
  });
  it("registration is closed by default", async () => { expect((await build(false).call("POST", "/auth/register", { email: "a@example.com", password: PW })).statusCode).toBe(403); });
  it("login failures are one generic answer; a malformed body is a validation error", async () => {
    const b = build(); await b.call("POST", "/auth/register", { email: "a@example.com", password: PW });
    const a = await b.call("POST", "/auth/login", { email: "a@example.com", password: "wrong-password-123" }), c = await b.call("POST", "/auth/login", { email: "ghost@example.com", password: "wrong-password-123" });
    expect(a.statusCode).toBe(401); expect(a.body).toBe(c.body);
    expect((await b.call("POST", "/auth/login", "nope")).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("the shared service API key and other bearer values are never a user session", async () => {
    const b = build();
    for (const t of ["test-api-key-default", "tws_short", ""]) expect((await b.call("GET", "/auth/me", undefined, t)).statusCode).toBe(401);
    expect((await b.call("GET", "/auth/me")).statusCode).toBe(401);
  });
  it("admin routes: anonymous 401, TRADER 403, ADMIN allowed", async () => {
    const b = build(); const ad = await admin(b);
    await b.call("POST", "/auth/register", { email: "t@example.com", password: PW });
    const tt = (await b.call("POST", "/auth/login", { email: "t@example.com", password: PW })).json().token as string;
    expect((await b.call("POST", "/admin/users", { email: "n@example.com", password: PW })).statusCode).toBe(401);
    expect((await b.call("POST", "/admin/users", { email: "n@example.com", password: PW }, tt)).statusCode).toBe(403);
    expect((await b.call("POST", "/admin/users", { email: "n@example.com", password: PW }, ad.token)).statusCode).toBe(201);
    const tid = [...b.store.users.values()].find((u) => u.email === "t@example.com")!.id;
    expect((await b.call("POST", `/admin/users/${tid}/role`, { role: "ADMIN" }, tt)).statusCode).toBe(403);   // a trader cannot promote themselves
    expect((await b.call("POST", `/admin/users/${ad.id}/role`, { role: "TRADER" }, tt)).statusCode).toBe(403);
    expect(b.store.users.get(tid)!.role).toBe("TRADER");
  });
  it("an ADMIN can change another user's role and active state; self-change and bad input are refused", async () => {
    const b = build(); const ad = await admin(b);
    await b.call("POST", "/auth/register", { email: "t@example.com", password: PW });
    const tid = [...b.store.users.values()].find((u) => u.email === "t@example.com")!.id;
    expect((await b.call("POST", `/admin/users/${tid}/role`, { role: "ADMIN" }, ad.token)).statusCode).toBe(204);
    expect(b.store.users.get(tid)!.role).toBe("ADMIN");
    expect((await b.call("POST", `/admin/users/${ad.id}/role`, { role: "TRADER" }, ad.token)).statusCode).toBe(403);
    expect((await b.call("POST", `/admin/users/${tid}/role`, { role: "SUPERUSER" }, ad.token)).statusCode).toBe(422);
    expect((await b.call("POST", `/admin/users/not-a-uuid/role`, { role: "TRADER" }, ad.token)).statusCode).toBe(422);
    expect((await b.call("POST", `/admin/users/${tid}/active`, { active: "no" }, ad.token)).statusCode).toBe(422);
    expect((await b.call("POST", `/admin/users/${tid}/active`, { active: false }, ad.token)).statusCode).toBe(204);
    expect(b.store.users.get(tid)!.isActive).toBe(false);
  });
  it("errors never echo secrets or driver text", async () => {
    const b = build(); const r = await b.call("POST", "/auth/register", { email: "a@example.com", password: "short" });
    expect(r.statusCode).toBe(422); expect(r.body).not.toContain("short"); expect(Object.keys(r.json()).sort()).toEqual(["error", "message", "reasons"]);
  });
});

describe("migration 0040 and the runtime grants (G-13)", () => {
  const sql = readFileSync("packages/database/drizzle/0040_auth_security.sql", "utf8"), role = readFileSync("infrastructure/staging/app-role.sql", "utf8");
  it("refuses role / active changes and privileged inserts outside the doors, and the doors check actor, self and last admin", () => {
    expect(sql).toContain("users_privilege_guard_update"); expect(sql).toContain("users_privilege_guard_insert");
    expect(sql).toMatch(/twins_set_user_role[\s\S]*p_actor = p_target[\s\S]*<= 1/); expect(sql).toMatch(/twins_set_user_active[\s\S]*p_actor = p_target[\s\S]*<= 1/);
    expect(sql).toMatch(/twins_create_user[\s\S]*an administrator already exists/);
  });
  it("the runtime role has no INSERT/UPDATE on users beyond password and display name, and may execute the doors", () => {
    expect(role).toMatch(/'users'\];/); expect(role).toContain("GRANT UPDATE (password_hash, display_name, updated_at) ON users");
    expect(role).toContain("twins_set_user_role(uuid, uuid, text)"); expect(role).not.toMatch(/GRANT[^;]*\(role[^)]*\) ON users/);
  });
});
