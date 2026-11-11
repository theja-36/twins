/**
 * Fixtures for the execution crash/recovery test (G-47): the same synthetic setup the Stage 07 integration test uses (Monday 10:30 IST in 2031, a memory instrument-specification provider, memory regime / portfolio / quote
 * providers, a FIXTURE price provider), packaged so that the test process AND the child worker process build identical dependencies. Nothing here can reach a broker or a real market feed.
 */
import { randomUUID } from "node:crypto";
import { appendCapitalProfile, appendRiskPolicy, beginScan, createCandidateQueue, createPaperOrder, getCandidate, getDecision, getExecutionRequest, getPositionForDecision, insertPaperFill, insertScanCandidates, listDecisions, listPaperOrders, setOrderStatus, storeResearchPackage, type CandidateInsert, type Db } from "../../packages/database/src/index";
import { evaluateCandidateForAccount, memorySpecProvider, type InstrumentSpec, type PortfolioProvider } from "../../packages/planning/src/index";
import { approveDecision, runDecisionCycle, DEFAULT_DECISION_CONFIG } from "../../packages/decision/src/index";
import { DEFAULT_EXECUTION_CONFIG, requestPaperExecution, rulesFor, type ExecutionDeps, type PriceObservation, type PriceProvider } from "../../packages/execution/src/index";
import { FEES, SPEC } from "../unit/planning/fixtures";

