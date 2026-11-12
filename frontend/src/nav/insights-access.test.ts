import { describe, expect, it } from "vitest";
import { canView, findScreen, mobileNavFor, navFor, screensFor } from "./registry";

describe("Learning & Insights access (navigation only: the backend decides, and answers 404 to an administrator)", () => {
  const s = findScreen("/insights")!;
  it("is a private screen: a trader may view it, an administrator never sees it in navigation, and arrives in 09.3B.2", () => {
    expect(s.kind).toBe("private"); expect(s.permission).toBe("analytics:read"); expect(s.arrivesIn).toBe("09.3B.2");
    expect(canView("TRADER", s)).toBe(true); expect(canView("ADMIN", s)).toBe(false);
    expect(screensFor("ADMIN").some((x) => x.path === "/insights")).toBe(false); expect(navFor("ADMIN").flatMap((g) => g.items).some((x) => x.path === "/insights")).toBe(false);
    expect(mobileNavFor("ADMIN").some((m) => m.href === "/insights")).toBe(false);
  });
});
