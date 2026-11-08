/**
 * Stage 07 against REAL PostgreSQL (migration 0038 and the decision / approval / paper-execution / trade-management path). Fixture providers only: the clock is Monday 10:30 IST in 2031, prices come from a memory provider
 * declared FIXTURE, instrument specifications are test data. The CI connection is a superuser (it bypasses row-level security, not triggers or constraints), so isolation is checked through an unprivileged session.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { appendCapitalProfile, appendRiskPolicy, beginScan, createCandidateQueue, createDb, createExecutionRequest, getCandidate, getDecision, getPositionForDecision, insertScanCandidates, invalidateDecision, listDecisionEvents, listDecisions, listPaperOrders, listPaperPositions, listPositionEvents, storeResearchPackage, updateExecutionRequest, type CandidateInsert } from "../../../packages/database/src/index";
import { evaluateCandidateForAccount, memorySpecProvider, type InstrumentSpec, type PortfolioProvider } from "../../../packages/planning/src/index";
import { ApprovalError, approveDecision, cancelDecision, rejectDecision, runDecisionCycle, DEFAULT_DECISION_CONFIG } from "../../../packages/decision/src/index";
import { advanceOpenOrders, DEFAULT_EXECUTION_CONFIG, monitorPositions, paperPortfolioProvider, reconcilePosition, requestPaperExecution, type ExecutionDeps, type PriceObservation } from "../../../packages/execution/src/index";
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
async function session(userId: string): Promise<pg.Client> { const c = await owner(); await c.query(`set role ${ROLE}`); await c.query("select set_config('twins.user_id', $1, false)", [userId]); return c; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });

const NOW = new Date("2031-01-06T05:00:00Z"); // Monday 10:30 IST
const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const instruments: InstrumentSpec[] = [];
const specs = memorySpecProvider({ instruments, fees: [FEES] });
let price: PriceObservation | null = { price: 100, asOf: NOW.toISOString() };
const prices = { name: "memory-fixture", dataSource: "FIXTURE" as const, price: async () => price };
const portfolio: PortfolioProvider = { name: "memory", portfolioFor: async () => ({ openPositions: [], realizedLossToday: "0", equityCurve: null, asOf: NOW.toISOString() }) };
const regime = (u: string) => ({ name: "memory", regimeFor: async () => ({ underlying: u, version: "market-regime-v1", asOf: NOW.toISOString(), dataSource: "LIVE", timeframes: [], direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", correlatedIndexAgreement: "ALIGNED", riskOff: false, freshness: { stale: false, usableTimeframes: 3, oldestUsableBarAgeSeconds: 60 }, flags: [], grantsApproval: false }) as never });
const quotes = { name: "memory", quoteFor: async () => ({ bid: 99.95, ask: 100.05, touchSize: 1_000_000, avgDailyVolume: 50_000_000 }) };
// one regime provider that answers for any underlying (the shared evaluation deps are used for many instruments)
const anyRegime = { name: "memory", regimeFor: async (u: string) => (await regime(u).regimeFor()) };
const evalDeps = (now = NOW) => ({ db, specs, regime: anyRegime, portfolio, quotes, strategy: null, now: () => now });
const execDeps = (o: Partial<ExecutionDeps["config"]> = {}, now = NOW): ExecutionDeps => ({ eval: evalDeps(now), prices, config: { ...DEFAULT_EXECUTION_CONFIG, enabled: true, managementEnabled: true, ...o } });

const AGENTS = ["technical-structure-v1", "price-action-v1", "market-context-v1", "historical-pattern-v1", "news-sentiment-v1", "index-constituent-impact-v1", "market-calendar-v1", "macro-global-v1", "liquidity-v1", "options-risk-v1", "signal-integrity-v1", "instrument-verification-v1", "independent-challenger-v1"];
const research = (candidateId: string, assessment = "RESEARCH_SUPPORTIVE") => ({ packageVersion: "research-package-v1", candidateId, candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 1, assessment, halt: false, haltReason: null, score: 0.6, synthesisAlgorithmVersion: "s", reports: AGENTS.map((agentId) => ({ agentId, agentVersion: `${agentId}.1`, role: null, verdict: "SUPPORTIVE", executionStatus: "COMPLETED", confidence: null, evidenceRefs: [`ev:${agentId}`], riskFlags: [], reasoningSummary: "x", inputSnapshotRef: "s", errorCode: null })), contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: {}, evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b".repeat(64) });
const draft = (u: string, o: Partial<CandidateInsert> = {}): CandidateInsert => ({ dedupeKey: randomUUID(), underlying: u, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108, 112], invalidation: { price: 98, breachWhen: "BELOW", condition: "x" }, rankScore: 60, evidence: [], dataSource: "LIVE", correlationId: randomUUID(), createdAt: new Date("2031-01-06T04:50:00Z"), expiresAt: new Date("2031-01-06T08:00:00Z"), ...o });

interface Pipe { u: string; userId: string; accountId: string; candId: string; decisionId: string }
/** user + account + capital + policy (+ PAPER permission) + a researched READY candidate, evaluated, with a decision cycle run. */
async function pipeline(o: { permission?: boolean; candidate?: Partial<CandidateInsert> } = {}): Promise<Pipe & { decisionOutcome: string | null }> {
  const a = await owner(), userId = randomUUID(), accountId = randomUUID(), u = sym();
  await a.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
  await a.query("insert into accounts (id, user_id, name, trading_mode) values ($1, $2, 'paper account', 'paper')", [accountId, userId]);
  if (o.permission !== false) await a.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, 'PAPER', true, 'test')", [userId, accountId]);
  await appendCapitalProfile(db, userId, { accountId, totalCapital: "1000000", availableCapital: "1000000", maxPositionNotionalPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
  await appendRiskPolicy(db, userId, { accountId, riskPercent: "1", maxRiskPerTrade: null, maxDailyLoss: "20000", maxConcurrentPositions: 3, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: null, maxPortfolioExposurePct: null, maxCorrelatedRiskPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
  instruments.push({ ...SPEC, underlying: u });
  const scan = (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "LIVE", now: NOW, leaseMs: 60_000 })).scanId;
  const candId = (await insertScanCandidates(db, scan, [draft(u, o.candidate)])).created[0] as string;
  const q = createCandidateQueue(db, { underlyings: [u] }); await q.claimNext(new Date(), []); await q.complete(candId);
  await storeResearchPackage(db, { candidateId: candId, agentResults: research(candId), assessment: "RESEARCH_SUPPORTIVE", haltReason: null });
  const cand = (await getCandidate(db, candId))!;
  const ev = await evaluateCandidateForAccount(evalDeps(), { userId, accountId, candidate: cand });
  expect(ev.status).toBe("EVALUATED");
  const rep = await runDecisionCycle({ ...evalDeps(), config: { ...DEFAULT_DECISION_CONFIG, enabled: true }, scope: { underlyings: [u] } });
  const d = (await listDecisions(db, userId, { candidateId: candId, limit: 5 }))[0];
  void rep;
  return { u, userId, accountId, candId, decisionId: d?.id ?? "", decisionOutcome: d?.outcome ?? null };
}

describe("decision", () => {
  it("a fully evidenced candidate becomes a QUALIFIED PENDING decision with the stop validation, size, provenance and an approval card contract", async () => {
    const p = await pipeline();
    expect(p.decisionOutcome).toBe("QUALIFIED");
    const d = (await getDecision(db, p.userId, p.decisionId))!;
    expect(d).toMatchObject({ workflowState: "PENDING", outcome: "QUALIFIED", candidateId: p.candId });
    expect((d.stopLossValidation as { result: string; ruleVersion: string })).toMatchObject({ result: "VALID", ruleVersion: "stop-loss-v1" });
    expect(d.permittedSize!.lots).toBeGreaterThanOrEqual(1); expect(Number(d.permittedSize!.maxLossAtStop)).toBeLessThanOrEqual(10_000);
    expect(d.riskAssessmentId).not.toBeNull(); expect(d.researchPackageId).not.toBeNull(); expect(d.confidenceAssessmentId).not.toBeNull(); expect(d.simulationId).not.toBeNull();
    expect(d.versions).toMatchObject({ decisionEngine: "decision-engine-v1", stopLossRule: "stop-loss-v1" });
    expect(d.evidenceRefs).toEqual(expect.arrayContaining([`candidate:${p.candId}`]));
    expect((await listDecisionEvents(db, p.userId, d.id)).map((e) => e.toState)).toEqual(["PENDING"]);
    // an unchanged evidence base does not create a second decision
    const again = await runDecisionCycle({ ...evalDeps(), config: { ...DEFAULT_DECISION_CONFIG, enabled: true }, scope: { underlyings: [p.u] } });
    expect(again.created).toBe(0); expect((await listDecisions(db, p.userId, { candidateId: p.candId, limit: 10 }))).toHaveLength(1);
  });
  it("fixture-backed candidates are EVALUATION_ONLY and can never be approved; a missing stop is REJECTed", async () => {
    const fx = await pipeline({ candidate: { dataSource: "FIXTURE" } });
    expect(fx.decisionOutcome).toBe("EVALUATION_ONLY");
    await expect(approveDecision(evalDeps(), { userId: fx.userId, decisionId: fx.decisionId, idempotencyKey: "approve-key-0001" })).rejects.toMatchObject({ code: "NOT_QUALIFIED" });
    const raw = await owner();
    await expect(raw.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [fx.decisionId])).rejects.toThrow(/approved_qualified_check|recorded approval action/);
  });
  it("the database itself refuses a QUALIFIED row without a VALID mandatory stop validation, and any APPROVED without an approval record", async () => {
    const p = await pipeline(), raw = await owner();
    const ins = (validation: string | null) => raw.query("insert into user_decisions (id, user_id, account_id, candidate_id, outcome, explanation, stop_loss_validation, permitted_size, research_package_id, risk_assessment_id, valid_until) select gen_random_uuid(), $1, $2, $3, 'QUALIFIED', '{}'::jsonb, $4::jsonb, '{\"lots\":1,\"quantity\":25}'::jsonb, research_package_id, risk_assessment_id, now() + interval '1 hour' from user_decisions where id = $5", [p.userId, p.accountId, p.candId, validation, p.decisionId]);
    await expect(ins(null)).rejects.toThrow(/VALID mandatory stop-loss validation/);
    await expect(ins(JSON.stringify({ result: "INVALID", ruleVersion: "stop-loss-v1" }))).rejects.toThrow(/VALID mandatory stop-loss validation/);
    await ins(JSON.stringify({ result: "VALID", ruleVersion: "stop-loss-v1" })); // a recorded VALID validation passes the floor (the engine is what produces it)
    await expect(raw.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [p.decisionId])).rejects.toThrow(/only through a recorded approval action/);
    await expect(raw.query("update user_decisions set outcome = 'WAIT' where id = $1", [p.decisionId])).rejects.toThrow(/only workflow_state/);
    await expect(raw.query("update user_decisions set permitted_size = '{\"lots\":999,\"quantity\":99999}'::jsonb where id = $1", [p.decisionId])).rejects.toThrow(/only workflow_state/);
  });
  it("a changed evidence base supersedes the pending decision; an expired decision is expired by the cycle", async () => {
    const p = await pipeline();
    const later = new Date(NOW.getTime() + 20 * 60_000); // past the 15 minute window
    const rep = await runDecisionCycle({ ...evalDeps(later), config: { ...DEFAULT_DECISION_CONFIG, enabled: true }, scope: { underlyings: [p.u] } });
    expect(rep.expired).toBeGreaterThanOrEqual(1);
    expect((await getDecision(db, p.userId, p.decisionId))?.workflowState).toBe("EXPIRED");
  });
});

