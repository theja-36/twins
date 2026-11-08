/**
 * Stage 06 against REAL PostgreSQL (migration 0037, the planning stores and the evaluation path): versioned capital and risk policy, owner isolation by row-level security, append-only risk controls with the recovery
 * policy enforced by the database, the risk verdict and simulation owner constraints, and a full candidate evaluation. Synthetic data only; every test uses fresh users and instrument names.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, appendCapitalProfile, appendRiskPolicy, clearRiskControl, createCandidateQueue, getCandidate, getConfidenceAssessment, getEffectiveCapitalProfile, getEffectiveRiskPolicy, getLatestRiskAssessment, insertScanCandidates, listActiveControls, listCapitalProfileVersions, beginScan, setRiskControl, storeConfidenceAssessment, storeRiskAssessment, storeSimulation, type CandidateInsert } from "../../../packages/database/src/index";
import { evaluateCandidateForAccount, memorySpecProvider, runEvaluationCycle, DEFAULT_EVALUATION_CONFIG, type PortfolioProvider } from "../../../packages/planning/src/index";
import { FEES, SPEC } from "../../unit/planning/fixtures";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl();
const db = createDb(URL_);
const clients: pg.Client[] = [];
const ROLE = "twins_rls_test";
let prepared = false;
async function owner(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c);
  if (!prepared) { await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} nologin nosuperuser nobypassrls; end if; end $$`); await c.query(`grant usage on schema public to ${ROLE}`); await c.query(`grant select, insert, update, delete, truncate on all tables in schema public to ${ROLE}`); prepared = true; }
  return c;
}
async function session(userId: string | null): Promise<pg.Client> { const c = await owner(); await c.query(`set role ${ROLE}`); if (userId) await c.query("select set_config('twins.user_id', $1, false)", [userId]); return c; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
async function newUser(): Promise<{ userId: string; accountId: string }> {
  const a = await owner(), userId = randomUUID(), accountId = randomUUID();
  await a.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
  await a.query("insert into accounts (id, user_id, name, trading_mode) values ($1, $2, 'paper account', 'paper')", [accountId, userId]);
  return { userId, accountId };
}
const POLICY = (accountId: string, o: Record<string, unknown> = {}) => ({ accountId, riskPercent: "1", maxRiskPerTrade: null, maxDailyLoss: "20000", maxConcurrentPositions: 3, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: null, maxPortfolioExposurePct: null, maxCorrelatedRiskPct: null, createdBy: "test", ...o });
const draft = (u: string): CandidateInsert => ({ dedupeKey: randomUUID(), underlying: u, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108, 112], invalidation: { price: 98, breachWhen: "BELOW", condition: "x" }, rankScore: 60, evidence: [], dataSource: "FIXTURE", correlationId: randomUUID(), createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
async function candidate(u: string): Promise<string> { const s = (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "FIXTURE", now: new Date(), leaseMs: 60_000 })).scanId; return (await insertScanCandidates(db, s, [draft(u)])).created[0] as string; }

describe("capital profile and risk policy versions", () => {
  it("each change is the next version (serialised), the effective one is chosen by date, and history is kept", async () => {
    const { userId, accountId } = await newUser();
    const mk = (n: number, at: Date) => appendCapitalProfile(db, userId, { accountId, totalCapital: String(n), availableCapital: String(n), maxPositionNotionalPct: null, effectiveFrom: at, createdBy: "test" });
    const t0 = new Date(Date.now() - 3_600_000);
    expect((await mk(100000, t0)).version).toBe(1);
    const both = await Promise.all([mk(200000, new Date(Date.now() - 1_800_000)), mk(300000, new Date(Date.now() - 900_000))]);
    expect(both.map((x) => x.version).sort()).toEqual([2, 3]);
    expect((await getEffectiveCapitalProfile(db, userId, accountId, new Date(t0.getTime() + 1000)))?.version).toBe(1);
    expect((await listCapitalProfileVersions(db, userId, accountId)).map((x) => x.version)).toEqual([3, 2, 1]);
    expect(await getEffectiveCapitalProfile(db, userId, accountId, new Date(t0.getTime() - 1000))).toBeNull();
    const p = await appendRiskPolicy(db, userId, POLICY(accountId)); expect(p.version).toBe(1);
    expect(await getEffectiveRiskPolicy(db, userId, accountId, new Date())).toMatchObject({ version: 1, riskPercent: "1", maxDrawdownPct: null });
    const admin = await owner();
    await expect(admin.query("update user_capital_profiles set total_capital = 1 where account_id = $1", [accountId])).rejects.toThrow(/append-only/);
  });
  it("the database refuses a risk percent above the 5% ceiling, capital above total, and out-of-range limits", async () => {
    const { userId, accountId } = await newUser();
    await expect(appendRiskPolicy(db, userId, POLICY(accountId, { riskPercent: "6" }))).rejects.toThrow();
    await expect(appendRiskPolicy(db, userId, POLICY(accountId, { maxCorrelatedRiskPct: "9" }))).rejects.toThrow();
    await expect(appendRiskPolicy(db, userId, POLICY(accountId, { maxDrawdownPct: "0" }))).rejects.toThrow();
    await expect(appendCapitalProfile(db, userId, { accountId, totalCapital: "100", availableCapital: "200", maxPositionNotionalPct: null, createdBy: "t" })).rejects.toThrow();
    await expect(appendCapitalProfile(db, userId, { accountId, totalCapital: "100", availableCapital: "50", maxPositionNotionalPct: "150", createdBy: "t" })).rejects.toThrow();
  });
  it("a user's capital and policy are invisible to another user, and one cannot write for another's account", async () => {
    const a = await newUser(), b = await newUser();
    await appendCapitalProfile(db, a.userId, { accountId: a.accountId, totalCapital: "1000", availableCapital: "1000", maxPositionNotionalPct: null, createdBy: "t" });
    await appendRiskPolicy(db, a.userId, POLICY(a.accountId));
    const sb = await session(b.userId);
    expect((await sb.query("select id from user_capital_profiles where account_id = $1", [a.accountId])).rows).toEqual([]);
    expect((await sb.query("select id from user_risk_policies where account_id = $1", [a.accountId])).rows).toEqual([]);
    await expect(appendCapitalProfile(db, b.userId, { accountId: a.accountId, totalCapital: "1", availableCapital: "1", maxPositionNotionalPct: null, createdBy: "t" })).rejects.toThrow();
    const sa = await session(a.userId);
    expect((await sa.query("select id from user_capital_profiles where account_id = $1", [a.accountId])).rows).toHaveLength(1);
  });
});

describe("risk controls", () => {
  it("are append-only; the latest event decides; expiry is honoured; platform controls are visible to all, user controls only to their owner", async () => {
    const a = await newUser(), b = await newUser(), key = sym();
    const now = new Date();
    await setRiskControl(db, { scope: "MARKET", scopeKey: key, kind: "RESTRICTION", userId: null }, { reason: "platform restriction for test", actor: "ops", actorKind: "OWNER" });
    await setRiskControl(db, { scope: "USER", scopeKey: a.userId, kind: "DAILY_LOSS_HALT", userId: a.userId }, { reason: "daily limit reached in test", actor: "planning-cycle", actorKind: "SYSTEM", expiresAt: new Date(Date.now() + 3_600_000) });
    const forA = await listActiveControls(db, a.userId, new Date(now.getTime() + 1000)), forB = await listActiveControls(db, b.userId, new Date(now.getTime() + 1000));
    expect(forA.some((c) => c.scopeKey === key)).toBe(true); expect(forA.some((c) => c.kind === "DAILY_LOSS_HALT" && c.userId === a.userId)).toBe(true);
    expect(forB.some((c) => c.scopeKey === key)).toBe(true); expect(forB.some((c) => c.kind === "DAILY_LOSS_HALT")).toBe(false);
    expect((await listActiveControls(db, a.userId, new Date(Date.now() + 7_200_000))).some((c) => c.kind === "DAILY_LOSS_HALT" && c.userId === a.userId)).toBe(false); // expired
    await clearRiskControl(db, { scope: "MARKET", scopeKey: key, kind: "RESTRICTION", userId: null }, { reason: "restriction lifted after review", actor: "ops", actorKind: "OWNER" });
    expect((await listActiveControls(db, a.userId, new Date(Date.now() + 1000))).some((c) => c.scopeKey === key)).toBe(false);
    const admin = await owner();
    await expect(admin.query("update risk_control_events set reason = 'edited reason here' where scope_key = $1", [key])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from risk_control_events where scope_key = $1", [key])).rejects.toThrow(/append-only/);
  });
  it("the database enforces the recovery policy: the system can never clear a drawdown halt or a kill switch, and a reason is mandatory", async () => {
    const u = await newUser(), admin = await owner();
    const ins = (kind: string, action: string, actorKind: string, reason = "a sufficiently long reason") => admin.query("insert into risk_control_events (id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind) values ($1, $2, 'USER', $2, $3, $4, $5, 'x', $6)", [randomUUID(), u.userId, kind, action, reason, actorKind]);
    await ins("DRAWDOWN_HALT", "SET", "SYSTEM");
    await expect(ins("DRAWDOWN_HALT", "CLEAR", "SYSTEM")).rejects.toThrow(/clear_policy_check/);
    await expect(ins("KILL_SWITCH", "CLEAR", "SYSTEM")).rejects.toThrow(/clear_policy_check/);
    await ins("DRAWDOWN_HALT", "CLEAR", "OWNER");
    await ins("DAILY_LOSS_HALT", "CLEAR", "SYSTEM");
    await expect(ins("RESTRICTION", "SET", "OWNER", "short")).rejects.toThrow(/reason_check/);
    await expect(admin.query("insert into risk_control_events (id, scope, kind, action, reason, actor, actor_kind) values ($1, 'USER', 'RESTRICTION', 'SET', 'long enough reason', 'x', 'OWNER')", [randomUUID()])).rejects.toThrow(/user_scope_check/);
    await expect(admin.query("insert into risk_control_events (id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at) values ($1, 'MARKET', 'NSE', 'RESTRICTION', 'CLEAR', 'long enough reason', 'x', 'OWNER', now())", [randomUUID()])).rejects.toThrow(/expiry_check/);
  });
});

describe("assessments and simulations", () => {
  it("confidence is stored once per candidate and model; a repeat returns the stored row", async () => {
    const id = await candidate(sym());
    const row = { candidateId: id, score: 61.25, components: { a: 1 }, supporting: [], contradicting: [], missing: ["X"], riskFlags: [], historicalComparison: null, explanation: "strength only", calibrationStatus: "UNCALIBRATED" as const, modelVersion: "confidence-strength-v1" };
    const first = await storeConfidenceAssessment(db, row), again = await storeConfidenceAssessment(db, { ...row, score: 99 });
    expect(first.created).toBe(true); expect(again).toEqual({ id: first.id, created: false });
    expect(await getConfidenceAssessment(db, id, "confidence-strength-v1")).toMatchObject({ score: 61.25, calibrationStatus: "UNCALIBRATED" });
    await expect(storeConfidenceAssessment(db, { ...row, modelVersion: "m2", score: 101 })).rejects.toThrow();
  });
  it("a restricted result is not a pass; a simulation can only point at its own owner's assessment", async () => {
    const a = await newUser(), b = await newUser(), c = await candidate(sym()), admin = await owner();
    const id = await storeRiskAssessment(db, a.userId, { accountId: a.accountId, candidateId: c, policyVersion: 1, verdict: "RESTRICTED", blockers: [], result: { x: 1 }, researchPackageId: null });
    expect((await getLatestRiskAssessment(db, a.userId, a.accountId, c))).toMatchObject({ id, verdict: "RESTRICTED" });
    const { rows } = await admin.query("select passed, verdict from risk_assessments where id = $1", [id]); expect(rows[0]).toEqual({ passed: false, verdict: "RESTRICTED" });
    await expect(admin.query("insert into risk_assessments (id, user_id, account_id, candidate_id, policy_version, passed, verdict, result) values ($1, $2, $3, $4, 1, true, 'RESTRICTED', '{}')", [randomUUID(), a.userId, a.accountId, c])).rejects.toThrow(/verdict_check/);
    await storeSimulation(db, a.userId, { accountId: a.accountId, candidateId: c, params: {}, scenarios: {}, costModelVersion: "cost-model-v1", riskAssessmentId: id });
    await expect(storeSimulation(db, b.userId, { accountId: b.accountId, candidateId: c, params: {}, scenarios: {}, costModelVersion: "cost-model-v1", riskAssessmentId: id })).rejects.toThrow(/assessment_owner_fk/);
    const sb = await session(b.userId);
    expect((await sb.query("select id from risk_assessments where id = $1", [id])).rows).toEqual([]);
    await expect(admin.query("update risk_assessments set verdict = 'PASS', passed = true where id = $1", [id])).rejects.toThrow(/append-only/);
  });
});

describe("candidate evaluation (fixture inputs, real database)", () => {
  const MON = new Date("2031-01-06T05:00:00Z"); // Monday 10:30 IST
  it("sizes, assesses and simulates a candidate for an account; repeats are suppressed; a breached daily loss halts the account", async () => {
    const u = sym(), { userId, accountId } = await newUser(), candId = await candidate(u);
    await appendCapitalProfile(db, userId, { accountId, totalCapital: "1000000", availableCapital: "1000000", maxPositionNotionalPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
    await appendRiskPolicy(db, userId, POLICY(accountId, { effectiveFrom: new Date("2030-01-01T00:00:00Z") }));
    const specs = memorySpecProvider({ instruments: [{ ...SPEC, underlying: u }], fees: [FEES] });
    let loss = "0";
    const portfolio: PortfolioProvider = { name: "memory", portfolioFor: async () => ({ openPositions: [], realizedLossToday: loss, equityCurve: null, asOf: MON.toISOString() }) };
    const regime = { name: "memory", regimeFor: async () => ({ underlying: u, version: "market-regime-v1", asOf: MON.toISOString(), dataSource: "LIVE", timeframes: [], direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", correlatedIndexAgreement: "ALIGNED", riskOff: false, freshness: { stale: false, usableTimeframes: 3, oldestUsableBarAgeSeconds: 60 }, flags: [], grantsApproval: false }) as never };
    const quotes = { name: "memory", quoteFor: async () => ({ bid: 99.95, ask: 100.05, touchSize: 1_000_000, avgDailyVolume: 50_000_000 }) };
    const deps = { db, specs, regime, portfolio, quotes, strategy: null, now: () => MON };
    const cand = (await getCandidate(db, candId))!;

    const first = await evaluateCandidateForAccount(deps, { userId, accountId, candidate: cand });
    expect(first.status).toBe("EVALUATED");
    if (first.status !== "EVALUATED") return;
    expect(first.sizing.status).toBe("SIZED"); expect(first.verdict).not.toBe("BLOCKED");
    expect(Number(first.sizing.maxLossAtStop)).toBeLessThanOrEqual(10_000);
    expect(first.risk).toMatchObject({ policyVersion: 1, grantsApproval: false, stop: { independentlyValidated: false } });
    const stored = await getLatestRiskAssessment(db, userId, accountId, candId);
    expect(stored).toMatchObject({ id: first.riskAssessmentId, verdict: first.verdict });
    expect(await getConfidenceAssessment(db, candId, "confidence-strength-v1")).toMatchObject({ calibrationStatus: "UNCALIBRATED" });
    const admin = await owner();
    expect((await admin.query("select risk_assessment_id from simulations where id = $1", [first.simulationId])).rows[0]).toEqual({ risk_assessment_id: first.riskAssessmentId });
    expect(await evaluateCandidateForAccount(deps, { userId, accountId, candidate: cand })).toEqual({ status: "RECENT", reason: "ALREADY_EVALUATED" });

    // a user with no capital profile is skipped, never defaulted
    const other = await newUser();
    expect(await evaluateCandidateForAccount(deps, { userId: other.userId, accountId: other.accountId, candidate: cand })).toEqual({ status: "NOT_CONFIGURED", reason: "NO_CAPITAL_PROFILE" });

    // the cycle halts the account when the daily loss is reached, and the halt then BLOCKS the next evaluation
    loss = "20000";
    const q = createCandidateQueue(db, { underlyings: [u] }); await q.claimNext(new Date(), []); await q.complete(candId);
    const report = await runEvaluationCycle({ ...deps, config: { ...DEFAULT_EVALUATION_CONFIG, enabled: true, reevaluateMinutes: 0 }, scope: { underlyings: [u] }, reevaluateMinutes: 0 } as never);
    expect(report.haltsSet).toBeGreaterThanOrEqual(1);
    const active = await listActiveControls(db, userId, MON);
    expect(active.find((c) => c.kind === "DAILY_LOSS_HALT" && c.userId === userId)).toBeDefined();
    expect(report.evaluated).toBeGreaterThanOrEqual(1);
    const after = await getLatestRiskAssessment(db, userId, accountId, candId);
    expect(after?.verdict).toBe("BLOCKED");
    const codes = ((after?.result as { risk: { reasons: Array<{ code: string }> } }).risk.reasons).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["CONTROL_DAILY_LOSS_HALT", "DAILY_LOSS_LIMIT_REACHED"]));
  });
  it("is disabled by default and does nothing", async () => {
    expect(await runEvaluationCycle({ db, config: DEFAULT_EVALUATION_CONFIG, specs: null, regime: null, portfolio: null, quotes: null, strategy: null })).toMatchObject({ skipped: "DISABLED", evaluated: 0 });
  });
});
