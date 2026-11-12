/**
 * Shared fixture for integration tests that need a real approved, executed (and optionally closed) PAPER trade. Fixture providers only: the clock is Monday 10:30 IST in 2031, prices come from a memory provider declared FIXTURE,
 * instrument specifications are test data. (Extracted from the Stage 07 test setup; the Stage 07 test keeps its own copy so that it stays self-contained.)
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { appendCapitalProfile, appendRiskPolicy, beginScan, createCandidateQueue, createDb, getCandidate, getDecision, getPositionForDecision, insertScanCandidates, listDecisions, storeResearchPackage, type CandidateInsert } from "../../../packages/database/src/index";
import { evaluateCandidateForAccount, memorySpecProvider, type InstrumentSpec, type PortfolioProvider } from "../../../packages/planning/src/index";
import { approveDecision, runDecisionCycle, DEFAULT_DECISION_CONFIG } from "../../../packages/decision/src/index";
import { DEFAULT_EXECUTION_CONFIG, monitorPositions, requestPaperExecution, type ExecutionDeps, type PriceObservation } from "../../../packages/execution/src/index";
import { FEES, SPEC } from "../../unit/planning/fixtures";
import { requireTestDatabaseUrl } from "../targetConfig";

export const URL_ = requireTestDatabaseUrl();
export const db = createDb(URL_);
export const NOW = new Date("2031-01-06T05:00:00Z");
const clients: pg.Client[] = [];
let sharedOwnerClient: pg.Client | null = null;
/** One long-lived owner connection for the fixtures that only run plain autocommit statements (newUser, pipeline): a test file that builds many pipelines would otherwise open one connection per call and exhaust the server. Never use it for transactions or SET ROLE. */
export async function ownerShared(): Promise<pg.Client> { return (sharedOwnerClient ??= await owner()); }
export async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); return c; }
export async function session(userId: string): Promise<pg.Client> {
  const c = await owner();
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'twins_rls_test') then create role twins_rls_test nologin nosuperuser nobypassrls; end if; end $$`); await c.query("grant usage on schema public to twins_rls_test"); await c.query("grant select, insert, update, delete, truncate on all tables in schema public to twins_rls_test");
  // migration 0048 removed PUBLIC EXECUTE from the definer doors: the session role holds exactly the doors the runtime role is granted in app-role.sql (not the guard, trigger or card-state functions)
  await c.query("grant execute on function twins_clear_login_failures(text), twins_create_user(text, text, text, text, uuid), twins_set_user_role(uuid, uuid, text), twins_set_user_active(uuid, uuid, boolean), twins_create_user_decision(jsonb), twins_end_user_decision(uuid, text, text, text), twins_invalidate_decision(uuid, text, jsonb, text), twins_record_decision_approval(uuid, text, jsonb, text, text), twins_list_active_accounts(), twins_list_active_account_users(integer) to twins_rls_test");
  await c.query("set role twins_rls_test"); await c.query("select set_config('twins.user_id', $1, false)", [userId]); return c;
}
export const closeClients = (): Promise<unknown> => Promise.all(clients.map((c) => c.end().catch(() => undefined)));
export const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const instruments: InstrumentSpec[] = [];
const specs = memorySpecProvider({ instruments, fees: [FEES] });
export const px: { current: PriceObservation | null } = { current: { price: 100, asOf: NOW.toISOString() } };
const prices = { name: "memory-fixture", dataSource: "FIXTURE" as const, price: async () => px.current };
const portfolio: PortfolioProvider = { name: "memory", portfolioFor: async () => ({ openPositions: [], realizedLossToday: "0", equityCurve: null, asOf: NOW.toISOString() }) };
const regime = { name: "memory", regimeFor: async (u: string) => ({ underlying: u, version: "market-regime-v1", asOf: NOW.toISOString(), dataSource: "LIVE", timeframes: [], direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", correlatedIndexAgreement: "ALIGNED", riskOff: false, freshness: { stale: false, usableTimeframes: 3, oldestUsableBarAgeSeconds: 60 }, flags: [], grantsApproval: false }) as never };
const quotes = { name: "memory", quoteFor: async () => ({ bid: 99.95, ask: 100.05, touchSize: 1_000_000, avgDailyVolume: 50_000_000 }) };
export const evalDeps = () => ({ db, specs, regime, portfolio, quotes, strategy: null, now: () => NOW });
export const execDeps = (): ExecutionDeps => ({ eval: evalDeps(), prices, config: { ...DEFAULT_EXECUTION_CONFIG, enabled: true, managementEnabled: true } });
const AGENTS = ["technical-structure-v1", "price-action-v1", "market-context-v1", "historical-pattern-v1", "news-sentiment-v1", "index-constituent-impact-v1", "market-calendar-v1", "macro-global-v1", "liquidity-v1", "options-risk-v1", "signal-integrity-v1", "instrument-verification-v1", "independent-challenger-v1"];
const research = (candidateId: string) => ({ packageVersion: "research-package-v1", candidateId, candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 1, assessment: "RESEARCH_SUPPORTIVE", halt: false, haltReason: null, score: 0.6, synthesisAlgorithmVersion: "s", reports: AGENTS.map((agentId, i) => ({ agentId, agentVersion: `${agentId}.1`, role: null, verdict: i % 5 === 0 ? "NEUTRAL" : "SUPPORTIVE", executionStatus: "COMPLETED", confidence: null, evidenceRefs: [`ev:${agentId}`], riskFlags: [], reasoningSummary: "x", inputSnapshotRef: "s", errorCode: null })), contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: Object.fromEntries(AGENTS.map((a) => [a, `${a}.1`])), evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b".repeat(64) });
const draft = (u: string, o: Partial<CandidateInsert> = {}): CandidateInsert => ({ dedupeKey: randomUUID(), underlying: u, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108, 112], invalidation: { price: 98, breachWhen: "BELOW", condition: "x" }, rankScore: 60, evidence: [{ kind: "setup", setupClass: "BREAKOUT_LONG", detector: "opportunity-setups-v1", timeframeSeconds: 900, signalBarAt: NOW.toISOString(), reasons: [] }], dataSource: "LIVE", correlationId: randomUUID(), createdAt: new Date("2031-01-06T04:50:00Z"), expiresAt: new Date("2031-01-06T08:00:00Z"), ...o });
export interface Pipe { u: string; userId: string; accountId: string; candId: string; decisionId: string }
export async function newUser(): Promise<{ userId: string; accountId: string }> {
  const a = await ownerShared(), userId = randomUUID(), accountId = randomUUID();
  await a.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
  await a.query("insert into accounts (id, user_id, name, trading_mode) values ($1, $2, 'paper account', 'paper')", [accountId, userId]);
  return { userId, accountId };
}
export async function pipeline(user?: { userId: string; accountId: string }): Promise<Pipe> {
  const a = await ownerShared(), { userId, accountId } = user ?? (await newUser()), u = sym();
  if (!user) {
    await a.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, 'PAPER', true, 'test')", [userId, accountId]);
    await appendCapitalProfile(db, userId, { accountId, totalCapital: "1000000", availableCapital: "1000000", maxPositionNotionalPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
    await appendRiskPolicy(db, userId, { accountId, riskPercent: "1", maxRiskPerTrade: null, maxDailyLoss: "20000", maxConcurrentPositions: 20, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: null, maxPortfolioExposurePct: null, maxCorrelatedRiskPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
  }
  instruments.push({ ...SPEC, underlying: u });
  const scan = (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "LIVE", now: NOW, leaseMs: 60_000 })).scanId;
  const candId = (await insertScanCandidates(db, scan, [draft(u)])).created[0] as string;
  const q = createCandidateQueue(db, { underlyings: [u] }); await q.claimNext(new Date(), []); await q.complete(candId);
  await storeResearchPackage(db, { candidateId: candId, agentResults: research(candId), assessment: "RESEARCH_SUPPORTIVE", haltReason: null });
  await evaluateCandidateForAccount(evalDeps(), { userId, accountId, candidate: (await getCandidate(db, candId))! });
  await runDecisionCycle({ ...evalDeps(), config: { ...DEFAULT_DECISION_CONFIG, enabled: true }, scope: { underlyings: [u] } });
  const d = (await listDecisions(db, userId, { candidateId: candId, limit: 5 }))[0];
  return { u, userId, accountId, candId, decisionId: d?.id ?? "" };
}
/** Approves and executes the decision at 100, then walks the price: "partial" stops after the first target rung, "close" continues until the stop closes the position. */
export async function trade(p: Pipe, upTo: "open" | "partial" | "close"): Promise<void> {
  px.current = { price: 100, asOf: NOW.toISOString() };
  await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: `approve-${p.decisionId.slice(0, 8)}` });
  await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: `exec-${p.decisionId.slice(0, 8)}` });
  if (upTo === "open") return;
  px.current = { price: 104.2, asOf: NOW.toISOString() }; await monitorPositions(execDeps());
  if (upTo === "partial") return;
  await finish();
}
/** Continues a partially exited trade: price holds (the stop is tightened), then falls through the stop and the position closes. */
export async function finish(): Promise<void> {
  px.current = { price: 105, asOf: NOW.toISOString() }; await monitorPositions(execDeps());
  px.current = { price: 99, asOf: NOW.toISOString() }; await monitorPositions(execDeps());
  px.current = { price: 100, asOf: NOW.toISOString() };
}
export { getDecision, getPositionForDecision };
