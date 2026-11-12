import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, PRIVATE_PERMISSIONS, roleHasPermission } from "@twins/api-contracts";
import { SCREENS, WORKSPACES, breadcrumbFor, canView, findScreen, landingFor, mobileNavFor, navFor, screensFor } from "./registry";

describe("screen registry", () => {
  it("has the documented screens with unique ids and paths, each with a purpose, and permissions that exist", () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length); expect(new Set(SCREENS.map((s) => s.path)).size).toBe(SCREENS.length);
    expect(SCREENS.map((s) => s.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]); // 4 (detail) is a sub-screen of Opportunities
    for (const s of SCREENS) { expect(s.purpose.length).toBeGreaterThan(20); if (s.permission) expect(ALL_PERMISSIONS).toContain(s.permission); }
  });
  it("ADMIN never sees a private screen: only shared intelligence, administration and the account", () => {
    const admin = screensFor("ADMIN"); expect(admin.map((s) => s.title).sort()).toEqual(["Account", "Market Intelligence", "Opportunities", "Platform overview", "Research", "Users & Access"].sort());
    for (const s of admin) { expect(s.kind).not.toBe("private"); if (s.permission && s.kind === "shared") expect(roleHasPermission("ADMIN", s.permission)).toBe(true); }
    for (const s of SCREENS.filter((x) => x.kind === "private")) { expect(canView("ADMIN", s), s.title).toBe(false); if (s.permission) expect(PRIVATE_PERMISSIONS as readonly string[]).toContain(s.permission); }
  });
  it("TRADER sees every private and shared screen and no administration screen", () => {
    const t = screensFor("TRADER"); expect(t.some((s) => s.kind === "admin")).toBe(false); expect(t.length).toBe(SCREENS.filter((s) => s.kind !== "admin").length);
    expect(canView("TRADER", findScreen("/admin/system")!)).toBe(false); expect(canView("TRADER", findScreen("/admin/users")!)).toBe(false);
  });
  it("landing pages: TRADER -> Overview, ADMIN -> Platform overview", () => { expect(landingFor("TRADER")).toBe("/"); expect(landingFor("ADMIN")).toBe("/admin/system"); });
  it("navigation groups follow the documented workspaces; ADMIN has only UNDERSTAND and OPERATE besides home", () => {
    expect(navFor("TRADER").map((g) => g.workspace)).toEqual([null, ...WORKSPACES]);
    expect(navFor("ADMIN").map((g) => g.workspace)).toEqual([null, "UNDERSTAND", "OPERATE"]);
    expect(navFor("TRADER")[0]!.items[0]!.title).toBe("Overview"); expect(navFor("ADMIN")[0]!.items[0]!.title).toBe("Platform overview");
  });
  it("mobile bottom navigation: five items for a TRADER, three for an ADMIN, none leading to a screen the role cannot view", () => {
    const t = mobileNavFor("TRADER"), a = mobileNavFor("ADMIN"); expect(t.map((m) => m.label)).toEqual(["Desk", "Decide", "Understand", "Control", "Review"]); expect(a.map((m) => m.label)).toEqual(["Platform", "Understand", "Operate"]);
    for (const [role, items] of [["TRADER", t], ["ADMIN", a]] as const) for (const m of items) expect(canView(role, findScreen(m.href)!), `${role} ${m.href}`).toBe(true);
  });
  it("every screen that has a backend gap says so (UNAVAILABLE text present)", () => { for (const id of [2, 6, 8, 9, 10, 13, 14]) expect(SCREENS.find((s) => s.id === id)?.gap, String(id)).toBeTruthy(); });
  it("breadcrumbs name the workspace and the screen; unknown paths say so", () => { expect(breadcrumbFor("/paper")).toEqual([{ label: "Control" }, { label: "Paper Trading" }]); expect(breadcrumbFor("/")).toEqual([{ label: "Overview" }]); expect(breadcrumbFor("/nope")).toEqual([{ label: "Not found" }]); expect(breadcrumbFor("/design-system")).toEqual([{ label: "Design system" }]); expect(breadcrumbFor("/opportunities", "ADMIN")).toEqual([{ label: "Understand" }, { label: "Opportunities" }]); });
});