export const NOW = new Date("2031-01-06T05:00:00Z");
const AGENTS = ["technical-structure-v1", "price-action-v1", "market-context-v1", "historical-pattern-v1", "news-sentiment-v1", "index-constituent-impact-v1", "market-calendar-v1", "macro-global-v1", "liquidity-v1", "options-risk-v1", "signal-integrity-v1", "instrument-verification-v1", "independent-challenger-v1"];
const research = (candidateId: string) => ({ packageVersion: "research-package-v1", candidateId, candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 1, assessment: "RESEARCH_SUPPORTIVE", halt: false, haltReason: null, score: 0.6, synthesisAlgorithmVersion: "s", reports: AGENTS.map((agentId) => ({ agentId, agentVersion: `${agentId}.1`, role: null, verdict: "SUPPORTIVE", executionStatus: "COMPLETED", confidence: null, evidenceRefs: [`ev:${agentId}`], riskFlags: [], reasoningSummary: "x", inputSnapshotRef: "s", errorCode: null })), contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: {}, evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b".repeat(64) });
const draft = (u: string): CandidateInsert => ({ dedupeKey: randomUUID(), underlying: u, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108, 112], invalidation: { price: 98, breachWhen: "BELOW", condition: "x" }, rankScore: 60, evidence: [], dataSource: "LIVE", correlationId: randomUUID(), createdAt: new Date("2031-01-06T04:50:00Z"), expiresAt: new Date("2031-01-06T08:00:00Z") });

/** A price provider that answers ONLY for `symbol` (so a recovery cycle can never touch another test's orders) and only while `available()`. */
export function pricesFor(symbol: string, available: () => boolean = () => true, onQuote?: () => void): PriceProvider {
  return { name: "memory-fixture", dataSource: "FIXTURE", price: async (q): Promise<PriceObservation | null> => { if (q.symbol !== symbol || !available()) return null; onQuote?.(); return { price: 100, asOf: NOW.toISOString() }; } };
}

export function makeFixtures(db: Db) {
  const instruments: InstrumentSpec[] = [];
  const specs = memorySpecProvider({ instruments, fees: [FEES] });
  const portfolio: PortfolioProvider = { name: "memory", portfolioFor: async () => ({ openPositions: [], realizedLossToday: "0", equityCurve: null, asOf: NOW.toISOString() }) };
  const regimeFor = async (u: string) => ({ underlying: u, version: "market-regime-v1", asOf: NOW.toISOString(), dataSource: "LIVE", timeframes: [], direction: "BULLISH", regime: "TRENDING_UP", volatilityRegime: "NORMAL", impliedVolatility: null, eventRisk: "NONE", correlatedIndexAgreement: "ALIGNED", riskOff: false, freshness: { stale: false, usableTimeframes: 3, oldestUsableBarAgeSeconds: 60 }, flags: [], grantsApproval: false }) as never;
  const quotes = { name: "memory", quoteFor: async () => ({ bid: 99.95, ask: 100.05, touchSize: 1_000_000, avgDailyVolume: 50_000_000 }) };
  const evalDeps = () => ({ db, specs, regime: { name: "memory", regimeFor }, portfolio, quotes, strategy: null, now: () => NOW });
  const execDeps = (prices: PriceProvider, o: Partial<ExecutionDeps["config"]> = {}): ExecutionDeps => ({ eval: evalDeps(), prices, config: { ...DEFAULT_EXECUTION_CONFIG, enabled: true, managementEnabled: true, ...o } });

  /** user + account + capital + risk policy + PAPER permission + a researched candidate, evaluated, with one decision cycle run. `ownerQuery` is a superuser query function (the CI connection). */
  async function pipeline(ownerQuery: (text: string, params?: unknown[]) => Promise<unknown>): Promise<{ u: string; userId: string; accountId: string; candId: string; decisionId: string; outcome: string | null }> {
    const userId = randomUUID(), accountId = randomUUID(), u = `K${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    await ownerQuery("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
    await ownerQuery("insert into accounts (id, user_id, name, trading_mode) values ($1, $2, 'paper account', 'paper')", [accountId, userId]);
    await ownerQuery("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, 'PAPER', true, 'test')", [userId, accountId]);
    await appendCapitalProfile(db, userId, { accountId, totalCapital: "1000000", availableCapital: "1000000", maxPositionNotionalPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
    await appendRiskPolicy(db, userId, { accountId, riskPercent: "1", maxRiskPerTrade: null, maxDailyLoss: "20000", maxConcurrentPositions: 3, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: null, maxPortfolioExposurePct: null, maxCorrelatedRiskPct: null, effectiveFrom: new Date("2030-01-01T00:00:00Z"), createdBy: "test" });
    instruments.push({ ...SPEC, underlying: u });
    const scan = (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "LIVE", now: NOW, leaseMs: 60_000 })).scanId;
    const candId = (await insertScanCandidates(db, scan, [draft(u)])).created[0] as string;
    const q = createCandidateQueue(db, { underlyings: [u] }); await q.claimNext(new Date(), []); await q.complete(candId);
    await storeResearchPackage(db, { candidateId: candId, agentResults: research(candId), assessment: "RESEARCH_SUPPORTIVE", haltReason: null });
    const cand = (await getCandidate(db, candId))!;
    const ev = await evaluateCandidateForAccount(evalDeps(), { userId, accountId, candidate: cand });
    if (ev.status !== "EVALUATED") throw new Error(`fixture candidate was not evaluated: ${ev.status}`);
    await runDecisionCycle({ ...evalDeps(), config: { ...DEFAULT_DECISION_CONFIG, enabled: true }, scope: { underlyings: [u] } });
    const d = (await listDecisions(db, userId, { candidateId: candId, limit: 5 }))[0];
    return { u, userId, accountId, candId, decisionId: d?.id ?? "", outcome: d?.outcome ?? null };
  }

  /** A fully filled, OPEN paper position for a fresh approved decision (entry at 100.05 after slippage). `deps` use a price provider that answers only for this instrument. */
  async function openPosition(ownerQuery: (text: string, params?: unknown[]) => Promise<unknown>) {
    const p = await pipeline(ownerQuery);
    if (p.outcome !== "QUALIFIED") throw new Error(`fixture decision is ${p.outcome}`);
    await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
    const deps = execDeps(pricesFor(p.u), { orderTtlMinutes: 1e9 });
    const first = await requestPaperExecution(deps, { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    if (first.status !== "FILLED") throw new Error(`entry did not fill: ${first.status}`);
    const dec0 = (await getDecision(db, p.userId, p.decisionId))!, cand = (await getCandidate(db, dec0.candidateId))!, pos = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    const entry = (await listPaperOrders(db, p.userId, { decisionId: p.decisionId, limit: 5 }))[0]!;
    return { ...p, deps, dec0, cand, pos, entry, qty: dec0.permittedSize!.quantity, rules: rulesFor(deps, SPEC.lotSize, cand, FEES, dec0, "equity") };
  }
  /** An EXIT order for part or all of the open quantity whose fill is COMMITTED but not yet applied to the position (the state a worker leaves when it dies after the fill). */
  async function commitExitFill(a: { userId: string; accountId: string; decisionId: string; pos: { id: string }; cand: { underlying: string; exchange: string } }, quantity: number, price: string, key: string) {
    const rq = (await getExecutionRequest(db, a.userId, a.decisionId, "PAPER"))!;
    const { order } = await createPaperOrder(db, a.userId, { accountId: a.accountId, decisionId: a.decisionId, executionRequestId: rq.id, positionId: a.pos.id, purpose: "EXIT", exitReason: "TARGET_HIT", instrument: a.cand.underlying, exchange: a.cand.exchange, side: "SELL", orderType: "MARKET", quantity: String(quantity), limitPrice: null, idempotencyKey: key });
    await setOrderStatus(db, a.userId, order.id, "SUBMITTED", "t"); await setOrderStatus(db, a.userId, order.id, "ACCEPTED", "t");
    const fillId = await insertPaperFill(db, a.userId, { orderId: order.id, quantity: String(quantity), price, costs: "9.00", priceSource: "FIXTURE", priceAsOf: NOW, expectedFilledQuantity: "0" });
    if (fillId === null) throw new Error("exit fill was not applied");
    return order;
  }
  return { instruments, evalDeps, execDeps, pipeline, openPosition, commitExitFill, spec: SPEC };
}
