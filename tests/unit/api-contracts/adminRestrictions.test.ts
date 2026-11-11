/** ADMIN restrictions (verified model): an ADMIN session reaches NO private route and NO private data; the backend answers 404 and the data layer is never touched. */
import { describe, expect, it } from "vitest";
import { ANALYTICS_ROUTES, PRIVATE_ROUTES, ROLE_PERMISSIONS, SHARED_ROUTES, roleHasPermission } from "../../../packages/api-contracts/src/index";
import { ACCOUNT, DECISION, build } from "../../support/contractHarness";

const url = (p: string, req: readonly string[]): string => p.replace(/:id/g, DECISION) + (req.length ? `?${req.map((n) => `${n}=${ACCOUNT}`).join("&")}` : "");

describe("ADMIN cannot reach private trader routes", () => {
  it("every private and analytics route answers 404 NOT_FOUND to an ADMIN session, and the data layer is never called", async () => {
    const h = await build(), a = await h.admin();
    for (const e of [...PRIVATE_ROUTES, ...ANALYTICS_ROUTES]) {
      const res = await h.call(e.method, url(e.path, e.query.required), a.token, e.method === "POST" ? { idempotencyKey: "key-0000001", reason: "a valid reason" } : undefined);
      expect(res.statusCode, `${e.method} ${e.path}`).toBe(404);
      const body = res.json() as Record<string, unknown>; expect(body["error"], e.path).toBe("NOT_FOUND"); expect(Object.keys(body).sort()).toEqual(["error", "message", "reasons"]); // not an approval-error body either
    }
    expect(h.seen).toEqual([]); // no private data function ran for the ADMIN
  });
  it("the same routes DO answer a TRADER (so the 404 is the role, not a broken route)", async () => {
    const h = await build(), t = await h.trader();
    for (const e of PRIVATE_ROUTES.filter((x) => x.method === "GET")) expect((await h.call("GET", url(e.path, e.query.required), t.token)).statusCode, e.path).toBe(200);
  });
  it("an ADMIN is not a super-trader in the mirror either: no private permission, shared + admin only", () => {
    for (const e of [...PRIVATE_ROUTES, ...ANALYTICS_ROUTES]) expect(roleHasPermission("ADMIN", e.permission ?? "system:read"), e.id).toBe(false);
    for (const e of SHARED_ROUTES) expect(roleHasPermission("ADMIN", e.permission ?? "signals:read"), e.id).toBe(true);
    expect(ROLE_PERMISSIONS.ADMIN.length).toBe(10);
  });
  it("an ADMIN session still reads its own identity; a TRADER cannot use ADMIN-role routes", async () => {
    const h = await build(), a = await h.admin(), t = await h.trader();
    const me = (await h.call("GET", "/auth/me", a.token)).json() as { user: { role: string } }; expect(me.user.role).toBe("ADMIN");
    expect((await h.call("POST", "/admin/users", t.token, { email: "x@example.com", password: "another long password 1" })).statusCode).toBe(403);
  });
});
