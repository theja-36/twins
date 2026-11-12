// @vitest-environment jsdom
/**
 * Learning & Insights behaviour against a REAL-OUTPUT sample (e2e/fixtures/analytics.sample.json: synthetic FIXTURE data from the Stage 09.3B.1 harness, TEST-ONLY).
 * The browser reads through the relay, so the fetch double returns what the relay would: the response parsed by the strict relay schema.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_RELAY_SCHEMAS } from "@/bff/schemas.insights";
import { ANALYTICS_QUERY } from "@/api/analyticsHooks";
import { InsightsScreen, SECTIONS } from "./InsightsScreen";
import { OverviewSection, StrategiesSection } from "./PerformanceSections";
import { OutcomesSection } from "./OutcomesSection";
import { InsightsSection } from "./InsightsSection";
import { FixtureLabel } from "./shared";

let section = "overview";
vi.mock("next/navigation", () => ({ usePathname: () => "/insights", useSearchParams: () => new URLSearchParams(section === "overview" ? "" : `section=${section}`), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const sample = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/analytics.sample.json"), "utf8")) as Record<string, Record<string, unknown>>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mut = (name: string, body: Record<string, unknown>) => Record<string, unknown> | { status: number; error: string };
function serve(mut: Mut = (_n, b) => b) {
  const urls: string[] = [];
  const f = vi.fn(async (input: string) => {
    urls.push(input); const u = new URL(input, "http://x"), name = u.pathname.replace("/api/session/analytics/", ""), base = sample[name];
    if (!base) return new Response(JSON.stringify({ error: "NOT_FOUND", message: "not found" }), { status: 404 });
    const m = mut(name, clone(base)); if ("status" in m && "error" in m && typeof m["status"] === "number") return new Response(JSON.stringify({ error: m["error"], message: "x" }), { status: m["status"] as number });
    const schema = ANALYTICS_RELAY_SCHEMAS[`analytics.${name}` as keyof typeof ANALYTICS_RELAY_SCHEMAS]; return new Response(JSON.stringify(schema.parse(m)), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", f); return { f, urls };
}
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); section = "overview"; });

describe("overview: provenance, fixture labelling and honest numbers", () => {
  it("states PAPER, dataset, LIVE ANALYTICS UNAVAILABLE and FIXTURE-BACKED DATA, with the snapshot facts", async () => {
    serve(); wrap(<OverviewSection />);
    expect(await screen.findByText("DATASET PAPER")).toBeTruthy(); expect(screen.getAllByText("LIVE ANALYTICS UNAVAILABLE").length).toBeGreaterThan(0); expect(screen.getAllByText("PAPER").length).toBeGreaterThan(0);
    expect(screen.getAllByText("FIXTURE-BACKED DATA").length).toBeGreaterThan(0); expect(screen.getByText(/analytics-contract-v1/)).toBeTruthy(); expect(screen.getByText(/may be generated or refreshed by a read request/)).toBeTruthy();
  });
  it("keeps the exact decimal string (no float rounding) and shows unavailable metrics as Not computed, never zero", async () => {
    serve(); wrap(<OverviewSection />); await screen.findByText("DATASET PAPER");
    expect(screen.getAllByText(/6,172\.18/).length).toBeGreaterThan(0); expect(screen.queryByText(/6,172\.2\b/)).toBeNull(); // 6172.18 stays 6172.18
    const card = screen.getByRole("group", { name: "Expectancy (R)" }); expect(within(card).getByText("Not computed")).toBeTruthy(); expect(within(card).getByText(/fewer than 30 eligible outcomes/)).toBeTruthy(); expect(within(card).getByText(/n =/)).toBeTruthy();
    expect(screen.getByText(/percentage drawdown needs an account equity curve/)).toBeTruthy(); expect(screen.getAllByText("NOT AVAILABLE").length).toBeGreaterThan(0);
  });
  it("the validated-only group has no eligible outcomes: it says so instead of showing zeros", async () => {
    serve(); wrap(<OverviewSection />); await screen.findByText("DATASET PAPER"); fireEvent.click(screen.getByRole("button", { name: /Validated only/ }));
    expect(await screen.findByText("No eligible outcomes in this group")).toBeTruthy(); expect(screen.getByText(/it is never live-market performance/)).toBeTruthy(); expect(screen.queryByRole("group", { name: "Win rate" })).toBeNull();
  });
  it("shows the backend's confidence interval when one is supplied", async () => {
    serve((n, b) => { if (n === "overview") { const m = (b["data"] as Record<string, { winRate: { interval: unknown } }>)["fixtureOnly"]!; m.winRate.interval = { lower: 0.206543, upper: 1 }; } return b; });
    wrap(<OverviewSection />); await screen.findByText("DATASET PAPER"); fireEvent.click(screen.getByRole("button", { name: /Fixture-backed only/ })); expect(within(screen.getByRole("group", { name: "Win rate" })).getByText(/95% interval/)).toBeTruthy();
  });
});

describe("the eight data states", () => {
  it("STALE: the stale badge, the reason, and the data still shown", async () => {
    serve((n, b) => { if (n === "overview") { b["freshness"] = "STALE"; (b["snapshot"] as Record<string, unknown>)["freshness"] = "STALE"; (b["snapshot"] as Record<string, unknown>)["staleReason"] = "the current evidence could not be analysed; this is the newest stored snapshot"; } return b; });
    wrap(<OverviewSection />); expect((await screen.findAllByText(/the current evidence could not be analysed/)).length).toBeGreaterThan(0); expect(screen.getAllByText("STALE").length).toBeGreaterThan(0); expect(screen.getByRole("group", { name: "Win rate" })).toBeTruthy();
  });
  it("PARTIAL: a partial-evidence notice with the data shown", async () => {
    serve((n, b) => { if (n === "overview") b["state"] = "PARTIAL"; return b; }); wrap(<OverviewSection />);
    expect((await screen.findAllByText(/PARTIAL/)).length).toBeGreaterThan(0); expect(screen.getByText(/Some evidence behind these figures is incomplete/)).toBeTruthy(); expect(screen.getByRole("group", { name: "Win rate" })).toBeTruthy();
  });
  it("EMPTY: explains and shows no metric", async () => {
    serve((n, b) => { if (n === "overview") b["state"] = "EMPTY"; return b; }); wrap(<OverviewSection />);
    expect(await screen.findByText("No performance overview yet")).toBeTruthy(); expect(screen.queryByRole("group", { name: "Win rate" })).toBeNull();
  });
  it("ERROR: an error state with the code and a Try again that really re-requests", async () => {
    const { f } = serve(() => ({ status: 500, error: "INTERNAL" })); wrap(<OverviewSection />);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy(); expect(screen.getByText(/Reference INTERNAL/)).toBeTruthy(); const before = f.mock.calls.length; fireEvent.click(screen.getByRole("button", { name: "Try again" })); await waitFor(() => expect(f.mock.calls.length).toBe(before + 1));
  });
  it("DENIED: a 404 on this private route is shown as not available, with no data", async () => {
    serve(() => ({ status: 404, error: "NOT_FOUND" })); wrap(<OverviewSection />); expect(await screen.findByText("Not available to you")).toBeTruthy(); expect(screen.queryByRole("group", { name: "Win rate" })).toBeNull();
  });
  it("LOADING shows a skeleton and no figure", () => { serve(); wrap(<OverviewSection />); expect(screen.getByRole("status")).toBeTruthy(); expect(screen.queryByRole("group", { name: "Win rate" })).toBeNull(); });
  it("UNAVAILABLE: a strategy dimension the backend reports as not available is explained", async () => {
    serve(); section = "strategies"; wrap(<StrategiesSection />); await screen.findByText("DATASET PAPER"); fireEvent.change(screen.getByLabelText("Dimension"), { target: { value: "bySignalPattern" } });
    expect(await screen.findByText(/Signal pattern: not available/)).toBeTruthy(); expect(screen.getByText(/G-23 historical pattern provider/)).toBeTruthy();
  });
});

describe("strategies are not ranked or presented as an evaluation", () => {
  it("says groups are not ranked by result and are not an evaluation of any candidate", async () => {
    serve(); wrap(<StrategiesSection />); await screen.findByText("DATASET PAPER");
    expect(screen.getByText(/not ranked by result/)).toBeTruthy(); expect(screen.getByText(/not an evaluation of any candidate or decision/)).toBeTruthy(); expect(screen.getAllByText("FIXTURE-BACKED DATA").length).toBeGreaterThan(0);
  });
});

describe("outcomes: verified parameters only", () => {
  it("requests limit, adds finality when chosen, never sends a cursor, and keeps decimal strings byte-exact", async () => {
    const { urls } = serve(); wrap(<OutcomesSection />); await screen.findByText("DATASET PAPER");
    expect(urls).toEqual(["/api/session/analytics/outcomes?limit=50"]); expect(screen.getByText("0.66907100")).toBeTruthy(); expect(screen.getAllByText(/6,172\.18/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Rows to load"), { target: { value: "100" } }); await waitFor(() => expect(urls).toContain("/api/session/analytics/outcomes?limit=100"));
    fireEvent.change(screen.getByLabelText("Finality"), { target: { value: "FINAL" } }); await waitFor(() => expect(urls).toContain("/api/session/analytics/outcomes?limit=100&finality=FINAL"));
    expect(urls.some((u) => /cursor|accountId|dataset/.test(u))).toBe(false); expect(screen.getByText(/no next-page cursor/)).toBeTruthy();
  });
  it("labels every fixture-backed row", async () => { serve(); wrap(<OutcomesSection />); await screen.findByText("DATASET PAPER"); expect(within(screen.getByRole("table", { name: "Outcome history" })).getAllByText("FIXTURE").length).toBeGreaterThan(0); });
});

describe("insights are REVIEW-only text", () => {
  it("shows REVIEW as 'for human review' and none as no recommendation, and offers no action control", async () => {
    serve(); wrap(<InsightsSection />); await screen.findByText("DATASET PAPER");
    expect(screen.getAllByText("FOR HUMAN REVIEW").length).toBeGreaterThan(0); expect(screen.getAllByText("NO RECOMMENDATION").length).toBeGreaterThan(0); expect(screen.getByText(/changes no strategy, weight, threshold, risk limit/)).toBeTruthy();
    const buttons = screen.queryAllByRole("button").map((b) => b.textContent ?? ""); expect(buttons.join("|")).not.toMatch(/approve|reject|accept|dismiss|apply|execute|order|enable|disable|change/i);
  });
  it("renders hostile or unknown insight content as inert text, never as markup or instructions", async () => {
    serve((n, b) => { if (n === "insights") { const r = (b["data"] as Array<Record<string, unknown>>)[0]!; r["statement"] = "<img src=x onerror=alert(1)> reduce position size now"; r["provenance"] = { fixtureBacked: true, weird: { deep: ["<script>x</script>"] } }; } return b; });
    const { container } = wrap(<InsightsSection />); await screen.findByText("DATASET PAPER");
    expect(container.querySelector("img")).toBeNull(); expect(container.querySelector("script")).toBeNull(); expect(screen.getByText(/<img src=x onerror=alert\(1\)> reduce position size now/)).toBeTruthy();
  });
  it("a recommendation other than REVIEW is refused by the relay schema rather than shown", () => {
    const bad = clone(sample["insights"]!) as { data: Array<Record<string, unknown>> }; bad.data[0]!["recommendation"] = "REDUCE_SIZE"; expect(ANALYTICS_RELAY_SCHEMAS["analytics.insights"].safeParse(bad).success).toBe(false);
  });
  it("filters by a verified kind through the backend parameter", async () => {
    const { urls } = serve(); wrap(<InsightsSection />); await screen.findByText("DATASET PAPER"); fireEvent.change(screen.getByLabelText("Insight kind"), { target: { value: "DRIFT" } });
    await waitFor(() => expect(urls).toContain("/api/session/analytics/insights?limit=100&kind=DRIFT"));
  });
});

describe("page structure and request discipline", () => {
  it("has the eleven sections, makes ONE analytics request on open, and states PAPER only", async () => {
    const { urls } = serve(); wrap(<InsightsScreen />); await screen.findByText("DATASET PAPER");
    expect(SECTIONS.map((s) => s.label)).toEqual(["Overview", "Strategies", "Channels", "Independent", "Agents", "Decisions", "Drift", "Data quality", "Calibration", "Outcomes", "Insights"]);
    expect(within(screen.getByRole("navigation", { name: "Analytics sections" })).getAllByRole("link")).toHaveLength(11); expect(urls).toEqual(["/api/session/analytics/overview"]); expect(screen.getAllByText(/PAPER only/).length).toBeGreaterThan(0);
  });
  it("never polls or refetches on focus, mount or reconnect (a read may store a snapshot)", () => {
    expect(ANALYTICS_QUERY).toMatchObject({ refetchOnWindowFocus: false, refetchOnMount: false, refetchOnReconnect: false, refetchInterval: false, retry: false }); expect(ANALYTICS_QUERY.staleTime).toBeGreaterThanOrEqual(60_000);
  });
  it("every section renders from real output without a schema or runtime error", async () => {
    for (const s of SECTIONS) { section = s.id; serve(); const { unmount } = wrap(<InsightsScreen />); expect(await screen.findByText("DATASET PAPER"), s.id).toBeTruthy(); unmount(); cleanup(); }
  });
});

describe("fixture label logic", () => {
  it("fixture only, mixed, none and unknown", () => {
    const t = (d: Record<string, number> | undefined) => { const { container } = render(<FixtureLabel dataSources={d} />); const r = container.textContent; cleanup(); return r; };
    expect(t({ FIXTURE: 3 })).toBe("FIXTURE-BACKED DATA"); expect(t({ FIXTURE: 1, HISTORICAL: 2 })).toBe("INCLUDES FIXTURE-BACKED DATA"); expect(t({ HISTORICAL: 2 })).toBe(""); expect(t({})).toBe(""); expect(t(undefined)).toBe("");
  });
});
