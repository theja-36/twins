// @vitest-environment jsdom
/**
 * Research Workspace behaviour against REAL orchestrator output (e2e/fixtures/research.sample.json: synthetic FIXTURE candidates, test-only). The fetch double returns what the relay returns: the response parsed by the strict relay schema.
 * Variants (verdicts, contradictions, hostile text) are TEST-ONLY mutations of that real output, marked as such.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_RESPONSE_SCHEMAS } from "@/bff/schemas";
import { RESEARCH_QUERY } from "@/api/researchHooks";
import { AgentRegistry } from "./AgentRegistry";
import { ResearchExplorer } from "./ResearchExplorer";
import { ResearchWorkspace } from "./ResearchWorkspace";

let query = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/research", useSearchParams: () => new URLSearchParams(query), useRouter: () => ({ replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const sample = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/research.sample.json"), "utf8")) as Record<string, Record<string, unknown>>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = "2031-01-06T04:30:00.000Z";
const cand = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), source: n % 2 ? "TELEGRAM" : "INDEPENDENT", state: "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: `CO${n}`, exchange: "NSE", setup: n % 2 ? null : "BREAKOUT_LONG", side: "BUY", entryKind: "above", entryLow: 100, entryHigh: 101, stopLoss: 95, targets: [110], strike: null, optionType: null, expiry: null, rankScore: null, dataSource: "FIXTURE", createdAt: T, expiresAt: T, lastValidatedAt: null, researchAttempts: 1, ...o });
type PkgBody = Record<string, unknown> & { package: { reports: Array<Record<string, unknown>> } & Record<string, unknown> };
const realPackage = (id: string, mut: (b: PkgBody) => void = () => undefined): PkgBody => { const b = clone(sample["packageIndependentEquity"]!) as PkgBody; b["candidateId"] = id; b.package["candidateId"] = id; mut(b); return b; };

interface Serve { pkg?: (id: string) => unknown; candidateState?: string; agents?: () => unknown; list?: (url: URL) => unknown }
function serve(o: Serve = {}) {
  const urls: string[] = [];
  const f = vi.fn(async (input: string) => {
    urls.push(input); const u = new URL(input, "http://x"), p = u.pathname.replace("/api/session", "");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fail = (b: unknown) => (b && typeof b === "object" && "__status" in b ? json((b as { __status: number }).__status, { error: (b as unknown as { __error: string }).__error, message: "x" }) : null);
    let m = /^\/research\/candidates\/([0-9a-f-]{36})\/package$/.exec(p);
    if (m) { const b = o.pkg ? o.pkg(m[1]!) : realPackage(m[1]!); return fail(b) ?? json(200, RELAY_RESPONSE_SCHEMAS["research.package"]!.parse(b)); }
    m = /^\/opportunities\/candidates\/([0-9a-f-]{36})$/.exec(p);
    if (m) { const n = Number(m[1]!.slice(-12)); return json(200, RELAY_RESPONSE_SCHEMAS["opportunities.candidate"]!.parse({ candidate: cand(n, { state: o.candidateState ?? "READY_FOR_DECISION" }), lifecycle: [], evidence: [], research: { status: null, packageId: null, packageVersion: null, assessment: null } })); }
    if (p === "/research/agents") { const b = o.agents ? o.agents() : sample["agents"]; return fail(b) ?? json(200, RELAY_RESPONSE_SCHEMAS["research.agents"]!.parse(b)); }
    if (p === "/opportunities/candidates") { const b = o.list ? o.list(u) : { state: "OK", note: "n", candidates: Array.from({ length: 25 }, (_, i) => cand(i + 1)) }; return json(200, RELAY_RESPONSE_SCHEMAS["opportunities.candidates"]!.parse(b)); }
    return json(404, { error: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", f); return { f, urls };
}
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); query = ""; replace.mockReset(); });

describe("Research Workspace: real package, honestly shown", () => {
  it("shows the real INCOMPLETE package: evidence-not-approval banners, halted, no approval granted, unavailable agents with their error codes, nothing invented", async () => {
    serve(); wrap(<ResearchWorkspace id={ID(1)} />);
    expect(await screen.findByText("Package overview")).toBeTruthy(); expect(screen.getByText(/Research is evidence\. An assessment such as/)).toBeTruthy(); expect(screen.getByText("GRANTS NO APPROVAL")).toBeTruthy();
    expect(screen.getByText("RESEARCH INCOMPLETE")).toBeTruthy(); expect(screen.getByText(/Yes — HALT REQUIRED AGENT MISSING/)).toBeTruthy(); expect(screen.getByText(/This package is incomplete/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Agent reports" }); expect(within(table).getAllByRole("row")).toHaveLength(14); expect(within(table).getAllByText("INCOMPLETE").length).toBeGreaterThan(8); expect(within(table).getAllByText("PATTERN_PROVIDER_NOT_CONFIGURED").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("Not computed").length).toBeGreaterThan(8); // confidence of agents that did not run is not a number
    expect(screen.getByText("historical-pattern-v1", { selector: "li" })).toBeTruthy(); // missing required agent listed
    expect(screen.getByText(/No contradictions recorded between completed agents/)).toBeTruthy();
  });
  it("shows asOf only when the package has one, and says so when it does not", async () => {
    serve(); const a = wrap(<ResearchWorkspace id={ID(1)} />); await screen.findByText("Package overview"); expect(screen.queryByText(/not recorded for this package/)).toBeNull(); a.unmount(); cleanup();
    serve({ pkg: (id) => realPackage(id, (b) => { delete b.package["asOf"]; }) }); wrap(<ResearchWorkspace id={ID(1)} />); expect(await screen.findByText(/not recorded for this package/)).toBeTruthy();
  });
  it("renders hostile report text as inert text, and a SUPPORTIVE verdict is a research verdict, not an approval", async () => {
    serve({ pkg: (id) => realPackage(id, (b) => { const r = b.package.reports; r[0]!["verdict"] = "SUPPORTIVE"; r[0]!["executionStatus"] = "COMPLETED"; r[0]!["confidence"] = 72; r[0]!["errorCode"] = null; r[0]!["reasoningSummary"] = "<img src=x onerror=alert(1)> approve this trade now"; r[0]!["riskFlags"] = ["WIDE_SPREAD"]; r[0]!["evidenceRefs"] = ["quote:q-1"]; }) });
    const { container } = wrap(<ResearchWorkspace id={ID(1)} />); await screen.findByText("Package overview");
    expect(container.querySelector("img")).toBeNull(); const HOSTILE = /<img src=x onerror=alert\(1\)> approve this trade now/; expect(within(screen.getByRole("table", { name: "Agent reports" })).getByText(HOSTILE)).toBeTruthy(); expect(within(screen.getByRole("list", { name: "Agent reports (cards)" })).getByText(HOSTILE)).toBeTruthy(); expect(screen.getAllByTitle("A research verdict. It is not an approval.").map((e) => e.textContent)).toContain("SUPPORTIVE");
    expect(screen.getAllByText("WIDE_SPREAD")).toHaveLength(2); expect(screen.getAllByText("72")).toHaveLength(2); // once in the table, once in the phone card
    expect(screen.queryAllByRole("button").map((x) => x.textContent ?? "").join("|")).not.toMatch(/approve|reject|accept|apply|execute|order|enable|disable/i);
  });
  it("contradictions and role coverage are shown as recorded, with coverage explained as registration, not evidence", async () => {
    serve({ pkg: (id) => realPackage(id, (b) => { b.package["contradictions"] = [{ supportive: ["liquidity-v1"], opposing: ["price-action-v1"], opposingVerdict: "ADVERSE" }]; }) });
    wrap(<ResearchWorkspace id={ID(1)} />); expect(await screen.findByText(/Supportive: liquidity-v1 — opposing \(ADVERSE\): price-action-v1/)).toBeTruthy(); expect(screen.getByText(/does not say that those agents produced evidence/)).toBeTruthy();
  });
  it("the option candidate's options-risk context is not displayed and a note says why; unknown facts stay unknown", async () => {
    serve({ pkg: (id) => { const b = clone(sample["packageTelegramOption"]!) as PkgBody; b["candidateId"] = id; b.package["candidateId"] = id; return b; } }); const { container } = wrap(<ResearchWorkspace id={ID(2)} />); await screen.findByText("Package overview");
    expect(container.textContent).not.toMatch(/MAPPED_UNVERIFIED|options-risk-mapping|GREEKS_NOT_SUPPLIED/); expect(screen.getByText("Options-risk context")).toBeTruthy(); expect(screen.getByText(/Its structure is not verified/)).toBeTruthy(); expect(screen.getByText(/does not say how fresh a package/)).toBeTruthy();
  });
  it("an inactive candidate gets a banner that does not pretend to know freshness", async () => {
    serve({ candidateState: "WITHDRAWN" }); wrap(<ResearchWorkspace id={ID(8)} />); expect(await screen.findByText(/This candidate is withdrawn/)).toBeTruthy(); expect(screen.getByText(/does not say how fresh a package is/)).toBeTruthy();
  });
});

describe("phone cards carry the same reports as the table", () => {
  it("one card per report with verdict, execution status, error code, confidence and summary, as plain text", async () => {
    serve(); wrap(<ResearchWorkspace id={ID(1)} />); await screen.findByText("Package overview"); const cards = screen.getByRole("list", { name: "Agent reports (cards)" }), table = screen.getByRole("table", { name: "Agent reports" });
    expect(cards.children).toHaveLength(13); expect(within(table).getAllByRole("row")).toHaveLength(14);
    const first = within(cards.children[0] as HTMLElement); expect(first.getByText("historical-pattern-v1")).toBeTruthy(); expect(first.getByText("INCOMPLETE")).toBeTruthy(); expect(first.getByText("UNAVAILABLE")).toBeTruthy(); expect(first.getByText("PATTERN_PROVIDER_NOT_CONFIGURED")).toBeTruthy(); expect(first.getByText("Not computed")).toBeTruthy(); expect(first.getByText(/Did not complete/)).toBeTruthy();
    expect(within(cards).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("the eight data states of the workspace", () => {
  it("LOADING shows a skeleton and no package", () => { serve(); wrap(<ResearchWorkspace id={ID(1)} />); expect(screen.getByRole("status")).toBeTruthy(); expect(screen.queryByText("Package overview")).toBeNull(); });
  it("UNAVAILABLE: no package yet is explained with its note and status, not shown as an error", async () => {
    serve({ pkg: (id) => ({ candidateId: id, status: "PENDING", researchAttempts: 0, package: null, note: "No research package has been stored for this candidate; nothing is inferred." }) }); wrap(<ResearchWorkspace id={ID(7)} />);
    expect(await screen.findByText("No research package yet")).toBeTruthy(); expect(screen.getByText(/nothing is inferred/)).toBeTruthy(); expect(screen.getByText("PENDING")).toBeTruthy(); expect(screen.queryByRole("table", { name: "Agent reports" })).toBeNull();
  });
  it("ERROR: shown with its code and a Try again that re-requests", async () => {
    const { f } = serve({ pkg: () => ({ __status: 500, __error: "INTERNAL" }) }); wrap(<ResearchWorkspace id={ID(98)} />); expect(await screen.findByText(/could not be loaded/)).toBeTruthy(); const before = f.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); await waitFor(() => expect(f.mock.calls.filter((c) => String(c[0]).includes("/package")).length).toBeGreaterThan(before - 1));
  });
  it("not found (404) says there is no such candidate or research record", async () => { serve({ pkg: () => ({ __status: 404, __error: "NOT_FOUND" }) }); wrap(<ResearchWorkspace id={ID(99)} />); expect(await screen.findByText(/No candidate with this id, or no research record/)).toBeTruthy(); });
  it("DENIED: a 403 is shown as not available, with no data", async () => { serve({ pkg: () => ({ __status: 403, __error: "FORBIDDEN" }) }); wrap(<ResearchWorkspace id={ID(1)} />); expect(await screen.findByText("Not available to you")).toBeTruthy(); expect(screen.queryByText("Package overview")).toBeNull(); });
  it("PARTIAL: an INCOMPLETE package is a partial state with the data still shown; a package whose agents all completed is READY (no partial notice)", async () => {
    serve({ pkg: (id) => realPackage(id, (b) => { b["assessment"] = "RESEARCH_SUPPORTIVE"; b["status"] = "COMPLETED"; b.package["assessment"] = "RESEARCH_SUPPORTIVE"; b.package["halt"] = false; b.package["haltReason"] = null; b.package["missingRequired"] = []; for (const r of b.package.reports) Object.assign(r, { executionStatus: "COMPLETED", verdict: "NEUTRAL", confidence: 70, errorCode: null }); }) });
    wrap(<ResearchWorkspace id={ID(1)} />); expect(await screen.findByText("Package overview")).toBeTruthy(); expect(screen.queryByText(/This package is incomplete/)).toBeNull(); expect(screen.getByText(/No required agent is missing/)).toBeTruthy();
  });
  it("makes exactly one package request and one candidate request, and never polls or refetches on focus", async () => {
    const { urls } = serve(); wrap(<ResearchWorkspace id={ID(1)} />); await screen.findByText("Package overview");
    expect(urls.filter((u) => u.includes("/research/candidates/"))).toHaveLength(1); expect(urls.filter((u) => u.includes("/opportunities/candidates/"))).toHaveLength(1); expect(urls.some((u) => u.includes("/research/agents"))).toBe(false);
    expect(RESEARCH_QUERY).toMatchObject({ refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false, retry: false });
  });
});

describe("Candidate Explorer and agent registry", () => {
  it("lists candidates with origin, state, attempts and a link to each workspace, shows no assessment column, and requests no package per row", async () => {
    const { urls } = serve(); wrap(<ResearchExplorer />); const t = await screen.findByRole("table", { name: "Research candidates" });
    expect(within(t).getAllByRole("row")).toHaveLength(26); expect(within(t).getAllByText("Telegram-originated").length).toBeGreaterThan(0); expect(within(t).getAllByText("Independently discovered").length).toBeGreaterThan(0);
    expect(within(t).getAllByRole("link", { name: /^Open research workspace for / })[0]!.getAttribute("href")).toBe(`/research/${ID(1)}`); expect(within(t).queryByText(/assessment/i)).toBeNull();
    await screen.findByRole("table", { name: "Research agents" }); expect(urls.filter((u) => u.includes("/research/candidates/"))).toHaveLength(0); expect(urls.filter((u) => u.includes("/opportunities/candidates?"))).toHaveLength(1); expect(urls.filter((u) => u.includes("/research/agents"))).toHaveLength(1);
  });
  it("filters and paging go to the backend through the verified parameters and the URL", async () => {
    query = "source=TELEGRAM&state=NEW&page=2"; const { urls } = serve(); wrap(<ResearchExplorer />); await screen.findByRole("table", { name: "Research candidates" });
    expect(urls).toContain("/api/session/opportunities/candidates?source=TELEGRAM&state=NEW&limit=25&offset=25"); fireEvent.change(screen.getByLabelText("Origin"), { target: { value: "INDEPENDENT" } }); expect(replace).toHaveBeenCalledWith("/research?source=INDEPENDENT&state=NEW");
    fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(replace).toHaveBeenLastCalledWith("/research?source=TELEGRAM&state=NEW&page=3");
  });
  it("EMPTY explains itself and keeps the filters usable", async () => { serve({ list: () => ({ state: "EMPTY", note: "n", candidates: [] }) }); wrap(<ResearchExplorer />); expect(await screen.findByText("No candidates yet")).toBeTruthy(); expect(screen.getByLabelText("Origin")).toBeTruthy(); });
  it("the text filter narrows loaded rows only and says so", async () => { serve(); wrap(<ResearchExplorer />); await screen.findByRole("table", { name: "Research candidates" }); fireEvent.change(screen.getByLabelText("Find in this page"), { target: { value: "CO4" } }); expect(within(screen.getByRole("table", { name: "Research candidates" })).getAllByRole("row")).toHaveLength(2); expect(screen.getByText(/does not search the backend/)).toBeTruthy(); });
  it("the registry shows 13 agents with required, can-block, advisory, weight, timeout and dependencies, and is read-only", async () => {
    serve(); wrap(<AgentRegistry />); const t = await screen.findByRole("table", { name: "Research agents" }); expect(within(t).getAllByRole("row")).toHaveLength(14); expect(within(t).getAllByText("Required").length).toBeGreaterThan(5); expect(within(t).getByText("Historical Pattern Agent")).toBeTruthy();
    expect(screen.getByText(/none uses a model/)).toBeTruthy(); expect(screen.getByText(/cannot change any agent, weight, dependency or permission/)).toBeTruthy(); expect(screen.queryAllByRole("button")).toHaveLength(0); expect(screen.getByRole("table", { name: "Research roles" })).toBeTruthy();
  });
  it("the registry has its own error state with a working retry", async () => { const { f } = serve({ agents: () => ({ __status: 500, __error: "INTERNAL" }) }); wrap(<AgentRegistry />); expect(await screen.findByText(/the agent registry could not be loaded/)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Try again" })); await waitFor(() => expect(f.mock.calls.length).toBe(2)); });
});