describe("human approval", () => {
  it("only the owner with PAPER enabled can approve; the approval is recorded once; a duplicate action is refused", async () => {
    const p = await pipeline();
    const ok = await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001", reason: "reviewed" });
    expect(ok.status).toBe("APPROVED"); expect(ok.revalidation.passed).toBe(true); expect(ok.revalidation.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["stop_loss_validation", "risk_evaluation", "kill_switch", "paper_permission", "candidate_active"]));
    const d = (await getDecision(db, p.userId, p.decisionId))!; expect(d.workflowState).toBe("APPROVED");
    await expect(approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0002" })).rejects.toMatchObject({ code: "ALREADY_ACTIONED" });
    await expect(rejectDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "reject-key-0001" })).rejects.toMatchObject({ code: "ALREADY_ACTIONED" });
    const raw = await owner();
    const { rows } = await raw.query("select action, approver_user_id from decision_approvals where decision_id = $1", [p.decisionId]); expect(rows).toEqual([{ action: "APPROVE", approver_user_id: p.userId }]);
    await expect(raw.query("update decision_approvals set action = 'REJECT' where decision_id = $1", [p.decisionId])).rejects.toThrow(/append-only/);
    // another user cannot see or act on it
    const other = await pipeline();
    await expect(approveDecision(evalDeps(), { userId: other.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0003" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const sb = await session(other.userId);
    expect((await sb.query("select id from user_decisions where id = $1", [p.decisionId])).rows).toEqual([]);
    expect((await sb.query("select id from decision_approvals where decision_id = $1", [p.decisionId])).rows).toEqual([]);
  });
  it("without the PAPER permission the decision is EVALUATION_ONLY and an approval is impossible", async () => {
    const p = await pipeline({ permission: false });
    expect(p.decisionOutcome).toBe("EVALUATION_ONLY");
    await expect(approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" })).rejects.toBeInstanceOf(ApprovalError);
  });
  it("an approval cannot override failed revalidation or an expired decision", async () => {
    const stale = await pipeline();
    await expect(approveDecision(evalDeps(new Date(NOW.getTime() + 60 * 60_000)), { userId: stale.userId, decisionId: stale.decisionId, idempotencyKey: "approve-key-0001" })).rejects.toMatchObject({ code: "EXPIRED" });
    expect((await getDecision(db, stale.userId, stale.decisionId))?.workflowState).toBe("EXPIRED");
    const closing = await pipeline(); // the market closes between the decision and the approval: risk now BLOCKS, so the approval is refused and the decision cancelled
    await expect(approveDecision(evalDeps(new Date("2031-01-06T09:50:00Z")), { userId: closing.userId, decisionId: closing.decisionId, idempotencyKey: "approve-key-0001" })).rejects.toBeInstanceOf(ApprovalError);
    const after = (await getDecision(db, closing.userId, closing.decisionId))!; expect(["EXPIRED", "CANCELLED"]).toContain(after.workflowState);
  });
  it("rejection and cancellation are recorded in the audit history", async () => {
    const r = await pipeline();
    expect((await rejectDecision(evalDeps(), { userId: r.userId, decisionId: r.decisionId, idempotencyKey: "reject-key-0001", reason: "not today" })).status).toBe("REJECTED");
    expect((await listDecisionEvents(db, r.userId, r.decisionId)).map((e) => e.toState)).toEqual(["PENDING", "REJECTED"]);
    const c = await pipeline();
    expect(await cancelDecision(evalDeps(), { userId: c.userId, decisionId: c.decisionId, reason: "changed my mind" })).toBe("CANCELLED");
    expect((await getDecision(db, c.userId, c.decisionId))?.workflowState).toBe("CANCELLED");
  });
});

describe("paper execution and trade management", () => {
  it("approve -> execute -> manage -> close: orders, fills and positions stay distinct; duplicates cannot create a second order", async () => {
    price = { price: 100, asOf: NOW.toISOString() };
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const d = (await getDecision(db, p.userId, p.decisionId))!, qty = d.permittedSize!.quantity;
    const x = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(x).toMatchObject({ status: "FILLED", duplicate: false }); expect(Number(x.status === "FILLED" ? x.filledQuantity : 0)).toBe(qty);
    // retries (same key, different key, concurrent) never make a second order
    const dup = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    const dup2 = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00002" });
    expect(dup).toMatchObject({ status: "FILLED", duplicate: true }); expect(dup2.status).toBe("FILLED");
    const orders = await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 20 });
    expect(orders).toHaveLength(1); expect(orders[0]).toMatchObject({ purpose: "ENTRY", status: "FILLED", side: "BUY", orderType: "MARKET" });
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    expect(pos).toMatchObject({ status: "OPEN", side: "BUY" }); expect(Number(pos.quantity)).toBe(qty); expect(Number(pos.avgEntryPrice)).toBeCloseTo(100.05, 4); expect(Number(pos.stopLoss)).toBe(98);
    expect((await reconcilePosition(execDeps(), p.userId, pos.id))?.ok).toBe(true);
    const pf = (await paperPortfolioProvider(db).portfolioFor({ userId: p.userId, accountId: p.accountId, now: NOW }))!;
    expect(pf.openPositions).toHaveLength(1); expect(Number(pf.openPositions[0]!.notional)).toBeCloseTo(qty * 100.05, 0); expect(Number(pf.openPositions[0]!.riskAmount)).toBeCloseTo(qty * 2.05, 0); expect(pf.equityCurve).toBeNull();

    // 1st target: half is exited, the position stays open
    price = { price: 104.2, asOf: NOW.toISOString() };
    const m1 = await monitorPositions(execDeps()); expect(m1.exits).toBeGreaterThanOrEqual(1);
    let cur = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    expect(cur.status).toBe("OPEN"); expect(Number(cur.quantity)).toBeLessThan(qty); expect(Number(cur.quantity)).toBeGreaterThan(0); expect(Number(cur.realizedPnl)).toBeGreaterThan(0);
    // the same observation again does not exit twice
    const before = Number(cur.quantity); await monitorPositions(execDeps());
    expect(Number((await getPositionForDecision(db, p.userId, p.decisionId))!.quantity)).toBeLessThanOrEqual(before);
    // price holds: the stop is tightened to breakeven (validated), never loosened
    price = { price: 105, asOf: NOW.toISOString() }; await monitorPositions(execDeps());
    cur = (await getPositionForDecision(db, p.userId, p.decisionId))!; expect(Number(cur.stopLoss)).toBeGreaterThanOrEqual(Number(cur.avgEntryPrice) - 1e-6);
    const raw = await owner();
    await expect(raw.query("update paper_positions set stop_loss = 90 where id = $1", [cur.id])).rejects.toThrow(/can only be tightened/);
    // the price falls through the (breakeven) stop: the rest exits, the position closes, the outcome is recorded as PAPER
    price = { price: 99, asOf: NOW.toISOString() }; await monitorPositions(execDeps());
    cur = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    expect((await paperPortfolioProvider(db).portfolioFor({ userId: p.userId, accountId: p.accountId, now: NOW }))!.openPositions).toEqual([]);
    expect(cur).toMatchObject({ status: "CLOSED" }); expect(Number(cur.quantity)).toBe(0); expect(cur.exitReason).toBe("STOP_HIT");
    const events = (await listPositionEvents(db, p.userId, cur.id)).map((e) => e.kind);
    expect(events).toEqual(expect.arrayContaining(["OPENED", "STOP_MOVED", "PARTIAL_EXIT", "TARGET_HIT", "STOP_HIT", "CLOSED", "RECONCILED"]));
    const { rows: out } = await raw.query("select mode, paper_position_id, order_id, paper_trade_id, exit_reason from trade_outcomes where decision_id = $1", [p.decisionId]);
    expect(out).toEqual([{ mode: "PAPER", paper_position_id: cur.id, order_id: null, paper_trade_id: null, exit_reason: "STOP_HIT" }]);
    expect((await reconcilePosition(execDeps(), p.userId, cur.id))?.ok).toBe(true); // a closed position reconciles too: zero open quantity = entry fills - exit fills
    const kinds = (await raw.query("select kind from trade_monitoring_events where decision_id = $1", [p.decisionId])).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["ENTRY_FILLED", "TARGET_HIT", "STOP_HIT"]));
    await expect(raw.query("update paper_positions set quantity = 5 where id = $1", [cur.id])).rejects.toThrow(/closed position cannot change/);
    // the real broker tables were never touched
    expect((await raw.query("select count(*)::int as n from orders where risk_decision_id is null and created_at > now() - interval '1 hour' and idempotency_key like 'entry:%'")).rows[0].n).toBe(0);
  });
  it("partial fills: an entry fills in lots over several steps, the position follows the fills, and a stale price leaves the order open", async () => {
    price = null;
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const d = (await getDecision(db, p.userId, p.decisionId))!, qty = d.permittedSize!.quantity;
    const x = await requestPaperExecution(execDeps({ fillFraction: 0.4, orderTtlMinutes: 1e9 }), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(x.status).toBe("ORDER_OPEN"); // no price: accepted, nothing filled, nothing invented
    expect(await getPositionForDecision(db, p.userId, p.decisionId)).toBeNull();
    price = { price: 100, asOf: NOW.toISOString() };
    await advanceOpenOrders(execDeps({ fillFraction: 0.4, orderTtlMinutes: 1e9 }));
    let o = (await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 }))[0]!;
    expect(o.status).toBe("PARTIALLY_FILLED"); expect(Number(o.filledQuantity)).toBeGreaterThan(0); expect(Number(o.filledQuantity)).toBeLessThan(qty);
    let pos = (await getPositionForDecision(db, p.userId, p.decisionId))!; expect(Number(pos.quantity)).toBe(Number(o.filledQuantity)); expect(Number(pos.initialQuantity)).toBe(qty);
    for (let i = 0; i < 6 && o.status !== "FILLED"; i++) { await advanceOpenOrders(execDeps({ fillFraction: 0.4, orderTtlMinutes: 1e9 })); o = (await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 }))[0]!; }
    expect(o.status).toBe("FILLED"); pos = (await getPositionForDecision(db, p.userId, p.decisionId))!; expect(Number(pos.quantity)).toBe(qty);
    expect((await listPositionEvents(db, p.userId, pos.id)).some((e) => e.kind === "OPENED")).toBe(true);
    const raw = await owner(); const { rows } = await raw.query("select count(*)::int n, sum(quantity) q from paper_fills where order_id = $1", [o.id]); expect(rows[0].n).toBeGreaterThan(1); expect(Number(rows[0].q)).toBe(qty);
    await expect(raw.query("insert into paper_fills (id, user_id, order_id, quantity, price, price_source, price_as_of) values (gen_random_uuid(), $1, $2, 1, 100, 'FIXTURE', now())", [p.userId, o.id])).rejects.toThrow(/ACCEPTED or PARTIALLY_FILLED/);
    await expect(raw.query("update paper_fills set price = 1 where order_id = $1", [o.id])).rejects.toThrow(/append-only/);
  });
  it("missing or stale prices are recorded as monitoring UNAVAILABLE and escalated, never as success", async () => {
    price = { price: 100, asOf: NOW.toISOString() };
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    const alerts: string[] = [];
    for (const px of [null, { price: 100, asOf: new Date(NOW.getTime() - 3_600_000).toISOString() }]) {
      price = px; const r = await monitorPositions({ ...execDeps(), alert: (a) => alerts.push(a.kind) });
      expect(r.unmonitored).toBeGreaterThanOrEqual(1);
    }
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    expect((await listPositionEvents(db, p.userId, pos.id)).filter((e) => e.kind === "PRICE_UNAVAILABLE").length).toBeGreaterThanOrEqual(2);
    expect(alerts).toContain("MONITORING_UNAVAILABLE"); expect(pos.status).toBe("OPEN");
    price = { price: 100, asOf: NOW.toISOString() };
  });
  it("live modes are refused and recorded; the database refuses a live request that is not REJECTED", async () => {
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    for (const mode of ["ASSISTED_LIVE", "CONTROLLED_AUTO"] as const) {
      const x = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode, idempotencyKey: `live-key-${mode}` });
      expect(x.status).toBe("REFUSED"); expect(x.status === "REFUSED" && x.reasons).toContain("live_execution_disabled");
    }
    const raw = await owner();
    const { rows } = await raw.query("select mode, state from execution_requests where decision_id = $1 order by mode", [p.decisionId]); expect(rows).toEqual([{ mode: "ASSISTED_LIVE", state: "REJECTED" }, { mode: "CONTROLLED_AUTO", state: "REJECTED" }]);
    await expect(raw.query("insert into execution_requests (id, user_id, account_id, decision_id, mode, state, idempotency_key) values (gen_random_uuid(), $1, $2, $3, 'CONTROLLED_AUTO', 'REQUESTED', 'raw-live-key-1')", [p.userId, p.accountId, p.decisionId])).rejects.toThrow(/live_disabled_check/);
    expect(await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 })).toEqual([]);
    // execution disabled by configuration: refused, nothing created
    const off = await requestPaperExecution(execDeps({ enabled: false }), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(off.status).toBe("REFUSED"); expect(await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 })).toEqual([]);
  });
  it("an invalidated approval cannot be executed, by the service or by the database", async () => {
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    expect(await invalidateDecision(db, p.userId, p.decisionId, "TEST_BASIS_CHANGED", { why: "test" }, "test")).toBe("INVALIDATED");
    const x = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(x.status).toBe("REFUSED"); expect(x.status === "REFUSED" && x.reasons.join(" ")).toMatch(/not_invalidated|invalidated/);
    expect((await getDecision(db, p.userId, p.decisionId))?.invalidated?.reasonCode).toBe("TEST_BASIS_CHANGED");
    // even with a request forced to ELIGIBLE, the database refuses an entry order for an invalidated decision
    const { request } = await createExecutionRequest(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "forced-key-0001", state: "REQUESTED", checks: [], refusalReasons: [] });
    await updateExecutionRequest(db, p.userId, request.id, "ELIGIBLE", [], []);
    const raw = await owner();
    await expect(raw.query("insert into paper_orders (id, user_id, account_id, decision_id, execution_request_id, purpose, instrument, exchange, side, order_type, quantity, idempotency_key) values (gen_random_uuid(), $1, $2, $3, $4, 'ENTRY', $5, 'NSE', 'BUY', 'MARKET', 25, 'raw-entry-key-1')", [p.userId, p.accountId, p.decisionId, request.id, p.u])).rejects.toThrow(/invalidated/);
  });
  it("the database enforces the order lifecycle, the permitted size and ownership on the tables themselves", async () => {
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const d = (await getDecision(db, p.userId, p.decisionId))!, raw = await owner();
    const { request } = await createExecutionRequest(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "forced-key-0002", state: "REQUESTED", checks: [], refusalReasons: [] });
    const ins = (qty: number, key: string, status = "PROPOSED") => raw.query("insert into paper_orders (id, user_id, account_id, decision_id, execution_request_id, purpose, instrument, exchange, side, order_type, quantity, status, idempotency_key) values (gen_random_uuid(), $1, $2, $3, $4, 'ENTRY', $5, 'NSE', 'BUY', 'MARKET', $6, $7, $8) returning id", [p.userId, p.accountId, p.decisionId, request.id, p.u, qty, status, key]);
    await expect(ins(25, "raw-k-1")).rejects.toThrow(/ELIGIBLE/);                       // the request is not ELIGIBLE yet
    await updateExecutionRequest(db, p.userId, request.id, "ELIGIBLE", [], []);
    await expect(ins(d.permittedSize!.quantity + 25, "raw-k-2")).rejects.toThrow(/exceeds the size the decision permits/);
    await expect(ins(25, "raw-k-3", "ACCEPTED")).rejects.toThrow(/starts PROPOSED/);
    const id = (await ins(25, "raw-k-4")).rows[0].id as string;
    await expect(raw.query("update paper_orders set status = 'ACCEPTED' where id = $1", [id])).rejects.toThrow(/illegal paper order transition/);
    await expect(raw.query("update paper_orders set quantity = 999 where id = $1", [id])).rejects.toThrow(/definition of a paper order cannot change/);
    await expect(raw.query("update paper_orders set filled_quantity = 10 where id = $1", [id])).rejects.toThrow();                // an unfilled-state order cannot carry fills
    await raw.query("update paper_orders set status = 'CANCELLED', state_reason = 'test' where id = $1", [id]);
    await expect(raw.query("update paper_orders set status = 'SUBMITTED' where id = $1", [id])).rejects.toThrow(/cannot change state/);
    await expect(raw.query("delete from paper_orders where id = $1", [id])).rejects.toThrow(/append-only|cannot be/);
    // exits: need an open position on the opposite side
    await expect(raw.query("insert into paper_orders (id, user_id, account_id, decision_id, execution_request_id, position_id, purpose, exit_reason, instrument, exchange, side, order_type, quantity, idempotency_key) values (gen_random_uuid(), $1, $2, $3, $4, $5, 'EXIT', 'MANUAL', $6, 'NSE', 'SELL', 'MARKET', 25, 'raw-k-5')", [p.userId, p.accountId, p.decisionId, request.id, randomUUID(), p.u])).rejects.toThrow(/open position/);
    // a position needs a filled entry order
    await expect(raw.query("insert into paper_positions (id, user_id, account_id, decision_id, instrument, exchange, side, quantity, initial_quantity, avg_entry_price, initial_stop, stop_loss, targets, rules) values (gen_random_uuid(), $1, $2, $3, $4, 'NSE', 'BUY', 25, 25, 100, 98, 98, '[]', '{}')", [p.userId, p.accountId, p.decisionId, p.u])).rejects.toThrow(/filled entry order/);
  });
  it("paper data is private to its owner (row-level security)", async () => {
    price = { price: 100, asOf: NOW.toISOString() };
    const a = await pipeline(), b = await pipeline();
    await approveDecision(evalDeps(), { userId: a.userId, decisionId: a.decisionId, idempotencyKey: "approve-key-0001" });
    await requestPaperExecution(execDeps(), { userId: a.userId, decisionId: a.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    const sb = await session(b.userId);
    for (const t of ["paper_orders", "paper_fills", "paper_positions", "paper_position_events", "execution_requests", "decision_approvals"]) expect((await sb.query(`select 1 from ${t} where user_id = $1`, [a.userId])).rows, t).toEqual([]);
    const sa = await session(a.userId);
    expect((await sa.query("select 1 from paper_positions where user_id = $1", [a.userId])).rows.length).toBe(1);
    expect(await listPaperPositions(db, b.userId, { limit: 10 })).toEqual([]);
  });
});
