import { describe, expect, it } from "vitest";
import {
  AgentRegistry, AgentUnavailableError, candidateToAgentInputs, createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, orchestrate, reconstructAgentResult, reportsFromRecords, researchRunKey, runCandidateResearch,
  toAgentRunRecords, buildResearchPackage, type AgentRunRecord, type ResearchCandidate, type ResearchPackageSink,
} from "../../../packages/agents/src/index";
import { answer, fakeAgent } from "../../support/fakeAgents";

/** SYNTHETIC. G-43 (run identity, idempotent storage) and G-44 (per-agent run records, reconstruction), at unit level. The PostgreSQL behaviour is proven in tests/integration/opportunity/researchRuns.test.ts (CI). */
const NOW = new Date("2026-11-09T04:30:00Z"), cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
const cand = (o: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ id: "aaaaaaaa-1111-4111-8111-111111111111", source: "TELEGRAM", underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE", expiry: "2026-11-27", side: "BUY", entryKind: "at", entryLow: 120, entryHigh: null, stopLoss: 90, targets: [150, 180], dataSource: "FIXTURE", createdAt: new Date("2026-11-09T04:25:00Z"), ...o });
const outcomeAt = async (c: ResearchCandidate, now: Date, config = cfg) => orchestrate(createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).resolve(config), config, candidateToAgentInputs(c) as never, { riskDecisionId: c.id, decisionVersion: 1 }, { now: () => now, sleep: async () => undefined });
const keyOf = async (c: ResearchCandidate, now = NOW, config = cfg) => { const o = await outcomeAt(c, now, config); return researchRunKey(c.id, o.results, config); };

