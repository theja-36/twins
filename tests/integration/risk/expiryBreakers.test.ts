/**
 * Risk-decision expiry and the daily / weekly loss circuit breakers against REAL PostgreSQL (Stage 3 / Task 4). Committed rows are append-only, so breaker
 * tests run in a random FAR-PAST week per test (the breaker logic takes `asOf`; the database clock never sees an open breach) and the database-level gate is
 * proven inside transactions that are rolled back.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChains, verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { createAlerter, type AlertPayload } from "../../../packages/alerting/src/index";
import {
  breakerAlert, breakerGate, createRiskDecision, evaluateCircuitBreakers, evaluatePortfolioRisk, expireRiskDecision, expireStaleRiskDecisions, getCircuitBreakerStatus, getRiskDecision, ingestLossEvents, listRiskDecisions,
  listStaleRiskDecisions, loadPortfolioConfig, recordLossEvent, RiskDecisionError, sizeRiskDecision, syntheticLossSource, weeklyPeriod, type BreakerEventRecord, type PortfolioOptions, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { runCli } from "../../../scripts/ops/risk-control";
import { approveThroughGates } from "./gates";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const DAY = 86_400_000;
const MIN = 60_000;
const CAPITAL = 1_000_000; // daily limit 20,000 (warning 15,000) · weekly limit 50,000 (warning 37,500)
const sym = () => `EX${sfx()}`.toUpperCase();

beforeAll(async () => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
  const r = await pool.query("select greatest(coalesce(max(occurred_at), '0200-01-01'::timestamptz), coalesce((select max(period_end) from circuit_breaker_events where period_end < '1000-01-01'::timestamptz), '0200-01-01'::timestamptz)) as m from loss_events where occurred_at < '1000-01-01'::timestamptz");
  weekCursor = new Date((r.rows[0] as { m: Date }).m);
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false, TRADING_ENABLED: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

// ── fixtures (decisions) ──
async function makeSized(symbol = sym(), confidence01 = 0.9) {
  const [existing] = await db().select().from(schema.instruments).where(and(eq(schema.instruments.symbol, symbol), eq(schema.instruments.exchange, "NSE")));
  const [instrument] = existing ? [existing] : await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "ex-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ex-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol, side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: confidence01 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false }, evidenceReferences: { fixture: true },
  };
  const v1 = await createRiskDecision(db(), input);
  const sized = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
  expect(sized.sizingStatus).toBe("SIZED");
  return { signalId: must(signal).id, v1: v1.id, decisionId: sized.id, symbol };
}
/** Wide-open portfolio limits (the scenario under test is expiry / breakers, not the portfolio limits). */
const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const pf = (extra: Partial<PortfolioOptions> = {}): PortfolioOptions => ({ config: openLimits(), capital: CAPITAL * 1000, ...extra });
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);
const raw = async (id: string) => must((await pool.query("select * from risk_decisions where id = $1", [id])).rows[0]);
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("set local lock_timeout = '5s'"); return await fn(c); } finally { await c.query("rollback").catch(() => undefined); c.release(); }
}

// ── fixtures (breakers) ──
/** A private week per call: the next unused week in the year 200-999 range (an ordered cursor read from the database, so repeated runs never share a week). */
let weekCursor = new Date(0);
function privateWeek(): Date {
  weekCursor = new Date(weekCursor.getTime() + 14 * DAY);
  return weeklyPeriod(weekCursor, 330).start;
}
const at = (monday: Date, dayOffset: number, minutes = 270) => new Date(monday.getTime() + dayOffset * DAY + minutes * MIN); // default 04:30 IST
const loss = (amount: number, when: Date) => recordLossEvent(db(), { amount, occurredAt: when, source: "synthetic", sourceRef: `ex-${sfx()}-${sfx()}`, createdBy: "service:itest" });
const cb = (asOf: Date, extra: { onBreakerEvent?: (e: BreakerEventRecord) => void } = {}) => evaluateCircuitBreakers(db(), { capital: CAPITAL, asOf, ...extra });
const types = (r: { events: BreakerEventRecord[] }) => r.events.filter((e) => e.created).map((e) => `${e.scope}:${e.eventType}`);

