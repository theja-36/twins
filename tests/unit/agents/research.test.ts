import { describe, expect, it } from "vitest";
import {
  buildResearchPackage, candidateToAgentInputs, createProductionRegistry, DEFAULT_AGENT_RULES, EXTRA_SPECIALISTS, findContradictions, loadAgentEngineConfig, orchestrate, PRODUCTION_AGENT_IDS,
  roleCoverage, roleOfAgent, runCandidateResearch, type ResearchPackageSink, SPEC_ROLE_MAP, SPEC_ROLES, toResearchPackageRow, toSpecAgentReport, type AgentRunResult, type ResearchCandidate, type SpecAgentReport,
} from "../../../packages/agents/src/index";

const NOW = new Date("2026-11-09T04:30:00Z");
const cand = (o: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  id: "aaaaaaaa-1111-4111-8111-111111111111", source: "TELEGRAM", underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE", expiry: "2026-11-27", side: "BUY", entryKind: "at",
  entryLow: 120, entryHigh: null, stopLoss: 90, targets: [150, 180], dataSource: "FIXTURE", createdAt: new Date("2026-11-09T04:25:00Z"), ...o,
});
const cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
const research = async (c: ResearchCandidate) => {
  const plan = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).resolve(cfg);
  const out = await orchestrate(plan, cfg, candidateToAgentInputs(c) as never, { riskDecisionId: c.id, decisionVersion: 1 }, { now: () => NOW, sleep: async () => undefined });
  return { out, pkg: buildResearchPackage(c, 1, out) };
};
const result = (o: Partial<AgentRunResult>): AgentRunResult => ({ agentId: "liquidity-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 80, findings: [], evidence: [], inputSnapshotRef: "x", inputSnapshot: {}, outputSnapshot: {}, startedAt: NOW, completedAt: NOW, durationMs: 1, attempts: 1, errorCode: null, errorMessage: null, ...o });

describe("specification role mapping", () => {
  it("binds all twelve roles; the registered production agents cover them with nothing unmapped", () => {
    expect(SPEC_ROLES).toHaveLength(12);
    const cov = roleCoverage(PRODUCTION_AGENT_IDS);
    expect(cov.missingRoles).toEqual([]); expect(cov.unmappedAgents).toEqual([]); expect(cov.coveredRoles).toHaveLength(12);
    expect(SPEC_ROLE_MAP.CALENDAR_MACRO.components).toEqual(["market-calendar-v1", "macro-global-v1"]);
    expect(SPEC_ROLE_MAP.RESEARCH_SYNTHESIS.kind).toBe("SYNTHESIS");
  });
  it("options-risk stays a registered extra and never stands in for a role; removing a role's agent is reported", () => {
    expect(EXTRA_SPECIALISTS).toContain("options-risk-v1"); expect(roleOfAgent("options-risk-v1")).toBe("EXTRA");
    const cov = roleCoverage(PRODUCTION_AGENT_IDS.filter((a) => a !== "market-context-v1"));
    expect(cov.missingRoles).toEqual(["MARKET_CONTEXT"]);
    expect(roleCoverage([...PRODUCTION_AGENT_IDS, "mystery-v1"]).unmappedAgents).toEqual(["mystery-v1"]);
  });
});

describe("spec agent report", () => {
  it("every non-COMPLETED status, and UNAVAILABLE, is INCOMPLETE; a completed verdict passes through", () => {
    for (const status of ["FAILED", "TIMEOUT", "SKIPPED", "UNAVAILABLE"] as const) expect(toSpecAgentReport(result({ status, verdict: "SUPPORTIVE" })).verdict).toBe("INCOMPLETE");
    expect(toSpecAgentReport(result({ status: "COMPLETED", verdict: "UNAVAILABLE" })).verdict).toBe("INCOMPLETE");
    expect(toSpecAgentReport(result({ verdict: "CAUTION" })).verdict).toBe("CAUTION");
  });
  it("carries evidence refs, risk flags (MEDIUM and above) and a bounded summary", () => {
    const r = toSpecAgentReport(result({ verdict: "CAUTION", findings: [{ code: "A_FLAG", severity: "HIGH", summary: "x".repeat(900) }, { code: "INFO_ONLY", severity: "INFO", summary: "i" }], evidence: [{ kind: "risk_decision", ref: "r1" }, { kind: "risk_decision", ref: "r1" }] }));
    expect(r.riskFlags).toEqual(["A_FLAG"]); expect(r.evidenceRefs).toEqual(["risk_decision:r1"]); expect(r.reasoningSummary.length).toBeLessThanOrEqual(400); expect(r).toMatchObject({ agentVersion: "1.0.0", role: "LIQUIDITY" });
  });
  it("a supportive agent against an adverse or blocking one is a reported contradiction", () => {
    const rep = (agentId: string, verdict: SpecAgentReport["verdict"]) => ({ ...toSpecAgentReport(result({ agentId })), verdict });
    expect(findContradictions([rep("a-v1", "SUPPORTIVE"), rep("b-v1", "ADVERSE"), rep("c-v1", "BLOCKING")])).toEqual([
      { supportive: ["a-v1"], opposing: ["c-v1"], opposingVerdict: "BLOCKING" }, { supportive: ["a-v1"], opposing: ["b-v1"], opposingVerdict: "ADVERSE" }]);
    expect(findContradictions([rep("a-v1", "SUPPORTIVE"), rep("b-v1", "CAUTION")])).toEqual([]);
  });
});

describe("candidate research path: one infrastructure for both pipelines", () => {
  it("Telegram and independent candidates run through the same agents and synthesis; with no providers the result is INCOMPLETE and approves nothing", async () => {
    const t = await research(cand());
    const i = await research(cand({ id: "bbbbbbbb-2222-4222-8222-222222222222", source: "INDEPENDENT" }));
    for (const { pkg, out } of [t, i]) {
      expect(out.results).toHaveLength(13);
      expect(pkg).toMatchObject({ assessment: "RESEARCH_INCOMPLETE", halt: true, grantsApproval: false, packageVersion: "research-package-v1" });
      expect(pkg.roleCoverage.missingRoles).toEqual([]);
      expect(pkg.reports.filter((r) => r.verdict === "INCOMPLETE").length).toBeGreaterThan(0);
      expect(Object.keys(pkg.agentVersions)).toHaveLength(13);
    }
    expect(t.pkg.candidateSource).toBe("TELEGRAM"); expect(i.pkg.candidateSource).toBe("INDEPENDENT");
  });
  it("the package is deterministic: the same candidate and results give the same hash; a different candidate does not", async () => {
    const a = await research(cand()), b = await research(cand()), c = await research(cand({ id: "cccccccc-3333-4333-8333-333333333333" }));
    expect(a.pkg.packageSha256).toBe(b.pkg.packageSha256); expect(a.pkg.packageSha256).not.toBe(c.pkg.packageSha256);
  });
  it("candidate inputs hold parsed fields only and mark an unvalidated stop-loss as absent, never valid", () => {
    const inp = candidateToAgentInputs(cand()) as Record<string, Record<string, unknown> | null>;
    expect(inp["stop_loss_validation"]).toBeNull(); expect(inp["risk_decision"]).toMatchObject({ instrumentType: "option", entryPrice: 120, stopLossBasis: "premium", symbol: "NIFTY" });
    expect(inp["signal_context"]).toMatchObject({ messageLinked: true });
    expect((candidateToAgentInputs(cand({ source: "INDEPENDENT" })) as Record<string, Record<string, unknown>>)["signal_context"]).toMatchObject({ messageLinked: false });
    expect(JSON.stringify(inp)).not.toMatch(/raw|messageText/);
  });
  it("the database row carries the package and its assessment; the version must be positive", async () => {
    const { out } = await research(cand());
    const row = toResearchPackageRow(buildResearchPackage(cand(), 3, out));
    expect(row).toMatchObject({ candidateId: cand().id, version: 3, assessment: "RESEARCH_INCOMPLETE" }); expect(row.haltReason).not.toBeNull();
    expect(() => buildResearchPackage(cand(), 0, out)).toThrow(RangeError);
  });
});

describe("runCandidateResearch", () => {
  const memorySink = () => {
    const saved: Array<{ version: number; row: ReturnType<typeof toResearchPackageRow> }> = []; const counts = new Map<string, number>();
    const sink: ResearchPackageSink = { async save(id, build) { const v = (counts.get(id) ?? 0) + 1; counts.set(id, v); const row = build(v); saved.push({ version: v, row }); return { id: `pkg-${saved.length}`, version: v }; } };
    return { sink, saved };
  };
  const base = () => ({ registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: cfg, deps: { now: () => NOW, sleep: async () => undefined }, refuse: async () => undefined });
  it("researches a candidate from either pipeline, saving a package whose stored version matches its content", async () => {
    const { sink, saved } = memorySink();
    const t = await runCandidateResearch(cand(), { ...base(), sink });
    const i = await runCandidateResearch(cand({ id: "bbbbbbbb-2222-4222-8222-222222222222", source: "INDEPENDENT" }), { ...base(), sink });
    const again = await runCandidateResearch(cand(), { ...base(), sink });
    expect(t).toMatchObject({ version: 1, research: { candidateSource: "TELEGRAM", grantsApproval: false } });
    expect(i).toMatchObject({ version: 1, research: { candidateSource: "INDEPENDENT" } });
    expect(again).toMatchObject({ version: 2, research: { version: 2 } });
    expect(saved[2]?.row.agentResults.version).toBe(2); expect(saved[2]?.row.version).toBe(2);
  });
  it("a disabled engine does nothing; an expired candidate is not researched; a failing safety check stops everything before any agent runs", async () => {
    const { sink, saved } = memorySink();
    expect(await runCandidateResearch(cand(), { ...base(), sink, config: { ...cfg, enabled: false } })).toEqual({ skipped: "ENGINE_DISABLED" });
    expect(await runCandidateResearch({ ...cand(), expiresAt: new Date(NOW.getTime() - 1) }, { ...base(), sink })).toEqual({ skipped: "CANDIDATE_EXPIRED" });
    await expect(runCandidateResearch(cand(), { ...base(), sink, refuse: async () => { throw new Error("kill switch active"); } })).rejects.toThrow(/kill switch/);
    expect(saved).toHaveLength(0);
  });
});
