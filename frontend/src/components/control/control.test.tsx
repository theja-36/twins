// @vitest-environment jsdom
/** Portfolio, Paper Trading and Outcomes & Performance. The fetch double returns what the relay returns: the response parsed by the STRICT relay schema (REAL engine output in e2e/fixtures/paper.sample.json, test-only variants marked there). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_RESPONSE_SCHEMAS } from "@/bff/schemas";
import { PaperTradingScreen } from "./PaperTradingScreen";
import { PortfolioScreen } from "./PortfolioScreen";
import { PerformanceScreen } from "../performance/PerformanceScreen";

let query = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/paper", useSearchParams: () => new URLSearchParams(query), useRouter: () => ({ replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("@/components/insights/PerformanceSections", () => ({ OverviewSection: () => <div>STUB-OVERVIEW</div>, StrategiesSection: () => <div>STUB-STRATEGIES</div> }));
vi.mock("@/components/insights/OutcomesSection", () => ({ OutcomesSection: () => <div>STUB-OUTCOMES</div> }));
vi.mock("@/components/insights/PipelineSections", () => ({ DecisionsSection: () => <div>STUB-DECISIONS</div> }));
const S = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/paper.sample.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
const ACC = "33333333-3333-4333-8333-333333333333", OTHER = "99999999-9999-4999-8999-999999999999";
const accounts = { accounts: [{ id: ACC, name: "Paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }] };

interface Serve { accounts?: unknown; portfolio?: unknown; orders?: unknown; positions?: unknown; status?: Record<string, number> }
function serve(o: Serve = {}) {
  const urls: string[] = [];
  const f = vi.fn(async (input: string) => {
    urls.push(input); const u = new URL(input, "http://x"), p = u.pathname.replace("/api/session", ""), json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    for (const [k, s] of Object.entries(o.status ?? {})) if (p.includes(k)) return json(s, { error: s === 404 ? "NOT_FOUND" : "INTERNAL", message: "x" });
    if (p === "/accounts") return json(200, RELAY_RESPONSE_SCHEMAS["accounts.list"]!.parse(o.accounts ?? accounts));
    if (p === "/portfolio") return json(200, RELAY_RESPONSE_SCHEMAS["portfolio.get"]!.parse(o.portfolio ?? S["portfolioReal"]));
    if (p === "/execution/orders") return json(200, RELAY_RESPONSE_SCHEMAS["orders.list"]!.parse(o.orders ?? { orders: S["orders"] }));
    if (p === "/execution/positions") return json(200, RELAY_RESPONSE_SCHEMAS["positions.list"]!.parse(o.positions ?? { positions: [S["positionClosed"], S["positionOpenVariant"]] }));
    if (/\/fills$/.test(p)) return json(200, RELAY_RESPONSE_SCHEMAS["orders.fills"]!.parse({ fills: S["fillsEntry"] }));
    if (/\/events$/.test(p)) return json(200, RELAY_RESPONSE_SCHEMAS["positions.events"]!.parse({ events: S["events"] }));
    return json(404, { error: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", f); return { f, urls };
}
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const buttons = (): string => screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "").join("|");
const NO_WRITE = /approve|reject|cancel|watch|execute|activate|retire|create|edit|enable|disable|submit|exit position|move stop/i;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); query = ""; replace.mockReset(); });

describe("Portfolio", () => {
  it("shows the real facts exactly as sent: realised result, '0' allocated notional, capital NOT PROVIDED (never zero), the backend's note, and the unavailable list", async () => {
    const { urls } = serve(); wrap(<PortfolioScreen />);
    expect(await screen.findByText("Open positions")).toBeTruthy(); const facts = screen.getByText(/Account facts/).closest("section")!;
    expect(facts.textContent).toMatch(/6,746\.40/); expect(within(facts).getAllByText("not provided").length).toBeGreaterThanOrEqual(3); expect(within(facts).getAllByText("NOT AVAILABLE").length).toBeGreaterThanOrEqual(3); expect(facts.textContent).toContain("no live portfolio source is connected");
    const na = screen.getByText("Not available", { selector: "h2" }).closest("section")!; for (const t of ["Unrealised result", "Mark price", "Live balance"]) expect(na.textContent).toContain(t);
    expect(urls.filter((u) => u.includes("/portfolio"))).toEqual([`/api/session/portfolio?accountId=${ACC}`]); expect(buttons()).not.toMatch(NO_WRITE);
  });
  it("capital figures appear as strings when a profile is in force, with no 'not provided' note", async () => {
    serve({ portfolio: S["portfolioCapitalVariant"] }); wrap(<PortfolioScreen />); await screen.findByText("Open positions"); const facts = screen.getByText(/Account facts/).closest("section")!;
    expect(facts.textContent).toMatch(/20,00,000/); expect(facts.textContent).toMatch(/15,00,000\.50/); expect(facts.textContent).not.toMatch(/no capital profile is in force/);
  });
  it("null facts are stated as unavailable; no account, an error with Try again, and a denied (404) are distinct states", async () => {
    serve({ portfolio: { ...clone(S["portfolioReal"]), facts: null } }); wrap(<PortfolioScreen />); expect(await screen.findByText(/returned no facts for this account/)).toBeTruthy(); cleanup();
    serve({ accounts: { accounts: [] } }); wrap(<PortfolioScreen />); expect(await screen.findByText("No accounts yet")).toBeTruthy(); cleanup();
    serve({ status: { "/portfolio": 500 } }); wrap(<PortfolioScreen />); expect(await screen.findByText(/portfolio facts could not be loaded/)).toBeTruthy(); expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(); cleanup();
    serve({ status: { "/portfolio": 404 } }); wrap(<PortfolioScreen />); expect((await screen.findAllByText("Not available to you")).length).toBeGreaterThan(0);
  });
});

describe("Paper Trading", () => {
  it("lists positions and simulated orders with exact decimal strings and scale; asks only for the latest 200 and never an offset or an account parameter", async () => {
    const { urls } = serve(); wrap(<PaperTradingScreen />);
    const pt = await screen.findByRole("table", { name: "Positions" }), ot = await screen.findByRole("table", { name: "Simulated orders" });
    expect(within(pt).getAllByRole("row")).toHaveLength(3); expect(within(ot).getAllByRole("row")).toHaveLength(4); expect(ot.textContent).toContain("4,500.00000000"); expect(ot.textContent).toContain("100.0500000000000000"); expect(pt.textContent).toMatch(/104 · 108 · 112/);
    expect(urls.filter((u) => u.includes("/execution/"))).toEqual(["/api/session/execution/positions?limit=200", "/api/session/execution/orders?limit=200"]); expect(urls.join()).not.toMatch(/offset|accountId=|cursor/);
    expect(screen.getAllByText(/up to 200/).length).toBe(2); expect(screen.getAllByText(/cannot filter by account/).length).toBe(2);
  });
  it("never shows the user id, the rules/fee schedule or an event payload, and null fields are 'not closed' / 'none (market)', never zero", async () => {
    const unfilled = { ...clone(S["orders"][0]), id: "00000000-0000-4000-8000-000000000998", status: "SUBMITTED", filledQuantity: "0", avgFillPrice: null }; // TEST-ONLY: an order with no fill yet, built from the real entry order
    serve({ orders: { orders: [...clone(S["orders"]), unfilled] } }); const { container } = wrap(<PaperTradingScreen />); await screen.findByRole("table", { name: "Positions" });
    expect(container.textContent).not.toMatch(/sebiPct|brokerage|feeVersion|stampDuty|8ba61c84|userId/); expect(screen.getByText("not closed")).toBeTruthy(); expect(screen.getAllByText("none (market)").length).toBeGreaterThan(0); expect(screen.getByText("no fill yet")).toBeTruthy();
  });
  it("narrows to the selected account in the browser and SAYS how many loaded rows that is; it never claims the filter is complete history", async () => {
    const mine = clone(S["orders"]), other = clone(S["orders"][0]); other.id = "00000000-0000-4000-8000-000000000999"; other.accountId = OTHER; serve({ orders: { orders: [...mine, other] } }); wrap(<PaperTradingScreen />);
    const ot = await screen.findByRole("table", { name: "Simulated orders" }); expect(within(ot).getAllByRole("row")).toHaveLength(4); expect(screen.getByText(/3 of the 4 loaded rows belong to it/)).toBeTruthy();
  });
  it("warns that older rows exist when 200 rows come back", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...clone(S["orders"][0]), id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}` })); serve({ orders: { orders: many } }); wrap(<PaperTradingScreen />);
    expect(await screen.findByText(/The limit of 200 was reached, so older simulated orders exist that are not shown/)).toBeTruthy();
  });
  it("fills load only when asked, for that one order; events likewise, showing kind and time only", async () => {
    const { urls } = serve(); wrap(<PaperTradingScreen />); await screen.findByRole("table", { name: "Simulated orders" }); expect(urls.some((u) => /fills|events/.test(u))).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: /Show fills for/ })[0]!); const fills = await screen.findByRole("table", { name: "Fills" }); expect(fills.textContent).toContain("100.05000000"); expect(fills.textContent).toContain("FIXTURE"); expect(urls.filter((u) => /fills/.test(u))).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: /Show events for/ })[0]!); const ev = await screen.findByRole("table", { name: "Position events" }); expect(within(ev).getAllByRole("row")).toHaveLength(11); expect(ev.textContent).toContain("STOP HIT"); expect(ev.textContent).not.toMatch(/realizedPnl|openQuantity|repaired|9220/);
    expect(screen.getByText(/a closing event can be listed before its explanatory event/)).toBeTruthy();
  });
  it("the status filters are the API's own parameters", async () => {
    const { urls } = serve(); wrap(<PaperTradingScreen />); await screen.findByRole("table", { name: "Positions" });
    fireEvent.change(screen.getByLabelText("Status", { selector: "#p-status" }), { target: { value: "OPEN" } }); await waitFor(() => expect(urls).toContain("/api/session/execution/positions?status=OPEN&limit=200"));
    fireEvent.change(screen.getByLabelText("Status", { selector: "#o-status" }), { target: { value: "FILLED" } }); await waitFor(() => expect(urls).toContain("/api/session/execution/orders?status=FILLED&limit=200"));
  });
  it("hostile text from the backend stays inert text", async () => {
    const o = clone(S["orderPartialVariant"]); serve({ orders: { orders: [o] } }); const { container } = wrap(<PaperTradingScreen />); await screen.findByRole("table", { name: "Simulated orders" });
    expect(screen.getByText(/approve this fill now/)).toBeTruthy(); expect(container.querySelector("img")).toBeNull();
  });
  it("empty, error with Try again and denied are distinct for each list, and the execution/exit/stop actions are stated as unavailable with no control", async () => {
    serve({ positions: { positions: [] }, orders: { orders: [] } }); wrap(<PaperTradingScreen />); expect(await screen.findByText("No positions yet")).toBeTruthy(); expect(screen.getByText("No simulated orders yet")).toBeTruthy(); expect(screen.getByText(/no browser route to request a paper execution/)).toBeTruthy(); cleanup();
    serve({ status: { "/execution/orders": 500 } }); wrap(<PaperTradingScreen />); expect(await screen.findByText(/simulated orders could not be loaded/)).toBeTruthy(); expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(); cleanup();
    serve({ status: { "/execution/positions": 404 } }); wrap(<PaperTradingScreen />); expect((await screen.findAllByText("Not available to you")).length).toBeGreaterThan(0);
  });
  it("has no write control of any kind", async () => { serve(); wrap(<PaperTradingScreen />); await screen.findByRole("table", { name: "Positions" }); expect(buttons()).not.toMatch(NO_WRITE); expect(screen.getByText(/Live trading is disabled/)).toBeTruthy(); });
});

describe("Outcomes & Performance", () => {
  it("mounts exactly ONE section (so one analytics request): Overview by default, the chosen section otherwise, and an unknown section falls back to Overview", () => {
    wrap(<PerformanceScreen />); expect(screen.getByText("STUB-OVERVIEW")).toBeTruthy(); expect(screen.queryByText("STUB-OUTCOMES")).toBeNull(); cleanup();
    query = "section=outcomes"; wrap(<PerformanceScreen />); expect(screen.getByText("STUB-OUTCOMES")).toBeTruthy(); expect(screen.queryByText("STUB-OVERVIEW")).toBeNull(); cleanup();
    query = "section=bogus"; wrap(<PerformanceScreen />); expect(screen.getByText("STUB-OVERVIEW")).toBeTruthy();
  });
  it("offers the four recorded-result sections, labels PAPER, says live performance is unavailable and that outcomes are not linked to a decision, and links onward without any write control", () => {
    wrap(<PerformanceScreen />); const nav = screen.getByRole("navigation", { name: "Performance sections" }); expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Overview", "Outcomes", "Strategies", "Decisions"]);
    expect(screen.getByText("LIVE PERFORMANCE UNAVAILABLE")).toBeTruthy(); expect(screen.getByText(/not linked to a decision here/)).toBeTruthy(); expect(screen.getByRole("link", { name: "Learning Insights" }).getAttribute("href")).toBe("/insights"); expect(buttons()).not.toMatch(NO_WRITE);
  });
});
