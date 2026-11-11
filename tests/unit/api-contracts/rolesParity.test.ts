/** The mirrored role -> permission table equals the backend's own authorisation model, and ADMIN never holds a private permission. */
import { describe, expect, it } from "vitest";
import { ADMIN_PERMISSIONS as B_ADMIN, PRIVATE_PERMISSIONS as B_PRIVATE, SHARED_PERMISSIONS as B_SHARED, PlatformError, authorize, hasPermission, isPrivatePermission as bPrivate, type Principal } from "../../../packages/types/src/index";
import { ADMIN_PERMISSIONS, ALL_PERMISSIONS, PRIVATE_PERMISSIONS, ROLES, ROLE_PERMISSIONS, SHARED_PERMISSIONS, isPrivatePermission, roleHasPermission } from "../../../packages/api-contracts/src/index";

const principal = (role: "TRADER" | "ADMIN"): Principal => ({ kind: "user", userId: "u1" as never, roles: [role] });

describe("role-permission parity with packages/types/src/platform/auth.ts", () => {
  it("the permission lists equal the backend lists (same members, same order)", () => {
    expect([...SHARED_PERMISSIONS]).toEqual([...B_SHARED]); expect([...PRIVATE_PERMISSIONS]).toEqual([...B_PRIVATE]); expect([...ADMIN_PERMISSIONS]).toEqual([...B_ADMIN]);
  });
  it("for every role and every permission, the mirror agrees with the backend's hasPermission", () => {
    for (const role of ROLES) for (const p of ALL_PERMISSIONS) expect(roleHasPermission(role, p), `${role} ${p}`).toBe(hasPermission(principal(role), p));
    for (const p of ALL_PERMISSIONS) expect(isPrivatePermission(p), p).toBe(bPrivate(p));
  });
  it("ADMIN holds NO private permission; TRADER holds NO admin permission; both hold every shared permission", () => {
    for (const p of PRIVATE_PERMISSIONS) expect(ROLE_PERMISSIONS.ADMIN.includes(p), `ADMIN ${p}`).toBe(false);
    for (const p of ADMIN_PERMISSIONS) expect(ROLE_PERMISSIONS.TRADER.includes(p), `TRADER ${p}`).toBe(false);
    for (const p of SHARED_PERMISSIONS) { expect(ROLE_PERMISSIONS.ADMIN).toContain(p); expect(ROLE_PERMISSIONS.TRADER).toContain(p); }
  });
  it("the backend answers NOT_FOUND (never FORBIDDEN) when an ADMIN calls any private permission, even for their own id", () => {
    for (const p of PRIVATE_PERMISSIONS) { let code = ""; try { authorize(principal("ADMIN"), p, "u1" as never); } catch (e) { code = e instanceof PlatformError ? e.code : "OTHER"; } expect(code, p).toBe("NOT_FOUND"); }
  });
});
