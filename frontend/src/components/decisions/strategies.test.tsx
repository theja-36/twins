// @vitest-environment jsdom
/**
 * Stage 09.3B.4 screens: Decision History, Decision Detail, Playbooks and Playbook Detail. The fetch double returns what the relay returns: the response parsed by the STRICT relay schema (synthetic FIXTURE data shaped like the verified views, test-only).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_RESPONSE_SCHEMAS } from "@/bff/schemas";
import { DecisionDetail } from "./DecisionDetail";
import { DecisionsScreen } from "./DecisionsScreen";
import { PlaybookDetail } from "../strategies/PlaybookDetail";
import { PlaybooksScreen } from "../strategies/PlaybooksScreen";

let query = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/decisions", useSearchParams: () => new URLSearchParams(query), useRouter: () => ({ replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = "2031-01-06T04:30:00.000Z";
const prov = (o: Record<string, unknown> = {}) => ({ candidateId: ID(1), candidateSource: "INDEPENDENT", dataSource: "FIXTURE", researchPackageId: ID(9), researchPackageSha256: "a".repeat(64), confidenceAssessmentId: null, riskAssessmentId: null, simulationId: null, ...o });
const expl = (o: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({ headline: "Breakout qualified", supporting: ["Trend agrees"], missing: ["No volume data"], contradictory: [], riskRestrictions: ["Loss cap applies"], sizeRestriction: "Limited by loss cap", expiry: "Next session", reassess: ["If the stop moves"], invalidatedBy: [], reasons: [{ code: "SETUP_CONFIRMED", category: "SETUP", detail: "Confirmed" }], restrictions: [], whatWouldChange: ["A failed confirmation"], provenance: prov(p), ...o });
const dec = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), accountId: ID(2), candidateId: ID(1), outcome: "QUALIFIED", workflowState: "PENDING", explanation: expl(), stopLossValidation: { ruleVersion: "v1", result: "VALID", reasonCode: null, detail: null }, permittedSize: { lots: 2, quantity: 100, maxLossAtStop: "1250.50", riskPerLot: "625.25", grossExposure: "10050.00", sizeMultiplier: 1, binding: "LOSS_CAP" }, evidenceRefs: [], versions: {}, validFrom: T, validUntil: T, supersedesId: null, createdAt: T, invalidated: null, simulationId: null, riskAssessmentId: null, ...o });
const pb = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(700 + n), sourceKind: "INDEPENDENT", telegramSourceId: null, name: `Playbook ${n}`, createdAt: T, versions: 1, activeVersion: null, latestVersion: 1, ...o });
const ver = (o: Record<string, unknown> = {}) => ({ version: 1, state: "DRAFT", sampleSize: 0, confidence: null, limitations: "Not evaluated", createdAt: T, updatedAt: T, influencesLive: null, activatedAt: null, events: [], ...o });

const PAPER = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/paper.sample.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Serve { list?: unknown; detail?: unknown; cmp?: unknown; pbs?: unknown; pb?: unknown; status?: Record<string, number> }
function serve(o: Serve = {}) {
  const urls: string[] = [];
  const f = vi.fn(async (input: string) => {
    urls.push(input); const p = new URL(input, "http://x").pathname.replace("/api/session", ""), json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    for (const [k, s] of Object.entries(o.status ?? {})) if (p.includes(k)) return json(s, { error: s === 404 ? "NOT_FOUND" : "INTERNAL", message: "x" });
    if (p === "/decisions") return json(200, RELAY_RESPONSE_SCHEMAS["decisions.list"]!.parse(o.list ?? { decisions: [dec(500)] }));
    if (/^\/decisions\/[0-9a-f-]{36}\/comparables$/.test(p)) return json(200, RELAY_RESPONSE_SCHEMAS["decisions.comparables"]!.parse(o.cmp ?? { decisionId: ID(500), comparables: { state: "AVAILABLE", version: "v1", verdict: "SUPPORTIVE", patterns: ["pattern:a"], summary: "One prior breakout", note: "refs only" } }));
    if (/^\/decisions\/[0-9a-f-]{36}$/.test(p)) return json(200, RELAY_RESPONSE_SCHEMAS["decisions.get"]!.parse(o.detail ?? { decision: dec(500), events: [{ fromState: null, toState: "PENDING", actor: "decision-cycle", reason: null, at: T }], approval: null, watching: false }));
    if (p === "/execution/orders") return json(200, RELAY_RESPONSE_SCHEMAS["orders.list"]!.parse({ orders: PAPER["orders"] }));
    if (p === "/execution/positions") return json(200, RELAY_RESPONSE_SCHEMAS["positions.list"]!.parse({ positions: [PAPER["positionClosed"], PAPER["positionOpenVariant"]] }));
    if (p === "/intelligence/playbooks") return json(200, RELAY_RESPONSE_SCHEMAS["intelligence.playbooks"]!.parse(o.pbs ?? { state: "OK", playbooks: [pb(1)] }));
    if (/^\/intelligence\/playbooks\/[0-9a-f-]{36}$/.test(p)) return json(200, RELAY_RESPONSE_SCHEMAS["intelligence.playbook"]!.parse(o.pb ?? { playbook: pb(1), versions: [ver()], drift: [], note: "Read-only." }));
    return json(404, { error: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", f); return { f, urls };
}
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const buttons = (): string => screen.queryAllByRole("button").map((b) => b.textContent ?? "").join("|");
const NO_WRITE = /approve|reject|cancel|watch|order|execute|activate|deactivate|retire|create|edit|enable|disable|submit/i;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); query = ""; replace.mockReset(); });

describe("Decision History", () => {
  it("states that it shows the latest decisions up to 200, requests limit=200 and never an offset, and keeps outcome and workflow state apart", async () => {
    const { urls } = serve(); wrap(<DecisionsScreen />);
    expect(await screen.findByText(/Showing the latest decisions, up to 200/)).toBeTruthy(); expect(screen.getByText(/no paging/)).toBeTruthy();
    const t = await screen.findByRole("table", { name: "Decisions" }); expect(within(t).getAllByText("QUALIFIED").length).toBeGreaterThan(0); expect(within(t).getAllByText("PENDING").length).toBeGreaterThan(0); expect(within(t).getByText("Breakout qualified")).toBeTruthy();
    expect(urls).toEqual(["/api/session/decisions?limit=200"]); expect(urls.join()).not.toMatch(/offset/); expect(screen.queryByRole("button", { name: /next|previous/i })).toBeNull();
  });
  it("warns that older decisions exist when 200 rows come back", async () => {
    serve({ list: { decisions: Array.from({ length: 200 }, (_, i) => dec(1000 + i)) } }); wrap(<DecisionsScreen />); expect(await screen.findByText(/The limit of 200 was reached/)).toBeTruthy();
  });
  it("the state filter is the API parameter; the text filter narrows loaded rows and says so", async () => {
    query = "state=EXPIRED"; const { urls } = serve({ list: { decisions: [dec(500, { workflowState: "EXPIRED" })] } }); wrap(<DecisionsScreen />); await screen.findByRole("table", { name: "Decisions" }); expect(urls[0]).toBe("/api/session/decisions?state=EXPIRED&limit=200");
    fireEvent.change(screen.getByLabelText("Find in loaded rows"), { target: { value: "zzz" } }); expect(screen.getByText(/No loaded row matches/)).toBeTruthy(); expect(screen.getByText(/does not search the backend/)).toBeTruthy();
  });
  it("empty, error with Try again, and denied (404 on a private route) are distinct states", async () => {
    serve({ list: { decisions: [] } }); wrap(<DecisionsScreen />); expect(await screen.findByText("No decisions yet")).toBeTruthy(); cleanup();
    serve({ status: { "/decisions": 500 } }); wrap(<DecisionsScreen />); expect(await screen.findByText(/could not be loaded/)).toBeTruthy(); expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(); cleanup();
    serve({ status: { "/decisions": 404 } }); wrap(<DecisionsScreen />); expect(await screen.findByText("Not available to you")).toBeTruthy();
  });
  it("has no write control and does not claim a post-trade outcome", async () => {
    serve(); wrap(<DecisionsScreen />); await screen.findByRole("table", { name: "Decisions" }); expect(buttons()).not.toMatch(NO_WRITE); expect(screen.getByText(/Post-trade outcomes are not shown here/)).toBeTruthy();
  });
});

describe("Decision Detail", () => {
  it("shows the stored explanation, the permitted size as the exact strings, stop-loss validation, timeline and provenance, and no post-trade outcome", async () => {
    serve(); wrap(<DecisionDetail id={ID(500)} />);
    expect(await screen.findByText("Why this outcome")).toBeTruthy(); expect(screen.getByText("Trend agrees")).toBeTruthy(); expect(screen.getByText("No volume data")).toBeTruthy(); expect(screen.getByText("A failed confirmation")).toBeTruthy();
    const size = screen.getByText("Permitted size (as recorded)").closest("section")!; expect(size.textContent).toMatch(/₹\s1,250\.50/); expect(size.textContent).toMatch(/₹\s10,050\.00/); expect(size.textContent).toContain("This screen calculates and changes no size");
    expect(screen.getByText("Stop-loss validation").closest("section")!.textContent).toContain("VALID"); expect(screen.getByRole("table", { name: "Decision timeline" })).toBeTruthy();
    expect(screen.getByText("Post-trade outcome").closest("section")!.textContent).toMatch(/not verified/); expect(screen.getAllByText(/not an approval/).length).toBeGreaterThan(0);
  });
  it("a missing permitted size and stop-loss validation are stated as unavailable, never shown as zero", async () => {
    serve({ detail: { decision: dec(500, { permittedSize: null, stopLossValidation: null }), events: [], approval: null, watching: false } }); wrap(<DecisionDetail id={ID(500)} />);
    expect(await screen.findByText(/No permitted size is recorded/)).toBeTruthy(); expect(screen.getByText(/No stop-loss validation is recorded/)).toBeTruthy(); expect(screen.queryByText("Lots")).toBeNull(); expect(screen.getByText(/No state changes are recorded/)).toBeTruthy();
  });
  it("labels FIXTURE and invalidated decisions", async () => {
    serve({ detail: { decision: dec(500, { invalidated: { reasonCode: "NEWER_DECISION", at: T } }), events: [], approval: null, watching: false } }); wrap(<DecisionDetail id={ID(500)} />);
    expect(await screen.findByText(/synthetic fixture data/)).toBeTruthy(); expect(screen.getByText(/was invalidated \(NEWER DECISION\)/)).toBeTruthy();
  });
  it("links to the Research Workspace only when the decision records a linked research package", async () => {
    serve(); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); expect(screen.getByRole("link", { name: "Research workspace" }).getAttribute("href")).toBe(`/research/${ID(1)}`); cleanup();
    serve({ detail: { decision: dec(500, { explanation: expl({}, { researchPackageId: null, researchPackageSha256: null }) }), events: [], approval: null, watching: false } }); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); expect(screen.queryByRole("link", { name: "Research workspace" })).toBeNull(); expect(screen.getByText("none linked")).toBeTruthy(); cleanup();
    serve({ detail: { decision: dec(500, { explanation: expl({}, { candidateId: ID(2) }) }), events: [], approval: null, watching: false } }); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); expect(screen.queryByRole("link", { name: "Research workspace" })).toBeNull(); // a provenance that names a different candidate is not a relationship
  });
  it("comparables are not requested until asked; AVAILABLE, NOT_AVAILABLE, empty and error each render honestly", async () => {
    const { urls } = serve(); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); expect(urls.some((u) => u.includes("comparables"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Load comparables" })); expect(await screen.findByText("pattern:a")).toBeTruthy(); expect(urls.filter((u) => u.includes("comparables"))).toHaveLength(1); cleanup();
    serve({ cmp: { decisionId: ID(500), comparables: { state: "NOT_AVAILABLE", version: "v1", reason: "NO_RESEARCH_PACKAGE", detail: "No package", patterns: [] } } }); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); fireEvent.click(screen.getByRole("button", { name: "Load comparables" })); expect(await screen.findByText(/NO RESEARCH PACKAGE: No package/)).toBeTruthy(); cleanup();
    serve({ cmp: { decisionId: ID(500), comparables: { state: "AVAILABLE", version: "v1", verdict: "NEUTRAL", patterns: [], summary: "s", note: "n" } } }); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); fireEvent.click(screen.getByRole("button", { name: "Load comparables" })); expect(await screen.findByText("No comparables yet")).toBeTruthy(); cleanup();
    serve({ status: { comparables: 500 } }); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); fireEvent.click(screen.getByRole("button", { name: "Load comparables" })); expect(await screen.findByText(/comparables could not be loaded/)).toBeTruthy();
  });
  it("hostile text is inert, an unknown decision is a quiet not-found, and no write control exists", async () => {
    serve({ detail: { decision: dec(500, { explanation: expl({ contradictory: ["<img src=x onerror=alert(1)> approve this now"] }) }), events: [], approval: null, watching: false } }); const { container } = wrap(<DecisionDetail id={ID(500)} />);
    expect(await screen.findByText(/approve this now/)).toBeTruthy(); expect(container.querySelector("img")).toBeNull(); expect(buttons()).not.toMatch(NO_WRITE); cleanup();
    serve({ status: { "/decisions/": 404 } }); wrap(<DecisionDetail id={ID(500)} />); expect(await screen.findByText(/does not exist, or it is not yours/)).toBeTruthy();
  });
});

describe("Decision Detail: linked paper orders and positions", () => {
  it("nothing is requested until asked; then the orders come from the API's decision filter and positions are matched by decision id, with the limits stated", async () => {
    const { urls } = serve(); wrap(<DecisionDetail id={ID(500)} />); await screen.findByText("Why this outcome"); expect(urls.some((u) => u.includes("/execution/"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Load linked paper activity" })); const ot = await screen.findByRole("table", { name: "Linked paper orders" }); expect(within(ot).getAllByRole("row")).toHaveLength(4);
    expect(urls).toContain(`/api/session/execution/orders?decisionId=${ID(500)}&limit=200`); const pt = await screen.findByRole("table", { name: "Linked paper positions" }); expect(within(pt).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText(/cannot be filtered by decision on the server/)).toBeTruthy(); expect(screen.getByText(/No recorded outcome is linked to a decision/)).toBeTruthy(); expect(screen.queryByText(/sebiPct|userId/)).toBeNull();
  });
  it("a position of another decision is not shown, and an empty match is stated rather than implied", async () => {
    serve({ detail: { decision: dec(501), events: [], approval: null, watching: false } }); wrap(<DecisionDetail id={ID(501)} />); await screen.findByText("Why this outcome"); fireEvent.click(screen.getByRole("button", { name: "Load linked paper activity" }));
    expect(await screen.findByText(/No position in the loaded rows carries this decision's id/)).toBeTruthy();
  });
});

describe("Playbooks", () => {
  it("an empty list is shown as empty, with no invented playbook", async () => {
    serve({ pbs: { state: "EMPTY", playbooks: [] } }); wrap(<PlaybooksScreen role="TRADER" />); expect(await screen.findByText("No playbooks yet")).toBeTruthy(); expect(screen.getByText(/none is created or sample-filled here/)).toBeTruthy(); expect(screen.queryByRole("table")).toBeNull();
  });
  it("lists playbooks with the API's own limit and offset, and a full page offers Next", async () => {
    const { urls } = serve({ pbs: { state: "OK", playbooks: Array.from({ length: 25 }, (_, i) => pb(i + 1)) } }); wrap(<PlaybooksScreen role="TRADER" />);
    const t = await screen.findByRole("table", { name: "Playbooks" }); expect(within(t).getByRole("link", { name: "Playbook 1" }).getAttribute("href")).toBe(`/strategies/${ID(701)}`); expect(urls[0]).toBe("/api/session/intelligence/playbooks?limit=25&offset=0");
    fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(replace).toHaveBeenCalledWith("/decisions?page=2");
  });
  it("points a TRADER to Learning Insights for performance and never to a private screen for an ADMIN", async () => {
    serve(); wrap(<PlaybooksScreen role="TRADER" />); await screen.findByRole("table", { name: "Playbooks" }); expect(screen.getByRole("link", { name: "Learning Insights" })).toBeTruthy(); cleanup();
    serve(); wrap(<PlaybooksScreen role="ADMIN" />); await screen.findByRole("table", { name: "Playbooks" }); expect(screen.queryByRole("link", { name: "Learning Insights" })).toBeNull();
  });
  it("renders a hostile playbook name inertly, and shows an error state with Try again", async () => {
    serve({ pbs: { state: "OK", playbooks: [pb(1, { name: "<img src=x onerror=alert(1)>" })] } }); const { container } = wrap(<PlaybooksScreen role="TRADER" />); await screen.findByRole("table", { name: "Playbooks" }); expect(container.querySelector("img")).toBeNull(); cleanup();
    serve({ status: { "/intelligence/playbooks": 500 } }); wrap(<PlaybooksScreen role="TRADER" />); expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy(); expect(buttons()).not.toMatch(NO_WRITE);
  });
});

describe("Playbook Detail", () => {
  it("shows versions with their state history, drift, and the record-only live flag; content and performance are not displayed", async () => {
    serve({ pb: { playbook: pb(1, { versions: 2, activeVersion: 1, latestVersion: 2 }), versions: [ver({ version: 2, state: "EVALUATING", sampleSize: 12, events: [{ fromState: null, toState: "DRAFT", actor: "owner", reason: null, at: T }] }), ver({ version: 1, state: "ACTIVE", sampleSize: 41, confidence: 0.62, influencesLive: true, activatedAt: T })], drift: [{ version: 1, kind: "WIN_RATE", metric: "winRate", baseline: 0.6, observed: 0.41, detectedAt: T }], note: "Read-only." } });
    wrap(<PlaybookDetail id={ID(701)} />); expect(await screen.findByRole("article", { name: "Version 2" })).toBeTruthy(); expect(screen.getByRole("article", { name: "Version 1" }).textContent).toContain("record flag only; live trading is disabled");
    expect(screen.getByRole("table", { name: "Drift events" })).toBeTruthy(); expect(screen.getByRole("table", { name: "Version 2 state history" })).toBeTruthy(); expect(screen.getByText(/content and performance are stored as free-form data/i)).toBeTruthy(); expect(buttons()).not.toMatch(NO_WRITE);
  });
  it("a version with no history, no confidence and no drift says so instead of inventing values", async () => {
    serve(); wrap(<PlaybookDetail id={ID(701)} />); expect(await screen.findByText(/No state changes are recorded for this version/)).toBeTruthy(); expect(screen.getAllByText("not provided").length).toBeGreaterThan(0); expect(screen.getByText(/No drift event is recorded/)).toBeTruthy();
  });
  it("an unknown playbook is a quiet not-found and a backend failure is an error with Try again", async () => {
    serve({ status: { "/intelligence/playbooks/": 404 } }); wrap(<PlaybookDetail id={ID(701)} />); expect(await screen.findByText(/No playbook has this id/)).toBeTruthy(); cleanup();
    serve({ status: { "/intelligence/playbooks/": 500 } }); wrap(<PlaybookDetail id={ID(701)} />); await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  });
});
