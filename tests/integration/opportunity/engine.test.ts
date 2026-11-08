/**
 * Stage 05 against REAL PostgreSQL (migration 0036 and the engine): the candidate lifecycle is enforced by the database, scans and research are idempotent and race-safe, and a full cycle runs
 * scan -> revalidate -> research with fixture data only. Synthetic data; every test uses its own fresh instrument names so nothing depends on, or disturbs, other tests' rows.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, memoryLastPrice, memoryOhlcProvider } from "../../../packages/agents/src/index";
import { beginScan, completeScan, createCandidateQueue, createDb, failScan, getCandidate, getLatestResearchPackage, insertScanCandidates, listCandidateEvents, listCandidates, type CandidateInsert } from "../../../packages/database/src/index";
import { dispatchResearch, runOpportunityCycle } from "../../../packages/opportunity/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { NOW, breakoutUp, cfg } from "../../unit/opportunity/fixtures";

const URL_ = requireTestDatabaseUrl();
const db = createDb(URL_);
const clients: pg.Client[] = [];
async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); return c; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

const draft = (underlying: string, o: Partial<CandidateInsert> = {}): CandidateInsert => ({
  dedupeKey: randomUUID(), underlying, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 95, targets: [105, 110, 115], invalidation: { price: 95, breachWhen: "BELOW", condition: "x" },
  rankScore: 60, evidence: [{ kind: "setup" }], dataSource: "FIXTURE", correlationId: randomUUID(), createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000), ...o,
});
async function scanId(): Promise<string> { return (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "FIXTURE", now: new Date(), leaseMs: 60_000 })).scanId; }
async function make(underlying = sym(), o: Partial<CandidateInsert> = {}): Promise<string> { const r = await insertScanCandidates(db, await scanId(), [draft(underlying, o)]); return r.created[0] as string; }

describe("candidate lifecycle is enforced by the database", () => {
  it("starts NEW, writes its own history, and a legal path is recorded end to end", async () => {
    const id = await make(); const q = createCandidateQueue(db);
    expect((await getCandidate(db, id))?.state).toBe("NEW");
    const admin = await owner();
    await admin.query("update opportunity_candidates set state = 'IN_RESEARCH' where id = $1", [id]);
    await q.complete(id);
    await admin.query("update opportunity_candidates set state = 'INVALIDATED', state_reason = 'STOP_BREACHED' where id = $1", [id]);
    const ev = (await listCandidateEvents(db, id)).map((e) => `${e.fromState}>${e.toState}`).reverse();
    expect(ev).toEqual(["null>NEW", "NEW>IN_RESEARCH", "IN_RESEARCH>READY_FOR_DECISION", "READY_FOR_DECISION>INVALIDATED"]);
    await expect(admin.query("update opportunity_candidate_events set reason = 'x' where candidate_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from opportunity_candidate_events where candidate_id = $1", [id])).rejects.toThrow(/append-only/);
  });
  it("rejects illegal transitions, a changed thesis, edits to finished candidates and reasonless endings", async () => {
    const admin = await owner(); const id = await make();
    await expect(admin.query("update opportunity_candidates set state = 'READY_FOR_DECISION' where id = $1", [id])).rejects.toThrow(/illegal candidate transition/);
    for (const set of ["stop_loss = 1", "side = 'SELL'", "underlying = 'X'", "targets = '[1]'::jsonb", "entry_low = 1", "expires_at = now() + interval '9 days'", "invalidation = '{}'::jsonb", "dedupe_key = 'z'"]) {
      await expect(admin.query(`update opportunity_candidates set ${set} where id = $1`, [id]), set).rejects.toThrow(/cannot change/);
    }
    await expect(admin.query("update opportunity_candidates set state = 'EXPIRED' where id = $1", [id])).rejects.toThrow(/needs a reason/);
    await expect(admin.query("update opportunity_candidates set state = 'SUPERSEDED', state_reason = 'x' where id = $1", [id])).rejects.toThrow(/names its successor/);
    await expect(admin.query("insert into opportunity_candidates (id, source, scan_id, underlying, side, entry_kind, data_source, correlation_id, expires_at, state) values ($1, 'INDEPENDENT', $2, 'X', 'BUY', 'at', 'FIXTURE', $3, now() + interval '1 day', 'IN_RESEARCH')", [randomUUID(), await scanId(), randomUUID()])).rejects.toThrow(/must start NEW/);
    await admin.query("update opportunity_candidates set state = 'WITHDRAWN', state_reason = 'test' where id = $1", [id]);
    await expect(admin.query("update opportunity_candidates set state = 'NEW' where id = $1", [id])).rejects.toThrow(/cannot change state/);
    await expect(admin.query("update opportunity_candidates set state_reason = 'edited' where id = $1", [id])).rejects.toThrow(/finished candidate/);
  });
  it("the origin rule still holds: an independent candidate needs a scan and no claim", async () => {
    const admin = await owner();
    await expect(admin.query("insert into opportunity_candidates (id, source, underlying, side, entry_kind, data_source, correlation_id, expires_at) values ($1, 'INDEPENDENT', 'X', 'BUY', 'at', 'FIXTURE', $2, now() + interval '1 day')", [randomUUID(), randomUUID()])).rejects.toThrow(/origin_check/);
  });
});

describe("scans are idempotent per slot", () => {
  it("the same slot scans once; a failed slot is retried; a crashed (stale) slot is taken over", async () => {
    const slot = randomUUID(), base = { scanKind: "TEST", slotKey: slot, parameters: { a: 1 }, detectorVersion: "t", dataSource: "FIXTURE" as const, leaseMs: 60_000 };
    const t0 = new Date();
    const a = await beginScan(db, { ...base, now: t0 }); expect(a.state).toBe("STARTED");
    expect((await beginScan(db, { ...base, now: t0 })).state).toBe("IN_PROGRESS");
    await failScan(db, a.scanId, { errorKind: "NO_USABLE_DATA", universeSize: 1, skipped: [{ underlying: "X", reason: "NO_DATA" }], now: t0 });
    const r = await beginScan(db, { ...base, now: t0 }); expect(r).toMatchObject({ scanId: a.scanId, state: "RESTARTED" });
    expect((await beginScan(db, { ...base, now: new Date(t0.getTime() + 120_000) })).state).toBe("RESTARTED"); // RUNNING past its lease
    await completeScan(db, a.scanId, { candidateCount: 0, universeSize: 1, skipped: [], now: t0 });
    expect(await beginScan(db, { ...base, now: t0 })).toMatchObject({ scanId: a.scanId, state: "ALREADY_COMPLETED" });
    const admin = await owner(); const { rows: got } = await admin.query("select status, error_kind, candidate_count, skipped from opportunity_scans where id = $1", [a.scanId]);
    expect(got[0]).toMatchObject({ status: "COMPLETED", error_kind: null, candidate_count: 0 });
  });
});

describe("candidate insertion: dedupe and supersession", () => {
  it("the same setup twice is one candidate; a newer setup of the same instrument/side supersedes the old one, which names its successor", async () => {
    const u = sym(), s = await scanId();
    const a = draft(u, { createdAt: new Date(Date.now() - 120_000) });
    const first = await insertScanCandidates(db, s, [a]);
    expect(first).toMatchObject({ duplicates: 0, superseded: 0 }); expect(first.created).toHaveLength(1);
    expect(await insertScanCandidates(db, s, [a])).toMatchObject({ created: [], duplicates: 1 });
    const b = draft(u, { createdAt: new Date(Date.now() - 60_000) });
    const second = await insertScanCandidates(db, s, [b]);
    expect(second.superseded).toBe(1);
    const old = await getCandidate(db, first.created[0]!);
    expect(old).toMatchObject({ state: "SUPERSEDED", supersededBy: second.created[0], stateReason: "SUPERSEDED_BY_NEWER_SETUP" });
    expect((await getCandidate(db, second.created[0]!))?.state).toBe("NEW");
    const other = await insertScanCandidates(db, s, [draft(u, { side: "SELL", stopLoss: 105 })]); // a different side is not superseded
    expect(other.superseded).toBe(0);
  });
});

describe("the research queue", () => {
  it("many concurrent workers claim each candidate exactly once, best rank first", async () => {
    const u = sym(); const scope = { underlyings: [u] }; const q = createCandidateQueue(db, scope);
    const s = await scanId();
    await insertScanCandidates(db, s, [draft(u, { rankScore: 10, setup: "A" }), draft(u, { rankScore: 90, setup: "B" }), draft(u, { rankScore: 50, setup: "C" })]);
    const got = (await Promise.all(Array.from({ length: 8 }, () => q.claimNext(NOW, [])))).filter(Boolean);
    expect(got).toHaveLength(3);
    expect(new Set(got.map((g) => g!.id)).size).toBe(3);
    expect(await q.claimNext(NOW, [])).toBeNull();
    expect((await listCandidates(db, { states: ["IN_RESEARCH"], limit: 10, scope })).map((c) => c.rankScore).sort((a, b) => a! - b!)).toEqual([10, 50, 90]);
  });
  it("release uses an attempt and withdraws at the maximum; an uncounted release does not; stale claims are recovered; expired ones expire", async () => {
    const u = sym(); const q = createCandidateQueue(db, { underlyings: [u] });
    const id = await make(u);
    await q.claimNext(NOW, []);
    expect(await q.release(id, "SAFETY_REFUSED", { count: false, maxAttempts: 2 })).toBe("RETRY");
    expect((await getCandidate(db, id))).toMatchObject({ state: "NEW", attempts: 0, stateReason: "SAFETY_REFUSED" });
    await q.claimNext(NOW, []); expect(await q.release(id, "RESEARCH_FAILED:Error", { count: true, maxAttempts: 2 })).toBe("RETRY");
    await q.claimNext(NOW, []); expect(await q.release(id, "RESEARCH_FAILED:Error", { count: true, maxAttempts: 2 })).toBe("WITHDRAWN");
    expect(await getCandidate(db, id)).toMatchObject({ state: "WITHDRAWN", attempts: 2 });
    const id2 = await make(u); await q.claimNext(NOW, []);
    expect(await q.recoverStale(new Date(Date.now() + 3_600_000), 60_000, 3)).toBeGreaterThanOrEqual(1);
    expect(await getCandidate(db, id2)).toMatchObject({ state: "NEW", attempts: 1, stateReason: "RESEARCH_LEASE_LOST" });
    const id3 = await make(u, { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 3_600_000) });
    expect(await q.expireDue(new Date())).toBeGreaterThanOrEqual(1);
    expect(await getCandidate(db, id3)).toMatchObject({ state: "EXPIRED", stateReason: "PAST_EXPIRY" });
  });
  it("a candidate ended while a worker held it is not resurrected by that worker", async () => {
    const u = sym(); const q = createCandidateQueue(db, { underlyings: [u] }); const id = await make(u);
    await q.claimNext(NOW, []);
    const admin = await owner(); await admin.query("update opportunity_candidates set state = 'INVALIDATED', state_reason = 'STOP_BREACHED' where id = $1", [id]);
    await q.complete(id);
    expect(await q.release(id, "x", { count: true, maxAttempts: 3 })).toBe("WITHDRAWN");
    expect((await getCandidate(db, id))?.state).toBe("INVALIDATED");
  });
  it("dispatch researches only the scoped instruments, saves versioned packages and marks READY_FOR_DECISION; a failure retries", async () => {
    const u = sym(); const scope = { underlyings: [u] }; const q = createCandidateQueue(db, scope);
    const ok = await make(u), bad = await make(u, { setup: "OTHER" });
    const seen: string[] = [];
    const r = await dispatchResearch({ queue: q, now: new Date(), enabled: true, batchSize: 5, maxAttempts: 3, leaseMs: 60_000, research: async (c) => { seen.push(c.id); if (c.id === bad) throw new RangeError("boom"); return {}; } });
    expect(r).toMatchObject({ researched: 1, failed: 1, retried: 1 });
    expect((await getCandidate(db, ok))?.state).toBe("READY_FOR_DECISION");
    expect(await getCandidate(db, bad)).toMatchObject({ state: "NEW", attempts: 1, stateReason: "RESEARCH_FAILED:RangeError" });
  });
});

describe("a full cycle (fixture data only)", () => {
  it("scans, ranks, revalidates and researches; a repeat of the slot changes nothing; a price through the stop invalidates", async () => {
    const u = sym(); const series = breakoutUp(u);
    const ohlc = memoryOhlcProvider({ name: "fixture-ohlc", asOf: NOW.toISOString(), series: { [u]: series } });
    const lastClose = series.bars[series.bars.length - 1]!.close;
    const price = (p: number) => memoryLastPrice({ name: "fixture-price", prices: { [u]: { price: p, asOf: NOW.toISOString() } } });
    const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES });
    const agentConfig = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
    const deps = (lastPrice: ReturnType<typeof price>) => ({ db, config: cfg({ universe: [u], minRankScore: 20 }), ohlc, lastPrice, regime: null, registry, agentConfig, now: () => NOW, scope: { underlyings: [u] }, refuse: async () => undefined });
    const slot = `2031-01-05T09:45Z-${u}`;

    const first = await runOpportunityCycle(slot, deps(price(lastClose)));
    expect(first.scan).toMatchObject({ state: "STARTED", status: "COMPLETED", errorKind: null });
    expect(first.scan!.created).toBeGreaterThanOrEqual(1);
    expect(first.research).toMatchObject({ failed: 0 }); expect(first.research!.researched).toBe(first.scan!.created);
    const cands = await listCandidates(db, { limit: 50, scope: { underlyings: [u] } });
    expect(cands.every((c) => c.source === "INDEPENDENT" && c.state === "READY_FOR_DECISION" && c.dataSource === "FIXTURE")).toBe(true);
    const c0 = cands[0]!;
    expect(c0.stopLoss).not.toBeNull(); expect(c0.stopLoss!).toBeLessThan(c0.entryLow!);
    const pkg = await getLatestResearchPackage(db, c0.id);
    expect(pkg).toMatchObject({ version: 1, assessment: "RESEARCH_INCOMPLETE" }); // no providers are wired in this test: an honest INCOMPLETE, never a fabricated verdict
    expect((pkg!.agentResults as { grantsApproval: boolean }).grantsApproval).toBe(false);

    const again = await runOpportunityCycle(slot, deps(price(lastClose)));
    expect(again.scan).toMatchObject({ state: "ALREADY_COMPLETED", created: 0 });
    expect(again.research!.researched).toBe(0);
    expect((await getLatestResearchPackage(db, c0.id))?.version).toBe(1);

    const crash = await runOpportunityCycle(`${slot}-2`, deps(price(c0.stopLoss! - 1)));
    expect(crash.revalidation.invalidated).toBeGreaterThanOrEqual(1);
    expect((await getCandidate(db, c0.id))).toMatchObject({ state: "INVALIDATED", stateReason: "STOP_BREACHED" });
    expect((await listCandidateEvents(db, c0.id)).map((e) => e.toState)).toContain("INVALIDATED");
  });
  it("with no usable data the slot FAILS visibly (no candidates, no research) and is retried on the next delivery", async () => {
    const u = sym(); const ohlc = memoryOhlcProvider({ name: "fixture-ohlc", asOf: NOW.toISOString(), series: {} });
    const deps = { db, config: cfg({ universe: [u] }), ohlc, lastPrice: null, regime: null, registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), agentConfig: loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), now: () => NOW, scope: { underlyings: [u] }, refuse: async () => undefined };
    const slot = `fail-${u}`;
    expect((await runOpportunityCycle(slot, deps)).scan).toMatchObject({ status: "FAILED", errorKind: "NO_USABLE_DATA", created: 0 });
    expect((await runOpportunityCycle(slot, deps)).scan).toMatchObject({ state: "RESTARTED", status: "FAILED" });
    expect(await listCandidates(db, { limit: 5, scope: { underlyings: [u] } })).toEqual([]);
  });
  it("is skipped, not failed, while the safety state refuses; and does nothing when disabled", async () => {
    const u = sym();
    const base = { db, config: cfg({ universe: [u] }), ohlc: null, lastPrice: null, regime: null, registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), agentConfig: loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), now: () => NOW };
    const refused = await runOpportunityCycle(`s-${u}`, { ...base, refuse: async () => { throw Object.assign(new Error("refused"), { code: "safety_refused" }); } });
    expect(refused).toMatchObject({ skipped: "SAFETY_REFUSED", scan: null, research: null });
    expect(await runOpportunityCycle(`d-${u}`, { ...base, config: cfg({ enabled: false }) })).toMatchObject({ skipped: "DISABLED", scan: null });
    await expect(runOpportunityCycle(`e-${u}`, { ...base, refuse: async () => { throw new Error("db down"); } })).rejects.toThrow("db down"); // an unreadable state is an error to retry, never a pass
  });
});
