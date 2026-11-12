// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@twins/api-contracts";
import { violations } from "@/test/axe";
import { ADMIN, USER } from "@/test/helpers";

let path = "/";
vi.mock("next/navigation", () => ({ usePathname: () => path, useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const accounts = { data: { accounts: [{ id: "a1", name: "paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }] }, isLoading: false, error: null, refetch: vi.fn() };
let me: PublicUser = USER;
vi.mock("@/api/hooks", () => ({ useSession: () => me, useAccounts: () => accounts, signOut: vi.fn() }));
import { Shell } from "./Shell";

afterEach(cleanup);
beforeAll(() => { HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); }; });
const view = (u: PublicUser, p = "/") => { me = u; path = p; return render(<QueryClientProvider client={new QueryClient()}><Shell initialUser={u}><h1>Page</h1></Shell></QueryClientProvider>); };
const railLinks = () => within(screen.getByRole("complementary", { name: "Primary" })).getAllByRole("link").map((a) => a.textContent?.trim());

describe("application shell: role-specific navigation", () => {
  it("TRADER: five workspaces, every working screen, account selector, Trader chip", () => {
    view(USER); const links = railLinks();
    for (const t of ["Overview", "Approval Center", "Opportunities", "Research", "Market Intelligence", "Learning Insights", "Capital & Risk", "Paper Trading", "Portfolio", "Decision History", "Outcomes & Performance", "Account"]) expect(links, t).toContain(t);
    expect(links).not.toContain("Platform overview"); expect(links).not.toContain("Users & Access");
    for (const w of ["DECIDE", "UNDERSTAND", "CONTROL", "REVIEW", "OPERATE"]) expect(screen.getByText(w)).toBeTruthy();
    expect(screen.getByTestId("role-chip").textContent).toBe("Trader"); expect(screen.getByTestId("account-single").textContent).toContain("paper account"); expect(document.documentElement.dataset["role"]).toBe("trader");
  });
  it("ADMIN: no private screen, no account selector, Administrator chip and the console label", () => {
    view(ADMIN, "/admin/system"); const links = railLinks();
    expect(links.sort()).toEqual(["Account", "Market Intelligence", "Opportunities", "Platform overview", "Playbooks", "Research", "Users & Access"].sort());
    for (const p of ["Approval Center", "Paper Trading", "Portfolio", "Capital & Risk", "Learning Insights", "Decision History", "Outcomes & Performance", "Overview"]) expect(links, p).not.toContain(p);
    expect(screen.queryByTestId("account-single")).toBeNull(); expect(screen.queryByRole("combobox")).toBeNull(); expect(screen.getByTestId("role-chip").textContent).toBe("Administrator"); expect(screen.getByText("Administration console")).toBeTruthy(); expect(document.documentElement.dataset["role"]).toBe("admin");
  });
  it("mobile bottom navigation differs by role", () => {
    view(USER); expect(within(screen.getByRole("navigation", { name: "Workspaces" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Desk", "Decide", "Understand", "Control", "Review"]); cleanup();
    view(ADMIN, "/admin/system"); expect(within(screen.getByRole("navigation", { name: "Workspaces" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Platform", "Understand", "Operate"]);
  });
  it("the current page is marked, breadcrumbs name workspace and screen", () => {
    view(USER, "/paper"); expect(screen.getAllByRole("link", { name: /Paper Trading/ }).some((a) => a.getAttribute("aria-current") === "page")).toBe(true);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getAllByRole("listitem").map((l) => l.textContent); expect(crumbs).toEqual(["Control", "Paper Trading"]);
  });
  it("states the safety posture on every page and offers a skip link, a main landmark and notifications as UNAVAILABLE", () => {
    view(USER); expect(screen.getByText(/Paper trading only\./)).toBeTruthy(); expect(screen.getByText("Skip to content").getAttribute("href")).toBe("#main"); expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  });
  for (const [name, u, p] of [["TRADER", USER, "/"], ["ADMIN", ADMIN, "/admin/system"]] as const) it(`${name} shell has no structural accessibility violations (axe)`, async () => { const { container } = view(u, p); expect(await violations(container)).toEqual([]); });
});
