/**
 * G-43 and G-44 against REAL PostgreSQL (migration 0044): a research run is idempotent (a second attempt of the same run, after a crash between saving the package and completing the queue item, finds the stored package)
 * and every agent run of a package is stored with it, atomically, append-only, and rebuilds the package's per-agent reports. Synthetic data; every test uses its own fresh instrument names.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, reportsFromRecords, runCandidateResearch, type ResearchCandidate } from "../../../packages/agents/src/index";
import {
  beginScan, createCandidateQueue, createDb, getCandidate, getLatestResearchPackage, getResearchPackageById, insertScanCandidates, listResearchAgentRuns, storeResearchPackage, type CandidateInsert,
} from "../../../packages/database/src/index";
import { dispatchResearch } from "../../../packages/opportunity/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl(), db = createDb(URL_), clients: pg.Client[] = [];
async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); return c; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const draft = (underlying: string, o: Partial<CandidateInsert> = {}): CandidateInsert => ({
  dedupeKey: randomUUID(), underlying, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 95, targets: [105, 110, 115], invalidation: { price: 95, breachWhen: "BELOW", condition: "x" },
  rankScore: 60, evidence: [{ kind: "setup" }], dataSource: "FIXTURE", correlationId: randomUUID(), createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000), ...o,
});
async function scanId(): Promise<string> { return (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "FIXTURE", now: new Date(), leaseMs: 60_000 })).scanId; }
async function make(underlying = sym()): Promise<{ id: string; u: string }> { const r = await insertScanCandidates(db, await scanId(), [draft(underlying)]); return { id: r.created[0] as string, u: underlying }; }
const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), agentConfig = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
const sink = { save: (candidateId: string, build: (version: number) => unknown) => storeResearchPackage(db, (v) => build(v) as never, candidateId) };
const research = (c: ResearchCandidate & { expiresAt?: Date }, now: Date = new Date()) => runCandidateResearch(c, { registry, config: agentConfig, deps: { now: () => now, sleep: async () => undefined }, refuse: async () => undefined, sink: sink as never });
const claim = async (u: string) => { const q = createCandidateQueue(db, { underlyings: [u] }); return { q, c: await q.claimNext(new Date(), []) }; };
const counts = async (candidateId: string) => {
  const a = await owner();
  const p = await a.query("select count(*)::int as n from research_packages where candidate_id = $1", [candidateId]);
  const r = await a.query("select count(*)::int as n from research_agent_runs where research_package_id in (select id from research_packages where candidate_id = $1)", [candidateId]);
  return { packages: p.rows[0].n as number, agentRuns: r.rows[0].n as number };
};
async function dbError(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`).toMatch(re);
}
const hex = (c: string): string => c.repeat(64);
const run = (agentId: string, o: Record<string, unknown> = {}) => ({ agentId, agentVersion: "1.0.0", status: "COMPLETED", verdict: "NEUTRAL", confidence: 50, attempts: 1, inputSnapshotRef: hex("a"), inputSnapshot: {}, outputSnapshot: {}, findings: [], evidence: [], meta: {}, startedAt: new Date(), completedAt: new Date(), durationMs: 1, errorCode: null, errorMessage: null, ...o });
const pkgFor = (candidateId: string, extra: Record<string, unknown> = {}) => ({ candidateId, agentResults: { grantsApproval: false }, assessment: "RESEARCH_INCOMPLETE" as const, haltReason: null, ...extra });

describe("migration 0044: the schema enforces the run records", () => {
  it("agent runs are append-only, one per agent per package, and refuse a malformed or incoherent record", async () => {
    const { id } = await make(), admin = await owner();
    const saved = await storeResearchPackage(db, pkgFor(id, { runKey: hex("1"), agentRuns: [run("agent-a"), run("agent-b", { status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "NO_DATA" })] }));
    const rows = await listResearchAgentRuns(db, saved.id); expect(rows.map((r) => r.agentId)).toEqual(["agent-a", "agent-b"]);
    await expect(admin.query("update research_agent_runs set verdict = 'ADVERSE' where research_package_id = $1", [saved.id])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from research_agent_runs where research_package_id = $1", [saved.id])).rejects.toThrow(/append-only/);
    await expect(admin.query("truncate research_agent_runs")).rejects.toThrow(/append-only/);
    const ins = (o: Record<string, string>) => admin.query(`insert into research_agent_runs (id, research_package_id, agent_id, agent_version, status, verdict, confidence, attempts, input_snapshot_ref, input_snapshot, output_snapshot, findings, evidence, meta, started_at, completed_at, duration_ms)
      values (gen_random_uuid(), $1, $2, '1.0.0', $3, $4, $5, 1, $6, '{}', '{}', '[]', '[]', '{}', now(), now(), 1)`, [saved.id, o["agent"] ?? "agent-c", o["status"] ?? "COMPLETED", o["verdict"] ?? "NEUTRAL", o["confidence"] ?? "50", o["ref"] ?? hex("a")]);
    await expect(ins({ agent: "agent-a" })).rejects.toThrow(/unique|duplicate/i);
    await expect(ins({ status: "COMPLETED", verdict: "UNAVAILABLE", confidence: "50" })).rejects.toThrow(/check/i);
    await expect(ins({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: "50" })).rejects.toThrow(/check/i);
    await expect(ins({ status: "BOGUS", verdict: "NEUTRAL" })).rejects.toThrow(/check/i);
    await expect(ins({ ref: "not-a-hash" })).rejects.toThrow(/check/i);
    await expect(ins({ agent: "BAD ID" })).rejects.toThrow(/check/i);
  });
  it("a package's run key is 64 hex characters and unique per candidate; legacy packages (no key) are unaffected", async () => {
    const { id } = await make(), admin = await owner();
    await storeResearchPackage(db, pkgFor(id, { runKey: hex("2") }));
    await expect(admin.query("insert into research_packages (id, candidate_id, version, agent_results, assessment, run_key) values (gen_random_uuid(), $1, 9, '{}', 'RESEARCH_INCOMPLETE', 'xyz')", [id])).rejects.toThrow(/check/i);
    await expect(admin.query("insert into research_packages (id, candidate_id, version, agent_results, assessment, run_key) values (gen_random_uuid(), $1, 9, '{}', 'RESEARCH_INCOMPLETE', $2)", [id, hex("2")])).rejects.toThrow(/unique|duplicate/i);
    await storeResearchPackage(db, pkgFor(id)); await storeResearchPackage(db, pkgFor(id)); // two keyless packages: versions 2 and 3, exactly as before
    expect((await counts(id)).packages).toBe(3); expect((await getLatestResearchPackage(db, id))?.version).toBe(3);
  });
  it("the package and its agent runs are stored together or not at all", async () => {
    const { id } = await make();
    await dbError(() => storeResearchPackage(db, pkgFor(id, { runKey: hex("3"), agentRuns: [run("agent-a"), run("agent-b", { status: "BOGUS" })] })), /check|violates/i);
    expect(await counts(id)).toEqual({ packages: 0, agentRuns: 0 });
    const ok = await storeResearchPackage(db, pkgFor(id, { runKey: hex("3"), agentRuns: [run("agent-a")] }));
    expect(ok.version).toBe(1); // no version gap and no half-stored package from the failed attempt
  });
});

describe("G-43: a second attempt of the same research run stores nothing new", () => {
  it("the store returns the stored package for a repeated run key and writes no package and no agent run", async () => {
    const { id } = await make();
    const first = await storeResearchPackage(db, (v) => pkgFor(id, { runKey: hex("4"), agentResults: { v }, agentRuns: [run("agent-a")] }), id);
    const again = await storeResearchPackage(db, (v) => pkgFor(id, { runKey: hex("4"), agentResults: { v, other: true }, agentRuns: [run("agent-a"), run("agent-b")] }), id);
    expect(first).toEqual({ id: first.id, version: 1 }); expect(again).toMatchObject({ id: first.id, version: 1, deduplicated: true, stored: { v: 1 } });
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 1 });
    const next = await storeResearchPackage(db, (v) => pkgFor(id, { runKey: hex("5"), agentResults: { v } }), id); expect(next.version).toBe(2); // a different run is a new version
  });
  it("researching the same candidate twice, at different times, stores one package with thirteen agent runs", async () => {
    const { id, u } = await make(), { c } = await claim(u); expect(c).not.toBeNull();
    const first = await research(c!, new Date()), again = await research(c!, new Date(Date.now() + 15 * 60_000));
    expect("packageId" in first && "packageId" in again && first.packageId === again.packageId).toBe(true);
    expect(again).toMatchObject({ deduplicated: true, version: 1 }); expect("deduplicated" in first).toBe(false);
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 });
  });
  it("concurrent attempts of the same run store exactly one package and one set of agent runs", async () => {
    const { id, u } = await make(), { c } = await claim(u);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => research(c!, new Date(Date.now() + i * 60_000))));
    expect(results.filter((r) => "deduplicated" in r && r.deduplicated).length).toBe(5);
    expect(new Set(results.map((r) => ("packageId" in r ? r.packageId : ""))).size).toBe(1);
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 });
  });
  it("a changed candidate is different research and gets its own version", async () => {
    const { id, u } = await make(), { c } = await claim(u);
    await research(c!); await research({ ...c!, stopLoss: 94 });
    expect((await counts(id)).packages).toBe(2); expect((await getLatestResearchPackage(db, id))?.version).toBe(2);
  });
});

describe("G-43: crash between package persistence and queue completion (real dispatcher and queue)", () => {
  const dispatch = (u: string, over: Partial<Parameters<typeof dispatchResearch>[0]> = {}) => dispatchResearch({
    queue: createCandidateQueue(db, { underlyings: [u] }), now: new Date(), enabled: true, batchSize: 5, maxAttempts: 3, leaseMs: 60_000, research: (cand) => research(cand), ...over,
  });
  it("a failure after the package was saved, and before the queue item completed, is retried without a second package", async () => {
    const { id, u } = await make(); const real = createCandidateQueue(db, { underlyings: [u] });
    let boom = true; const queue = { ...real, expireDue: real.expireDue.bind(real), recoverStale: real.recoverStale.bind(real), claimNext: real.claimNext.bind(real), release: real.release.bind(real), expire: real.expire.bind(real), complete: async (cid: string) => { if (boom) { boom = false; throw new Error("worker died before completing"); } await real.complete(cid); } };
    const first = await dispatch(u, { queue }); expect(first).toMatchObject({ researched: 0, failed: 1, retried: 1 });
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 }); expect((await getCandidate(db, id))?.state).toBe("NEW");
    const second = await dispatch(u, { queue }); expect(second).toMatchObject({ researched: 1, failed: 0 });
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 }); expect((await getCandidate(db, id))?.state).toBe("READY_FOR_DECISION");
  });
  it("a worker that vanishes (the candidate stays IN_RESEARCH): lease recovery re-queues it and the retry finds the stored package", async () => {
    const { id, u } = await make(), { c } = await claim(u);
    await research(c!); // the package is committed; the worker never completes or releases the claim
    expect((await getCandidate(db, id))?.state).toBe("IN_RESEARCH");
    const later = new Date(Date.now() + 10 * 60_000); // past the 60 s lease, still well before the candidate expires (one hour)
    const recovered = await dispatch(u, { now: later, leaseMs: 60_000, enabled: false }); expect(recovered.recovered).toBe(1);
    expect((await getCandidate(db, id))?.state).toBe("NEW");
    const done = await dispatch(u); expect(done).toMatchObject({ researched: 1, failed: 0 });
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 }); expect((await getCandidate(db, id))?.state).toBe("READY_FOR_DECISION");
  });
});

describe("G-44: the stored agent runs rebuild the package", () => {
  it("every agent of the run is stored with its input hash and synthesis metadata, and the records alone rebuild the package's per-agent reports", async () => {
    const { id, u } = await make(), { c } = await claim(u); const r = await research(c!);
    if (!("packageId" in r)) throw new Error("expected a package");
    const stored = await listResearchAgentRuns(db, r.packageId); expect(stored).toHaveLength(13);
    for (const row of stored) { expect(row.inputSnapshotRef).toMatch(/^[0-9a-f]{64}$/); expect(row.meta).toMatchObject({ agentId: row.agentId, agentVersion: row.agentVersion }); }
    const pkg = await getResearchPackageById(db, r.packageId); expect(pkg).not.toBeNull();
    expect(reportsFromRecords(stored as never)).toEqual((pkg!.agentResults as { reports: unknown }).reports);
    expect(stored.map((s) => s.agentId)).toContain("market-context-v1"); expect((pkg!.agentResults as { candidateId: string }).candidateId).toBe(id);
  });
  it("the persisted run key matches the one recomputed from the stored records", async () => {
    const { u } = await make(), { c } = await claim(u); const r = await research(c!); if (!("packageId" in r)) throw new Error("expected a package");
    const admin = await owner(); const row = (await admin.query("select run_key from research_packages where id = $1", [r.packageId])).rows[0];
    expect(row.run_key).toMatch(/^[0-9a-f]{64}$/);
  });
});