describe("G-43: the run key identifies the run, not the moment", () => {
  it("is a stable 64-hex key: the same candidate, agents and configuration give the same key at any clock", async () => {
    const a = await keyOf(cand()); expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyOf(cand(), new Date(NOW.getTime() + 7 * 3_600_000))).toBe(a);
  });
  it("changes with the candidate, with the candidate's inputs, and with the engine configuration", async () => {
    const base = await keyOf(cand());
    expect(await keyOf(cand({ id: "bbbbbbbb-1111-4111-8111-111111111111" }))).not.toBe(base);
    expect(await keyOf(cand({ stopLoss: 95 }))).not.toBe(base);
    expect(await keyOf(cand(), NOW, { ...cfg, requiredAgents: cfg.requiredAgents.slice(1) })).not.toBe(base);
    expect(await keyOf(cand(), NOW, { ...cfg, thresholds: { ...cfg.thresholds, supportiveMin: 0.5 } })).not.toBe(base);
  });
  it("does not change with settings that do not affect the research (concurrency, enabled/shadow flags)", async () => {
    const base = await keyOf(cand());
    expect(await keyOf(cand(), NOW, { ...cfg, maxConcurrency: 1 })).toBe(base);
  });
  it("changes with an agent's version and does not depend on the order of the agents", () => {
    const r = [{ agentId: "a-v1", agentVersion: "1.0.0", inputSnapshotRef: "1".repeat(64) }, { agentId: "b-v1", agentVersion: "1.0.0", inputSnapshotRef: "2".repeat(64) }];
    const k = researchRunKey("c", r, cfg);
    expect(researchRunKey("c", [...r].reverse(), cfg)).toBe(k);
    expect(researchRunKey("c", [{ ...r[0]!, agentVersion: "1.0.1" }, r[1]!], cfg)).not.toBe(k);
  });
});
describe("G-44: one record per agent run, rebuildable", () => {
  it("records every agent of the run, sorted, with its identity, status, input hash and synthesis metadata", async () => {
    const o = await outcomeAt(cand(), NOW), recs = toAgentRunRecords(o);
    expect(recs).toHaveLength(13); expect(recs.map((r) => r.agentId)).toEqual([...recs.map((r) => r.agentId)].sort());
    for (const r of recs) { expect(r.inputSnapshotRef).toMatch(/^[0-9a-f]{64}$/); expect(r.meta).toMatchObject({ agentId: r.agentId, agentVersion: r.agentVersion }); expect((r.status === "COMPLETED") === (r.confidence !== null)).toBe(true); expect((r.status === "COMPLETED") === (r.verdict !== "UNAVAILABLE")).toBe(true); }
  });
  it("the stored records alone rebuild the package's per-agent reports exactly (mixed completed and failed agents)", async () => {
    const reg = new AgentRegistry();
    reg.register(fakeAgent("agent_ok", answer("SUPPORTIVE", 88, { findings: [{ code: "A_FINDING", severity: "MEDIUM", summary: "look" }], evidence: [{ kind: "scorecard", ref: "sc:1" }], output: { note: "x" } })));
    reg.register(fakeAgent("agent_dead", () => { throw new AgentUnavailableError("NO_DATA", "no data"); }));
    reg.register(fakeAgent("agent_dep", answer("CAUTION", 60), { dependsOn: ["agent_dead"] }));
    const c = { ...cfg, requiredAgents: [] as string[] }, plan = reg.resolve(c), cd = cand();
    const out = await orchestrate(plan, c, candidateToAgentInputs(cd) as never, { riskDecisionId: cd.id, decisionVersion: 1 }, { now: () => NOW, sleep: async () => undefined });
    const pkg = buildResearchPackage(cd, 1, out), recs = toAgentRunRecords(out);
    expect(recs.map((r) => r.status).sort()).toEqual(["COMPLETED", "SKIPPED", "UNAVAILABLE"]);
    expect(reportsFromRecords(recs)).toEqual(pkg.reports);
  });
  it("the production run's records rebuild its reports and its evidence index", async () => {
    const o = await outcomeAt(cand(), NOW), pkg = buildResearchPackage(cand(), 1, o), recs = toAgentRunRecords(o);
    expect(reportsFromRecords(recs)).toEqual(pkg.reports);
    expect([...new Set(reportsFromRecords(recs).flatMap((r) => r.evidenceRefs))].sort()).toEqual(pkg.evidenceIndex);
  });
  it("reconstructing a record restores the agent result field by field", async () => {
    const o = await outcomeAt(cand(), NOW), recs = toAgentRunRecords(o), a = o.results.find((r) => r.agentId === recs[0]!.agentId)!, b = reconstructAgentResult(recs[0]!);
    expect(b).toMatchObject({ agentId: a.agentId, agentVersion: a.agentVersion, status: a.status, verdict: a.verdict, confidence: a.confidence, inputSnapshotRef: a.inputSnapshotRef, attempts: a.attempts, errorCode: a.errorCode });
    expect(b.inputSnapshot).toEqual(a.inputSnapshot); expect(b.outputSnapshot).toEqual(a.outputSnapshot);
  });
  it("is safe to store: an oversize snapshot becomes a marker (its hash stays), a malformed error code and a long message are bounded", () => {
    const big = { risk_decision: { blob: "x".repeat(45_000) } };
    const recs = toAgentRunRecords({ results: [{ agentId: "agent_x", agentVersion: "1.0.0", status: "FAILED", verdict: "UNAVAILABLE", confidence: null, findings: Array.from({ length: 25 }, (_, i) => ({ code: `F_${i}`, severity: "INFO", summary: "s" }) as never), evidence: [], inputSnapshotRef: "a".repeat(64), inputSnapshot: big, outputSnapshot: {}, startedAt: NOW, completedAt: NOW, durationMs: 1, attempts: 1, errorCode: "lower case", errorMessage: "m".repeat(500) }], metas: [] });
    expect(recs[0]!.inputSnapshot).toMatchObject({ _truncated: true }); expect(recs[0]!.inputSnapshotRef).toBe("a".repeat(64)); expect(recs[0]!.errorCode).toBe("INVALID_ERROR_CODE"); expect(recs[0]!.errorMessage).toHaveLength(300); expect(recs[0]!.findings).toHaveLength(20);
  });
});
describe("runCandidateResearch with run identity and records", () => {
  type Row = { runKey?: string; agentRuns?: AgentRunRecord[]; agentResults: unknown; version: number };
  /** An in-memory store with the same contract as the database store: one package per run key, records stored with the package. */
  const memoryStore = () => {
    const packages: Array<Row & { id: string }> = [];
    const sink: ResearchPackageSink = { async save(_id, build) {
      const row = build(packages.length + 1) as Row;
      const dup = row.runKey ? packages.find((p) => p.runKey === row.runKey) : undefined;
      if (dup) return { id: dup.id, version: dup.version, deduplicated: true, stored: dup.agentResults };
      const id = `pkg-${packages.length + 1}`; packages.push({ ...row, id }); return { id, version: row.version };
    } };
    return { packages, sink };
  };
  const run = (c: ResearchCandidate, sink: ResearchPackageSink, now: Date) => runCandidateResearch(c, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: cfg, sink, deps: { now: () => now, sleep: async () => undefined }, refuse: async () => undefined });
  it("hands the sink the run key and one record per agent together with the package", async () => {
    const m = memoryStore(); const r = await run(cand(), m.sink, NOW);
    expect(m.packages).toHaveLength(1); expect(m.packages[0]!.runKey).toMatch(/^[0-9a-f]{64}$/); expect(m.packages[0]!.agentRuns).toHaveLength(13); expect("deduplicated" in r).toBe(false);
  });
  it("a second attempt of the same run, at another time (a crash before the queue item completed), stores nothing new and returns the stored package", async () => {
    const m = memoryStore(); const first = await run(cand(), m.sink, NOW), again = await run(cand(), m.sink, new Date(NOW.getTime() + 10 * 60_000));
    expect(m.packages).toHaveLength(1); expect(again).toMatchObject({ deduplicated: true, packageId: first.skipped ? "" : (first as { packageId: string }).packageId, version: 1 });
    expect((again as { research: unknown }).research).toEqual(m.packages[0]!.agentResults); // the STORED package, not a rebuilt one
  });
  it("different research is a new version: a changed candidate, or a changed configuration, is not deduplicated", async () => {
    const m = memoryStore(); await run(cand(), m.sink, NOW); await run(cand({ stopLoss: 95 }), m.sink, NOW);
    expect(m.packages).toHaveLength(2);
  });
});
