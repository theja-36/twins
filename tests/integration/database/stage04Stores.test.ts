/**
 * Stage 04 persistence against REAL PostgreSQL (migration 0035 and the stores): regimes are idempotent, research packages version per candidate, AI usage is append-only and
 * isolated per user by row-level security. Everything is synthetic; rows use fresh UUIDs because protected tables cannot be cleaned up.
 */
import { allowSystemBinding, bindEveryTransaction } from "../support/boundSession";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, runCandidateResearch } from "../../../packages/agents/src/index";
import { createAiUsageStore, createDb, getLatestResearchPackage, storeMarketRegimeRows, storeResearchPackage } from "../../../packages/database/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl();
const db = createDb(URL_);
const clients: pg.Client[] = [];
const ROLE = "twins_rls_test";
async function owner(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c);
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} nologin nosuperuser nobypassrls; end if; end $$`);
  await c.query(`grant usage on schema public to ${ROLE}`); await c.query(`grant select, insert, update, delete, truncate on all tables in schema public to ${ROLE}`);
  return c;
}
async function session(userId: string | null): Promise<pg.Client> { const c = await owner(); await allowSystemBinding(c, ROLE); await c.query(`set role ${ROLE}`); return bindEveryTransaction(c, userId); }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });

const usage = (o: Partial<Parameters<ReturnType<typeof createAiUsageStore>["record"]>[0]> = {}) => ({
  at: new Date().toISOString(), userId: null as string | null, task: "research_narrative", provider: "fixture", model: "m1", promptId: "research-narrative", promptVersion: "1.0.0", promptSha256: "a".repeat(64),
  inputTokens: 100, outputTokens: 50, costUsd: 0.00035, latencyMs: 20, attempt: 1, outcome: "OK", errorKind: null, requestId: randomUUID(), gatewayVersion: "ai-gateway-v1", ...o,
});
async function newCandidate(c: pg.Client): Promise<string> {
  const scanId = randomUUID(), id = randomUUID();
  await c.query("insert into opportunity_scans (id, scan_kind, detector_version, data_source) values ($1, 'fixture-scan', 'test-v1', 'FIXTURE')", [scanId]);
  await c.query("insert into opportunity_candidates (id, source, scan_id, underlying, side, entry_kind, data_source, correlation_id, expires_at) values ($1, 'INDEPENDENT', $2, 'NIFTY', 'BUY', 'above', 'FIXTURE', $3, now() + interval '1 day')", [id, scanId, randomUUID()]);
  return id;
}

describe("market regime store", () => {
  it("stores observations once; a repeat of the same observation is ignored; the table is append-only", async () => {
    const asOf = new Date(Date.now() - 60_000), und = `T${randomUUID().slice(0, 6).toUpperCase()}`;
    const row = { underlying: und, timeframe: "15m" as const, direction: "BULLISH" as const, regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", evidence: [{ kind: "regime_measures" }], detectorVersion: "market-regime-v1", dataSource: "FIXTURE" as const, asOf };
    expect(await storeMarketRegimeRows(db, [row])).toBe(1);
    expect(await storeMarketRegimeRows(db, [row])).toBe(0);
    expect(await storeMarketRegimeRows(db, [{ ...row, timeframe: "1h" }])).toBe(1);
    expect(await storeMarketRegimeRows(db, [])).toBe(0);
    const admin = await owner();
    await expect(admin.query("update market_regimes set regime = 'RISK_OFF' where underlying = $1", [und])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from market_regimes where underlying = $1", [und])).rejects.toThrow(/append-only/);
  });
});

describe("research package store", () => {
  it("each evaluation of a candidate is the next version; the latest is readable; versions never collide under concurrency", async () => {
    const admin = await owner(); const candidateId = await newCandidate(admin);
    const input = { candidateId, agentResults: { grantsApproval: false, reports: [] }, assessment: "RESEARCH_INCOMPLETE" as const, haltReason: "REQUIRED_AGENT_MISSING" };
    const first = await storeResearchPackage(db, input);
    expect(first.version).toBe(1);
    const both = await Promise.all([storeResearchPackage(db, input), storeResearchPackage(db, input)]);
    expect(both.map((x) => x.version).sort()).toEqual([2, 3]);
    expect(await getLatestResearchPackage(db, candidateId)).toMatchObject({ version: 3, assessment: "RESEARCH_INCOMPLETE", haltReason: "REQUIRED_AGENT_MISSING" });
    expect(await getLatestResearchPackage(db, randomUUID())).toBeNull();
    await expect(admin.query("update research_packages set assessment = 'RESEARCH_SUPPORTIVE' where candidate_id = $1", [candidateId])).rejects.toThrow(/append-only/);
  });
  it("an unknown assessment is refused by the database", async () => {
    const admin = await owner(); const candidateId = await newCandidate(admin);
    await expect(storeResearchPackage(db, { candidateId, agentResults: {}, assessment: "APPROVED" as never, haltReason: null })).rejects.toThrow();
  });
});

describe("AI usage ledger", () => {
  it("platform usage is recorded and counted in the day's spend; user usage is recorded for that user only", async () => {
    const admin = await owner(); const userId = randomUUID();
    await admin.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
    const platform = createAiUsageStore(db), mine = createAiUsageStore(db, userId);
    const before = await platform.spentTodayUsd(new Date());
    await platform.record(usage({ costUsd: 0.5 }));
    expect(await platform.spentTodayUsd(new Date())).toBeCloseTo(before + 0.5, 6);
    await mine.record(usage({ userId, costUsd: 0.25 }));
    await expect(platform.record(usage({ userId }))).rejects.toThrow(/scope/); // a record must match the store's scope
  });
  it("usage rows are append-only and violate no vocabulary: bad outcome, negative cost and a malformed prompt hash are refused", async () => {
    const admin = await owner(); const store = createAiUsageStore(db); const r = usage();
    await store.record(r);
    await expect(admin.query("update ai_usage_records set cost_usd = 0 where request_id = $1", [r.requestId])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from ai_usage_records where request_id = $1", [r.requestId])).rejects.toThrow(/append-only/);
    await expect(store.record(usage({ outcome: "SUCCESS" }))).rejects.toThrow();
    await expect(store.record(usage({ costUsd: -1 }))).rejects.toThrow();
    await expect(store.record(usage({ promptSha256: "nothex" }))).rejects.toThrow();
  });
  it("row-level security: a user sees their own and platform rows, never another user's; a foreign user_id cannot be written", async () => {
    const admin = await owner(); const a = randomUUID(), b = randomUUID();
    for (const u of [a, b]) await admin.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [u, `${u}@example.invalid`]);
    const reqA = randomUUID(), reqB = randomUUID(), reqP = randomUUID();
    await createAiUsageStore(db, a).record(usage({ userId: a, requestId: reqA }));
    await createAiUsageStore(db, b).record(usage({ userId: b, requestId: reqB }));
    await createAiUsageStore(db).record(usage({ requestId: reqP }));
    const asA = await session(a), nobody = await session(null);
    const seen = async (c: pg.Client) => (await c.query("select request_id from ai_usage_records where request_id = any($1)", [[reqA, reqB, reqP]])).rows.map((x) => x.request_id as string).sort();
    expect(await seen(asA)).toEqual([reqA, reqP].sort());
    expect(await seen(nobody)).toEqual([reqP]);
    await expect(asA.query("insert into ai_usage_records (id, user_id, occurred_at, task, provider, model, prompt_id, prompt_version, prompt_sha256, input_tokens, output_tokens, cost_usd, latency_ms, attempt, outcome, request_id, gateway_version) values ($1, $2, now(), 't', 'p', 'm', 'x', '1.0.0', $3, 1, 1, 0, 1, 1, 'OK', $4, 'v')", [randomUUID(), b, "a".repeat(64), randomUUID()])).rejects.toThrow(/row-level security/);
  });
});

describe("candidate research path (both pipelines, real database)", () => {
  it("a Telegram-style and an independent candidate are researched by the same agents and saved as append-only package versions", async () => {
    const admin = await owner(); const candidateId = await newCandidate(admin);
    const cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
    const sink = { save: (id: string, build: Parameters<typeof storeResearchPackage>[1]) => storeResearchPackage(db, build, id) };
    const cand = { id: candidateId, source: "INDEPENDENT" as const, underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE" as const, expiry: "2026-12-31", side: "BUY" as const, entryKind: "at" as const, entryLow: 120, entryHigh: null, stopLoss: 90, targets: [150], dataSource: "FIXTURE" as const, createdAt: new Date() };
    const run = (c: typeof cand = cand) => runCandidateResearch(c, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: cfg, sink: sink as never, refuse: async () => undefined });
    // G-43: researching the SAME candidate again is the same run (an identical retry stores nothing new); research of a CHANGED candidate is a new run and a new append-only version
    const a = await run(), same = await run(), b = await run({ ...cand, stopLoss: 85 });
    expect(a).toMatchObject({ version: 1, research: { assessment: "RESEARCH_INCOMPLETE", grantsApproval: false } }); expect(same).toMatchObject({ version: 1, deduplicated: true }); expect(b).toMatchObject({ version: 2 });
    const stored = await getLatestResearchPackage(db, candidateId);
    expect(stored).toMatchObject({ version: 2, assessment: "RESEARCH_INCOMPLETE" });
    expect((stored?.agentResults as { version: number; packageSha256: string }).version).toBe(2);
  });
});