describe("risk decision expiry", () => {
  it("a stale PENDING decision becomes a NEW EXPIRED version; the original row is untouched and nothing before the window is touched", async () => {
    const m = await makeSized();
    const before = await raw(m.decisionId);
    const now = Date.now();
    expect(await expireRiskDecision(db(), m.decisionId, { asOf: new Date(now + 29 * MIN) })).toMatchObject({ result: "not_yet_stale" });
    const out = await expireRiskDecision(db(), m.decisionId, { asOf: new Date(now + 31 * MIN) });
    expect(out).toMatchObject({ result: "expired" });
    const v3 = must(await getRiskDecision(db(), must(out.expiredId)));
    expect(v3).toMatchObject({ status: "EXPIRED", supersedesId: m.decisionId, createdBy: "service:risk-expiry", decisionReasonCode: "expired_pending", decisionVersion: 3, effectiveStatus: "EXPIRED" });
    expect(Number(v3.plannedMaxLossAmount)).toBe(10000); // the plan is kept for the record
    expect(v3.outputSnapshot).toMatchObject({ stage: "expired", expiry: { previousStatus: "PENDING", validityMinutes: 30 } });
    expect(await raw(m.decisionId)).toEqual(before);
    expect(must(await getRiskDecision(db(), m.decisionId)).effectiveStatus).toBe("SUPERSEDED");
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
  it("a stale APPROVED_FOR_REVIEW decision expires after 15 minutes, with its own reason", async () => {
    const m = await makeSized();
    const approved = must((await approveThroughGates(db(), m.decisionId, pf())).market);
    expect(approved).toMatchObject({ status: "APPROVED_FOR_REVIEW" });
    const now = Date.now();
    expect(await expireRiskDecision(db(), approved.id, { asOf: new Date(now + 14 * MIN) })).toMatchObject({ result: "not_yet_stale" });
    const out = await expireRiskDecision(db(), approved.id, { asOf: new Date(now + 16 * MIN) });
    expect(out.result).toBe("expired");
    expect(must(await getRiskDecision(db(), must(out.expiredId)))).toMatchObject({ status: "EXPIRED", decisionReasonCode: "expired_approved_for_review", decisionVersion: 5 });
  });
  it("other statuses and superseded versions are not expirable; unknown ids are reported", async () => {
    const m = await makeSized();
    const evaluated = await evaluatePortfolioRisk(db(), m.decisionId, pf({ config: loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "1", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" }) }));
    expect(evaluated.status).toBe("REJECTED");
    const far = new Date(Date.now() + 100 * DAY);
    expect(await expireRiskDecision(db(), evaluated.id, { asOf: far })).toMatchObject({ result: "not_expirable" });
    expect(await expireRiskDecision(db(), m.decisionId, { asOf: far })).toMatchObject({ result: "not_latest" });
    expect(await expireRiskDecision(db(), randomUUID(), { asOf: far })).toMatchObject({ result: "not_found" });
  });
  it("expired decisions stop counting toward portfolio exposure - even before the expiry job has recorded them", async () => {
    const s = sym();
    const cfg = loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
    const first = await makeSized(s);
    expect(must((await approveThroughGates(db(), first.decisionId, pf({ config: cfg }))).market)).toMatchObject({ status: "APPROVED_FOR_REVIEW" }); // 10,000 active on s (approval window 15 minutes)
    const second = await makeSized(s);
    // at the real clock the first decision (10,000) still counts: 10,000 + 10,000 > 15,000
    expect(await evaluatePortfolioRisk(db(), second.decisionId, pf({ config: cfg }))).toMatchObject({ status: "REJECTED", reasonCode: "UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED" });
    const third = await makeSized(s);
    // 20 minutes later the first decision's 15-minute approval has lapsed: it is excluded although nothing has recorded the expiry yet; the new candidate (30-minute window) is still valid
    const later = new Date(Date.now() + 20 * MIN);
    const stale = await listStaleRiskDecisions(db(), { asOf: later });
    expect(stale.map((d) => d.signalId)).toContain(first.signalId);
    expect(await evaluatePortfolioRisk(db(), third.decisionId, pf({ config: cfg, asOf: later }))).toMatchObject({ status: "PENDING", portfolioOutcome: "APPROVED_FOR_REVIEW" }); // admitted: the lapsed approval no longer counts
  });
  it("a candidate past its own window is expired, not sized or evaluated", async () => {
    const m = await makeSized();
    const late = new Date(Date.now() + 31 * MIN);
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, pf({ asOf: late })))).code).toBe("decision_expired");
    expect(await sizeRiskDecision(db(), m.v1, { capital: CAPITAL, asOf: late })).toMatchObject({ id: m.decisionId, created: false }); // v1 was already sized: the retry returns that sizing
    const fresh = await makeSized();
    await db().execute(await import("drizzle-orm").then(({ sql }) => sql`select 1`)); // keep the connection warm
    const pendingOnly = await (async () => {
      const [instrument] = await db().insert(schema.instruments).values({ symbol: sym(), exchange: "NSE", instrumentType: "equity" }).returning();
      const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "ex-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
      const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
      return createRiskDecision(db(), { subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ex-p:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", symbol: "X", side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { a: 1 } });
    })();
    expect((await err(sizeRiskDecision(db(), pendingOnly.id, { capital: CAPITAL, asOf: late }))).code).toBe("decision_expired");
    expect(fresh.decisionId).toBeTruthy();
  });
  it("concurrent expiry is safe: exactly one EXPIRED version is appended, everyone else sees it as already expired", async () => {
    const m = await makeSized();
    const asOf = new Date(Date.now() + 31 * MIN);
    const results = await Promise.all(Array.from({ length: 6 }, () => expireRiskDecision(db(), m.decisionId, { asOf })));
    expect(results.filter((r) => r.result === "expired")).toHaveLength(1);
    expect(results.filter((r) => r.result === "already_expired")).toHaveLength(5);
    expect(new Set(results.map((r) => r.expiredId)).size).toBe(1);
    const rows = await listRiskDecisions(db(), { signalId: m.signalId });
    expect(rows.filter((r) => r.status === "EXPIRED")).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });
  it("the batch job is idempotent, honours dry-run, and two jobs running at once expire each decision once", async () => {
    // The job is bounded (200 per run, oldest first) by design. In the full integration suite earlier files leave hundreds of unexpired decisions in the shared database, so on a run that starts with a backlog the two concurrent
    // runs below would spend their whole batch on OLD rows and never reach this test's two decisions (observed: zero EXPIRED rows, no duplicates). Drain the backlog first so the concurrency assertions are about concurrency only.
    for (let i = 0; i < 50; i += 1) if ((await expireStaleRiskDecisions(db(), { asOf: new Date(Date.now() + 31 * MIN), limit: 1000 })).expired.length === 0) break;
    const a = await makeSized(), b = await makeSized();
    const asOf = new Date(Date.now() + 31 * MIN);
    const dry = await expireStaleRiskDecisions(db(), { asOf, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, expired: [] });
    expect(dry.examined).toBeGreaterThanOrEqual(2);
    expect(await rowCount("risk_decisions")).toBe(await rowCount("risk_decisions")); // a dry run writes nothing
    const [r1, r2] = await Promise.all([expireStaleRiskDecisions(db(), { asOf }), expireStaleRiskDecisions(db(), { asOf })]);
    const created = [...r1.expired, ...r2.expired];
    expect(new Set(created).size).toBe(created.length); // no decision was expired twice
    for (const m of [a, b]) expect((await listRiskDecisions(db(), { signalId: m.signalId })).filter((r) => r.status === "EXPIRED")).toHaveLength(1);
    const again = await expireStaleRiskDecisions(db(), { asOf });
    expect(again.expired).toEqual([]);
    expect((await listStaleRiskDecisions(db(), { asOf })).map((d) => d.signalId)).not.toContain(a.signalId);
  });
  it("expiry works under the kill switch (it removes exposure) and writes nothing downstream", async () => {
    const counts = async () => Promise.all(["orders", "fills", "positions", "decisions", "claim_review_cards"].map(rowCount));
    const before = await counts();
    const m = await makeSized();
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(sizeRiskDecision(db(), m.decisionId, { capital: CAPITAL }))).code).toBe("safety_refused"); // new work is refused...
    const out = await expireRiskDecision(db(), m.decisionId, { asOf: new Date(Date.now() + 31 * MIN) });
    expect(out.result).toBe("expired"); // ...but cleaning up is not
    source.failWith(new Error("state unreadable"));
    const m2 = await makeSized().catch(() => null); // creation itself is refused while the state is unreadable
    expect(m2).toBeNull();
    expect(await counts()).toEqual(before);
  });
});

describe("loss events (the accounting interface)", () => {
  it("records an immutable loss event idempotently; a conflicting reuse is refused; synthetic is refused in production", async () => {
    const when = at(privateWeek(), 1);
    const ref = `ex-${sfx()}`;
    const a = await recordLossEvent(db(), { amount: 1234.5, occurredAt: when, source: "synthetic", sourceRef: ref, createdBy: "service:itest", details: { drill: true } });
    expect(a.created).toBe(true);
    expect(await recordLossEvent(db(), { amount: 1234.5, occurredAt: when, source: "synthetic", sourceRef: ref, createdBy: "service:itest" })).toEqual({ id: a.id, created: false });
    expect((await err(recordLossEvent(db(), { amount: 999, occurredAt: when, source: "synthetic", sourceRef: ref, createdBy: "service:itest" }))).code).toBe("idempotency_conflict");
    expect((await err(recordLossEvent(db(), { amount: 5, occurredAt: when, source: "synthetic", sourceRef: `ex-${sfx()}`, createdBy: "service:itest" }, { APP_ENV: "production" }))).code).toBe("invalid_input");
    expect((await err(recordLossEvent(db(), { amount: 5, occurredAt: when, source: "synthetic", sourceRef: `ex-${sfx()}`, createdBy: "service:itest", riskDecisionId: randomUUID() }))).code).toBe("not_found");
    const [row] = await db().select().from(schema.lossEvents).where(eq(schema.lossEvents.id, a.id));
    expect(row).toMatchObject({ source: "synthetic", createdBy: "service:itest", currency: "INR" });
    expect(Number(row?.amount)).toBe(1234.5);
  });
  it("a future broker reconciliation plugs in through LossEventSource / ingestLossEvents (here a synthetic source)", async () => {
    const monday = privateWeek();
    const events = [1, 2, 3].map((i) => ({ amount: 100 * i, occurredAt: at(monday, i), source: "synthetic" as const, sourceRef: `ing-${sfx()}-${i}`, createdBy: "service:itest" }));
    const range = { from: monday, to: new Date(monday.getTime() + 7 * DAY) };
    expect(await ingestLossEvents(db(), syntheticLossSource(events), range)).toEqual({ source: "synthetic", fetched: 3, created: 3 });
    expect(await ingestLossEvents(db(), syntheticLossSource(events), range)).toEqual({ source: "synthetic", fetched: 3, created: 0 });
    expect((await getCircuitBreakerStatus(db(), { capital: CAPITAL, asOf: at(monday, 4) })).scopes.WEEKLY.realizedLoss).toBe(600);
  });
  it("loss events and breaker events are append-only (UPDATE / DELETE / TRUNCATE rejected, also under replica role) and tamper-evident", async () => {
    const when = at(privateWeek(), 2);
    await loss(25_000, when); // a breach, so both tables have a row to attack
    await cb(when);
    for (const table of ["loss_events", "circuit_breaker_events"]) {
      await inTx(async (c) => {
        for (const sql of [`update ${table} set ${table === "loss_events" ? "source_ref" : "reason_code"} = 'x'`, `delete from ${table}`, `truncate ${table}`, `truncate ${table} cascade`]) {
          await c.query("savepoint s");
          const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
          await c.query("rollback to savepoint s");
          expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code); // a plain TRUNCATE of a referenced table is refused by PostgreSQL itself (0A000), every other form by the guard (23001)
        }
        await c.query("set local session_replication_role = replica");
        const e = await c.query(`update ${table} set event_hash = event_hash`).then(() => null, (x: { code?: string }) => x);
        expect(e?.code).toBe("23001");
      });
    }
    expect((await verifyAuditChainsWithPool(pool, { chains: ["loss_events", "circuit_breaker_events"] })).ok).toBe(true);
    const tampered = await inTx(async (c) => {
      await c.query("alter table loss_events disable trigger loss_events_no_update_delete");
      await c.query("update loss_events set amount = amount + 1 where chain_index = (select max(chain_index) from loss_events)");
      await c.query("alter table loss_events enable always trigger loss_events_no_update_delete");
      return verifyAuditChains(c, { chains: ["loss_events"] });
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.firstFailure?.code).toBe("payload_modified");
  });
});

describe("daily circuit breaker", () => {
  it("below the limit: CLEAR, no event; at 75% of the limit: WARNING with exactly one WARNED event (and one alert hook call)", async () => {
    const monday = privateWeek(), now = at(monday, 1);
    await loss(10_000, at(monday, 1, 60));
    const clear = await cb(now);
    expect(clear.status.scopes.DAILY).toMatchObject({ status: "CLEAR", realizedLoss: 10_000, limitAmount: 20_000, lossPct: 1 });
    expect(types(clear).filter((t) => !t.endsWith(":RESET"))).toEqual([]); // (an earlier test's lapsed breach may be reset by this later evaluation: that is correct and unrelated)
    expect(clear.status.blocked).toBe(false);
    await loss(5_000, at(monday, 1, 90)); // 15,000 = 75% of 20,000
    const seen: BreakerEventRecord[] = [];
    const warn = await cb(now, { onBreakerEvent: (e) => { if (e.eventType === "WARNED") seen.push(e); } });
    expect(warn.status.scopes.DAILY.status).toBe("WARNING");
    expect(warn.status.blocked).toBe(false);
    expect(types(warn).filter((t) => !t.endsWith(":RESET"))).toEqual(["DAILY:WARNED"]);
    expect(seen).toHaveLength(1);
    const again = await cb(now, { onBreakerEvent: (e) => seen.push(e) });
    expect(types(again)).toEqual([]);
    expect(seen).toHaveLength(1); // the hook (the alert) fires for the event this call created, once
  });
  it("breach: BREACHED recorded once with the reason, the reset time (next trading day) and the exposure; the breaker is open", async () => {
    const monday = privateWeek(), tue = at(monday, 1);
    await loss(12_000, at(monday, 1, 60));
    await loss(8_000, at(monday, 1, 120));
    const r = await cb(tue);
    expect(types(r)).toContain("DAILY:BREACHED");
    expect(r.status).toMatchObject({ blocked: true, blockedBy: ["DAILY"] });
    const d = r.status.scopes.DAILY;
    expect(d).toMatchObject({ status: "BREACHED", realizedLoss: 20_000, lossPct: 2, limitPct: 2, breachReason: "daily_loss_limit_breached" });
    expect(d.resetsAt.getTime()).toBe(at(monday, 2, 0).getTime()); // Wednesday 00:00 IST
    expect(d.breachedAt).toBeInstanceOf(Date);
    expect(d.plannedExposure).toBeGreaterThanOrEqual(0);
    expect(types(await cb(tue))).toEqual([]); // idempotent
    const [row] = await db().select().from(schema.circuitBreakerEvents).where(eq(schema.circuitBreakerEvents.id, must(d.breachEventId)));
    expect(row).toMatchObject({ scope: "DAILY", eventType: "BREACHED", createdBy: "service:circuit-breaker" });
    expect(Number(row?.limitAmount)).toBe(20_000);
  });
  it("blocks new sized decisions (the rejection is recorded) and approval-eligible transitions; resets at the next trading day and work resumes", async () => {
    const monday = privateWeek(), tue = at(monday, 1), wed = at(monday, 2);
    const sized = await makeSized(); // sized before the breach
    const unsized = await (async () => { const m = await makeSized(); return m; })();
    await loss(25_000, at(monday, 1, 60));
    expect(types(await cb(tue))).toContain("DAILY:BREACHED"); // stored once; every gate below sees the open breach whatever capital it is called with
    // approval-eligible transition: blocked, recorded as a REJECTED version with the reason
    const blockedEval = await evaluatePortfolioRisk(db(), sized.decisionId, pf({ asOf: tue }));
    expect(blockedEval).toMatchObject({ status: "REJECTED", portfolioOutcome: "REJECTED", reasonCode: "CIRCUIT_BREAKER_OPEN" });
    const v3 = must(await getRiskDecision(db(), blockedEval.id));
    expect(v3).toMatchObject({ decisionReasonCode: "portfolio_circuit_breaker_open", createdBy: "service:portfolio-risk" });
    expect(v3.inputSnapshot).toMatchObject({ portfolio: { circuitBreaker: { blockedBy: ["DAILY"] } } });
    expect(await evaluatePortfolioRisk(db(), sized.decisionId, pf({ asOf: tue }))).toMatchObject({ id: blockedEval.id, created: false }); // idempotent while blocked
    // creation of a NEW sized decision: blocked, recorded as a REJECTED sizing version
    const [instrument] = await db().insert(schema.instruments).values({ symbol: sym(), exchange: "NSE", instrumentType: "equity" }).returning();
    const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "ex-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
    const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
    const fresh = await createRiskDecision(db(), { subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ex-f:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol: must(instrument).symbol, side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { signalValidation: { decisionConfidence: 0.9 } } });
    const blockedSize = await sizeRiskDecision(db(), fresh.id, { capital: CAPITAL, asOf: tue });
    expect(blockedSize).toMatchObject({ sizingStatus: "CIRCUIT_BREAKER_OPEN", status: "REJECTED", quantity: 0, reasonCode: "circuit_breaker_open" });
    const bs = must(await getRiskDecision(db(), blockedSize.id));
    expect(bs).toMatchObject({ decisionReasonCode: "sizing_circuit_breaker_open", plannedQuantity: null });
    expect(await sizeRiskDecision(db(), blockedSize.id, { capital: CAPITAL, asOf: tue })).toMatchObject({ id: blockedSize.id, created: false });
    // reads, rejections and inspection are never blocked
    expect(must(await getRiskDecision(db(), blockedSize.id)).id).toBe(blockedSize.id);
    expect(await createRiskDecision(db(), { subject: { kind: "signal", signalId: unsized.signalId }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ex-x:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", symbol: "X", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { a: 1 } }).then(() => "ok", (e: RiskDecisionError) => e.code)).toBe("stop_loss_subject_mismatch"); // (rejected for its own, unrelated reason: the point is that the breaker is not what stops it)
    expect((await getCircuitBreakerStatus(db(), { capital: CAPITAL, asOf: tue })).blocked).toBe(true);
    // the next trading day: automatic RESET (authorization recorded), and the blocked work can be redone
    const reset = await cb(wed);
    expect(types(reset)).toContain("DAILY:RESET");
    expect(reset.status).toMatchObject({ blocked: false });
    expect(reset.status.scopes.DAILY).toMatchObject({ status: "CLEAR", lastResetAuthorization: "automatic:period_rollover" });
    const resized = await sizeRiskDecision(db(), blockedSize.id, { capital: CAPITAL, asOf: wed });
    expect(resized).toMatchObject({ sizingStatus: "SIZED", status: "PENDING", decisionVersion: 3 });
    const reevaluated = await evaluatePortfolioRisk(db(), blockedEval.id, pf({ asOf: wed }));
    expect(reevaluated).toMatchObject({ status: "PENDING", portfolioOutcome: "APPROVED_FOR_REVIEW", decisionVersion: 4 });
  });
  it("a Friday breach lasts through the weekend and resets on Monday (the next trading day)", async () => {
    const monday = privateWeek(), fri = at(monday, 4), sat = at(monday, 5), sun = at(monday, 6), nextMon = at(monday, 7, 5);
    await loss(21_000, at(monday, 4, 60));
    expect(types(await cb(fri))).toContain("DAILY:BREACHED");
    for (const t of [sat, sun]) expect((await getCircuitBreakerStatus(db(), { capital: CAPITAL, asOf: t })).scopes.DAILY.status).toBe("BREACHED");
    expect(types(await cb(sat))).toEqual([]); // still the same open breach: no duplicate
    const reset = await cb(nextMon);
    expect(types(reset)).toContain("DAILY:RESET");
    expect(reset.status.blocked).toBe(false);
  });
});

describe("weekly circuit breaker", () => {
  it("losses spread over the week breach the weekly limit even when no day breaches; it blocks until next Monday and then resets", async () => {
    const monday = privateWeek();
    const m = await makeSized(); // (a real-time evaluation resets every stale far-past breach, so decisions are prepared BEFORE the breach is recorded)
    await loss(17_000, at(monday, 0, 60)); await loss(17_000, at(monday, 1, 60)); await loss(17_000, at(monday, 2, 60)); // 51,000 > 50,000; each day 17,000 < 20,000
    const wed = at(monday, 2, 120);
    const r = await cb(wed);
    expect(types(r)).toContain("WEEKLY:BREACHED");
    expect(types(r)).not.toContain("DAILY:BREACHED");
    expect(r.status).toMatchObject({ blocked: true, blockedBy: ["WEEKLY"] });
    expect(r.status.scopes.WEEKLY).toMatchObject({ status: "BREACHED", limitAmount: 50_000, realizedLoss: 51_000, breachReason: "weekly_loss_limit_breached" });
    expect(r.status.scopes.WEEKLY.resetsAt.getTime()).toBe(at(monday, 7, 0).getTime()); // next Monday 00:00 IST
    // blocks new decisions
    expect(await evaluatePortfolioRisk(db(), m.decisionId, pf({ asOf: wed }))).toMatchObject({ status: "REJECTED", reasonCode: "CIRCUIT_BREAKER_OPEN" });
    // still blocked on Friday and on the weekend; the DAILY breaker may be clear again on Thursday
    expect((await cb(at(monday, 3))).status.scopes.DAILY.status).toBe("CLEAR");
    expect((await cb(at(monday, 3))).status.blocked).toBe(true);
    expect((await cb(at(monday, 6))).status.blocked).toBe(true);
    const reset = await cb(at(monday, 7, 5));
    expect(types(reset)).toContain("WEEKLY:RESET");
    expect(reset.status).toMatchObject({ blocked: false });
  });
  it("a weekly warning (75%) is recorded once without blocking", async () => {
    const monday = privateWeek();
    for (let d = 0; d < 3; d++) await loss(12_600, at(monday, d, 60)); // 37,800 >= 37,500; each day 12,600 < the daily warning
    const r = await cb(at(monday, 2, 120));
    expect(types(r)).toEqual(["WEEKLY:WARNED"]);
    expect(r.status).toMatchObject({ blocked: false });
  });
});

describe("alert emission and redaction", () => {
  it("WARNING, CRITICAL and INFO are emitted once each through the alerter, with only scope and percentages", async () => {
    const monday = privateWeek();
    const sent: AlertPayload[] = [];
    const alerter = createAlerter({ context: { environment: "test", service: "scheduler" }, minSeverity: "INFO", sender: { label: "capture", send: async (p) => { sent.push(p); return true; } } });
    const hook = (e: BreakerEventRecord) => alerter.alert({ ...breakerAlert(e), dedupeKey: e.id });
    await loss(15_000, at(monday, 1, 60));
    await cb(at(monday, 1), { onBreakerEvent: hook }); // warning
    await loss(6_000, at(monday, 1, 90));
    await cb(at(monday, 1), { onBreakerEvent: hook }); // breach
    await cb(at(monday, 1), { onBreakerEvent: hook }); // nothing new
    await cb(at(monday, 2), { onBreakerEvent: hook }); // reset
    await alerter.flush();
    expect(sent.map((p) => `${p.severity}:${p.event}`)).toEqual(["WARNING:risk.circuit_breaker.warning", "CRITICAL:risk.circuit_breaker.breached", "INFO:risk.circuit_breaker.reset"]);
    for (const p of sent) {
      expect(Object.keys(p.details).sort()).toEqual(["limitPct", "lossPct", "scope"]);
      expect(JSON.stringify(p)).not.toMatch(/operator:|service:itest|ex-|synthetic|postgres|password|token/i);
    }
  });
});

describe("runtime state: breakers and the kill switch are separate; the kill switch always wins; unreadable state fails closed", () => {
  it("a manual kill switch overrides a breaker reset: the breaker clears by itself, the switch stays on and sizing stays refused", async () => {
    const monday = privateWeek(), tue = at(monday, 1), wed = at(monday, 2);
    const m = await makeSized();
    await loss(30_000, at(monday, 1, 60));
    expect(types(await cb(tue))).toContain("DAILY:BREACHED");
    source.set({ KILL_SWITCH_ACTIVE: true });
    const reset = await cb(wed); // recording the reset does not consult or change the kill switch
    expect(types(reset)).toContain("DAILY:RESET");
    expect(reset.status.blocked).toBe(false);
    expect(await source.read().then((rows) => rows.find((r) => r.control_name === "KILL_SWITCH_ACTIVE")?.value)).toBe(true);
    expect((await err(sizeRiskDecision(db(), m.decisionId, { capital: CAPITAL, asOf: wed }))).code).toBe("safety_refused");
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, pf({ asOf: wed })))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false });
    expect(await sizeRiskDecision(db(), m.decisionId, { capital: CAPITAL, asOf: wed })).toMatchObject({ sizingStatus: "SIZED" });
  });
  it("administrative inspection and the CLI status work under the kill switch", async () => {
    source.set({ KILL_SWITCH_ACTIVE: true });
    const s = await getCircuitBreakerStatus(db(), { capital: CAPITAL, asOf: at(privateWeek(), 1) });
    expect(s.blocked).toBe(false);
  });
  it("trading disabled does not matter to the breakers; a database that cannot be read fails closed", async () => {
    source.set({ TRADING_ENABLED: false, INTAKE_ENABLED: true });
    expect((await cb(at(privateWeek(), 1))).status.blocked).toBe(false);
    const dead = createBoundedDb(DATABASE_URL, { max: 1, idleTimeoutMillis: 1000 });
    await dead.close();
    const e = await err(breakerGate(dead.db, CAPITAL, { asOf: new Date() }));
    expect(e.code).toBe("circuit_breaker_unavailable");
    expect(e.message).not.toMatch(/postgres|password|@/i);
  });
});

describe("the database itself refuses approvals and orders while a breaker is open", () => {
  const insertBreach = (c: pg.PoolClient, periodEndSql: string) => c.query(
    `insert into circuit_breaker_events (id, scope, event_type, period_start, period_end, loss_amount, limit_amount, capital, loss_pct, planned_exposure_amount, reason_code, idempotency_key, snapshot, created_by)
     values (gen_random_uuid(), 'DAILY', 'BREACHED', now() - interval '1 hour', ${periodEndSql}, 20000, 20000, 1000000, 2, 0, 'daily_loss_limit_breached', $1, '{}', 'service:itest') returning id`, [`gate-${randomUUID()}`]);
  it("APPROVED_FOR_REVIEW is refused while an unreset BREACHED event's reset time is in the future; a RESET (or a past reset time) releases it", async () => {
    const m = await makeSized();
    const approve = (c: pg.PoolClient) => c.query(
      `insert into risk_decisions (id, signal_id, stop_loss_validation_id, supersedes_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, output_snapshot, evidence_references, created_by, entry_price, stop_loss, stop_loss_basis, planned_quantity, planned_notional, planned_max_loss_amount, planned_max_loss_percent)
       select gen_random_uuid(), signal_id, stop_loss_validation_id, id, decision_version + 1, 'APPROVED_FOR_REVIEW', $2, instrument_type, symbol, 'raw_sql', '{"a":1}', '{"sizing":{"status":"SIZED"},"portfolio":{"outcome":"APPROVED_FOR_REVIEW"},"market":{"outcome":"PASSED"}}', '{}', 'service:itest', entry_price, stop_loss, stop_loss_basis, planned_quantity, planned_notional, planned_max_loss_amount, planned_max_loss_percent from risk_decisions where id = $1`,
      [m.decisionId, `gate-ap-${randomUUID()}`]).then(() => "inserted", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
    expect(await inTx(async (c) => { await insertBreach(c, "now() + interval '6 hours'"); return approve(c); })).toMatch(/23514:risk_decisions: a loss circuit breaker is open/);
    expect(await inTx(async (c) => { await insertBreach(c, "now() - interval '1 minute'"); return approve(c); })).toBe("inserted"); // its reset time has passed
    expect(await inTx(async (c) => {
      const b = must((await insertBreach(c, "now() + interval '6 hours'")).rows[0]);
      await c.query(`insert into circuit_breaker_events (id, scope, event_type, period_start, period_end, loss_amount, limit_amount, capital, loss_pct, planned_exposure_amount, reason_code, breach_event_id, reset_authorization, idempotency_key, snapshot, created_by)
        values (gen_random_uuid(), 'DAILY', 'RESET', now() - interval '1 hour', now() + interval '6 hours', 20000, 20000, 1000000, 2, 0, 'breaker_reset', $1, 'automatic:period_rollover', $2, '{}', 'service:itest')`, [b["id"], `gate-rs-${randomUUID()}`]);
      return approve(c);
    })).toBe("inserted");
  });
  it("orders are refused while a breaker is open (even for an approved decision), and a RESET must reference a BREACHED event of its own scope", async () => {
    const m = await makeSized();
    const approved = must((await approveThroughGates(db(), m.decisionId, pf())).market);
    expect(approved.status).toBe("APPROVED_FOR_REVIEW");
    const order = (c: pg.PoolClient) => c.query(`insert into orders (id, account_id, instrument_id, risk_decision_id, trading_mode, side, order_type, quantity, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, 'paper', 'buy', 'limit', 1, $2)`, [approved.id, `ord-${randomUUID()}`]).then(() => "inserted", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
    expect(await inTx(async (c) => { await insertBreach(c, "now() + interval '6 hours'"); return order(c); })).toMatch(/orders: a loss circuit breaker is open/);
    expect(await inTx(order)).not.toMatch(/circuit breaker/); // no open breaker: the order guard passes this rule (the insert then fails on the next, unrelated rule)
    const wrong = await inTx(async (c) => {
      const b = must((await insertBreach(c, "now() + interval '6 hours'")).rows[0]);
      return c.query(`insert into circuit_breaker_events (id, scope, event_type, period_start, period_end, loss_amount, limit_amount, capital, loss_pct, planned_exposure_amount, reason_code, breach_event_id, reset_authorization, idempotency_key, snapshot, created_by)
        values (gen_random_uuid(), 'WEEKLY', 'RESET', now() - interval '1 hour', now() + interval '6 hours', 1, 1, 1, 1, 0, 'breaker_reset', $1, 'automatic:period_rollover', $2, '{}', 'service:itest')`, [b["id"], `gate-wr-${randomUUID()}`]).then(() => "inserted", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
    });
    expect(wrong).toMatch(/23514:circuit_breaker_events: a RESET must reference a BREACHED event of the same scope/);
  });
});

describe("operations CLI", () => {
  const run = async (args: string[], env: Record<string, string | undefined> = {}) => {
    const out: string[] = [], errs: string[] = [];
    const code = await runCli(args, { env: { DATABASE_URL, ...env }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }) });
    return { code, out: out.join("\n"), err: errs.join("\n") };
  };
  it("lists and expires stale decisions (dry run first), reports the breaker status and records a loss; usage errors exit 2; refusals exit 3", async () => {
    const m = await makeSized();
    const asOf = new Date(Date.now() + 31 * MIN).toISOString();
    const list = await run(["expiry", "list", "--as-of", asOf, "--limit", "1000"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toMatchObject({ validityMinutes: { PENDING: 30, APPROVED_FOR_REVIEW: 15 } });
    expect(list.out).toContain(m.decisionId);
    const dry = await run(["expiry", "run", "--dry-run", "--as-of", asOf]);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, expired: [] });
    expect((await listRiskDecisions(db(), { signalId: m.signalId })).some((r) => r.status === "EXPIRED")).toBe(false);
    const real = await run(["expiry", "run", "--as-of", asOf]);
    expect(real.code).toBe(0);
    expect((await listRiskDecisions(db(), { signalId: m.signalId })).some((r) => r.status === "EXPIRED")).toBe(true);
    const monday = privateWeek();
    const rec = await run(["breakers", "record-loss", "--amount", "21000", "--source-ref", `cli-${sfx()}`, "--created-by", "operator:itest", "--occurred-at", at(monday, 1).toISOString()]);
    expect(rec.code).toBe(0);
    const status = await run(["breakers", "evaluate", "--capital", String(CAPITAL), "--as-of", at(monday, 1, 300).toISOString()]);
    expect(JSON.parse(status.out)).toMatchObject({ blocked: true, blockedBy: ["DAILY"], createdEvents: [{ scope: "DAILY", type: "BREACHED" }] });
    expect((await run(["breakers", "status", "--capital", String(CAPITAL), "--as-of", at(monday, 2).toISOString()])).out).toContain('"blocked": false');
    expect((await run(["breakers", "record-loss", "--amount", "5", "--source", "synthetic", "--source-ref", `cli-${sfx()}`, "--created-by", "operator:itest"], { APP_ENV: "production" })).code).toBe(3);
    expect((await run(["nonsense"])).code).toBe(2);
    expect((await run(["breakers", "reset"])).code).toBe(2); // there is deliberately no early reset
    expect((await run(["breakers", "status"], { TWINS_SIZING_AVAILABLE_CAPITAL: "" })).code).toBe(2);
  });
});
