/**
 * Portfolio open-risk and correlation limits against REAL PostgreSQL (Stage 3 / Task 3). The database is shared and append-only, so earlier rows stay
 * "active": these tests use unique underlyings, a very large capital (1e9) and per-scenario percentage limits chosen so that ONLY the limit under test
 * can decide the outcome (a rejection is robust to leftovers; an approval needs the other limits set far above them).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  createRiskDecision, evaluatePortfolioRisk, getRiskDecision, listRiskDecisions, loadPortfolioConfig, RiskDecisionError, sizeRiskDecision, supersedeRiskDecision, type OpenPositionSource,
  type PortfolioOptions, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const SIZE_CAPITAL = 1_000_000; // candidates are sized at 1% of this: 10,000 (HIGH), 5,000 (MEDIUM), 2,500 (LOW)
const CAPITAL = 1_000_000_000; // the portfolio is evaluated against this, so percentages are tiny and leftovers are irrelevant
const sym = () => `PF${sfx()}`.toUpperCase();

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

/** Limits: everything wide open except the overrides (percent of CAPITAL = 1e9: 0.0015 = 15,000). */
const limits = (over: Record<string, string> = {}, groups = "NONE") => loadPortfolioConfig({
  TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100",
  TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999",
  TWINS_PORTFOLIO_CORRELATION_GROUPS: groups, ...over,
});
const opts = (config = limits(), extra: Partial<PortfolioOptions> = {}): PortfolioOptions => ({ config, capital: CAPITAL, ...extra });

// ── fixtures ──
type Made = { signalId: string; decisionId: string; evidenceId: string; symbol: string };
async function makeSignal(symbol: string, instrumentType = "equity", lotSize: string | null = null) {
  const exchange = instrumentType === "equity" ? "NSE" : "NFO"; // one instrument per (exchange, symbol): equity and derivatives on one underlying are separate instruments
  const [existing] = await db().select().from(schema.instruments).where(and(eq(schema.instruments.symbol, symbol), eq(schema.instruments.exchange, exchange)));
  const [instrument] = existing ? [existing] : await db().insert(schema.instruments).values({ symbol, exchange, instrumentType, lotSize }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "pf-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110, 120, 130], signalTimestamp: new Date() }).returning();
  return must(signal);
}
async function evidence(signalId: string, result: "VALID" | "INVALID" = "VALID", entry = "100", stop = "95") {
  const valid = result === "VALID";
  const [row] = await db().insert(schema.stopLossValidations).values({
    subjectKind: "signal", signalId, ruleVersion: "stop-loss-v1", result, reasonCode: valid ? null : "STOP_LOSS_WRONG_SIDE", levelBasis: "price",
    normalizedStopLoss: valid ? stop : null, entryPrice: valid ? entry : null, riskDistance: valid ? "5" : null, riskPct: valid ? "5" : null, maxRiskPct: "10",
  }).returning();
  return must(row);
}
function pending(signalId: string, evId: string, over: Partial<RiskDecisionInput> & { confidence01?: number } = {}): RiskDecisionInput {
  const { confidence01, ...rest } = over;
  return {
    subject: { kind: "signal", signalId }, stopLossValidationId: evId, status: "PENDING", idempotencyKey: `pf-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol: "X", side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: confidence01 ?? 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false }, evidenceReferences: { fixture: true }, ...rest,
  };
}
/** A signal + VALID evidence + PENDING decision, SIZED by the real sizing module (so it is a candidate for the portfolio evaluation). */
async function makeSized(symbol: string, o: { confidence01?: number; expiry?: string | null; side?: string; market?: string; instrumentType?: string; lotSize?: string | null; entry?: number; stop?: number } = {}): Promise<Made> {
  const entry = o.entry ?? 100, stop = o.stop ?? 95;
  const signal = await makeSignal(symbol, o.instrumentType ?? "equity", o.lotSize ?? null);
  const ev = await evidence(signal.id, "VALID", String(entry), String(stop));
  const v1 = await createRiskDecision(db(), pending(signal.id, ev.id, { symbol, expiry: o.expiry ?? null, side: o.side ?? "BUY", market: o.market ?? "NSE", instrumentType: o.instrumentType ?? "equity", entryPrice: entry, stopLoss: stop, confidence01: o.confidence01 ?? 0.9 }));
  const sized = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
  expect(sized.sizingStatus).toBe("SIZED");
  return { signalId: signal.id, decisionId: sized.id, evidenceId: ev.id, symbol };
}
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);
const raw = async (id: string) => must((await pool.query("select * from risk_decisions where id = $1", [id])).rows[0]);
/** Makes a decision inactive by appending a REJECTED / EXPIRED successor (never an update). */
async function retire(m: Made, status: "REJECTED" | "EXPIRED") {
  const d = must(await getRiskDecision(db(), m.decisionId));
  return supersedeRiskDecision(db(), d.id, { stopLossValidationId: m.evidenceId, status, idempotencyKey: `pf-retire:${randomUUID()}`, createdBy: "operator:itest", instrumentType: d.instrumentType, market: d.market, symbol: d.symbol, side: d.side, entryPrice: 100, stopLoss: 95, stopLossBasis: "price", plannedQuantity: Number(d.plannedQuantity), plannedNotional: Number(d.plannedNotional), plannedMaxLossAmount: Number(d.plannedMaxLossAmount), plannedMaxLossPercent: Number(d.plannedMaxLossPercent), decisionReasonCode: `retired_${status.toLowerCase()}`, inputSnapshot: { retired: true } });
}

describe("a candidate within the limits becomes a new APPROVED_FOR_REVIEW version", () => {
  it("appends v3 (portfolio-risk actor) with sizing, evaluated limits, current/proposed/resulting exposure; v2 untouched", async () => {
    const m = await makeSized(sym());
    const before = await raw(m.decisionId);
    const out = await evaluatePortfolioRisk(db(), m.decisionId, opts());
    expect(out).toMatchObject({ created: true, decisionVersion: 3, status: "APPROVED_FOR_REVIEW", portfolioOutcome: "APPROVED_FOR_REVIEW", reasonCode: null });
    const v3 = must(await getRiskDecision(db(), out.id));
    expect(v3).toMatchObject({ supersedesId: m.decisionId, createdBy: "service:portfolio-risk", decisionReasonCode: "portfolio_within_limits", stopLossValidationId: m.evidenceId, effectiveStatus: "APPROVED_FOR_REVIEW" });
    expect(Number(v3.plannedQuantity)).toBe(2000);
    expect(Number(v3.plannedMaxLossAmount)).toBe(10000);
    const snap = v3.outputSnapshot as { stage: string; limitsApplied: boolean; sizing: { status: string }; portfolio: Record<string, Record<string, unknown>> };
    expect(snap).toMatchObject({ stage: "portfolio_risk", limitsApplied: true, sizing: { status: "SIZED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW", capital: CAPITAL, engineVersion: "portfolio-v1" } });
    expect(snap.portfolio["limits"]).toMatchObject({ maxActive: 9999 });
    expect(snap.portfolio["proposed"]).toMatchObject({ amount: 10000, count: 1 });
    expect(snap.portfolio["current"]["underlying"]).toMatchObject({ amount: 0, count: 0 });
    expect(snap.portfolio["resulting"]["underlying"]).toMatchObject({ amount: 10000, count: 1 });
    expect(v3.inputSnapshot).toMatchObject({ previousDecisionId: m.decisionId, previousVersion: 2, portfolio: { outcome: "APPROVED_FOR_REVIEW" } });
    expect(v3.evidenceReferences).toMatchObject({ previousDecisionId: m.decisionId, stopLossValidationId: m.evidenceId });
    expect(await raw(m.decisionId)).toEqual(before); // never mutated
    expect(must(await getRiskDecision(db(), m.decisionId))).toMatchObject({ effectiveStatus: "SUPERSEDED", supersededById: out.id });
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
});

describe("limit failures create a REJECTED version with a machine-readable reason", () => {
  const rejected = async (m: Made, config: ReturnType<typeof limits>, extra: Partial<PortfolioOptions> = {}) => {
    const out = await evaluatePortfolioRisk(db(), m.decisionId, opts(config, extra));
    expect(out).toMatchObject({ created: true, decisionVersion: 3, status: "REJECTED", portfolioOutcome: "REJECTED" });
    const v3 = must(await getRiskDecision(db(), out.id));
    expect(v3).toMatchObject({ supersedesId: m.decisionId, status: "REJECTED", createdBy: "service:portfolio-risk" });
    expect((v3.outputSnapshot as { portfolio: { outcome: string } }).portfolio.outcome).toBe("REJECTED");
    return { out, v3, portfolio: (v3.outputSnapshot as { portfolio: { failures: Array<Record<string, unknown>>; reasonCode: string } }).portfolio };
  };
  it("total portfolio risk exceeded (absolute cap below the candidate)", async () => {
    const m = await makeSized(sym());
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "5000" }));
    expect(r.out.reasonCode).toBe("PORTFOLIO_RISK_LIMIT_EXCEEDED");
    expect(r.v3.decisionReasonCode).toBe("portfolio_portfolio_risk_limit_exceeded");
    expect(r.portfolio.failures[0]).toMatchObject({ reason: "PORTFOLIO_RISK_LIMIT_EXCEEDED", scope: "total", limit: 5000 });
  });
  it("market risk exceeded", async () => {
    const m = await makeSized(sym());
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "0.000001" })); // 1,000 < 10,000
    expect(r.out.reasonCode).toBe("MARKET_RISK_LIMIT_EXCEEDED");
  });
  it("same-underlying concentration: an existing active decision on the same symbol", async () => {
    const s = sym();
    await makeSized(s);
    const m = await makeSized(s);
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015" })); // 15,000 < 10,000 + 10,000
    expect(r.out.reasonCode).toBe("UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED");
    expect(r.portfolio.failures[0]).toMatchObject({ scope: "underlying", key: s, kind: "risk" });
  });
  it("correlation group: two related underlyings (the NIFTY/BANKNIFTY shape) exceed the group limit together", async () => {
    const a = sym(), b = sym(), c = sym();
    const group = `G${sfx().toUpperCase()}`;
    const groups = `${group}=${a},${b},${c}`;
    await makeSized(a);
    await makeSized(b);
    const m = await makeSized(c);
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "0.002" }, groups)); // 20,000 < 30,000; each underlying alone is fine
    expect(r.out.reasonCode).toBe("CORRELATION_GROUP_LIMIT_EXCEEDED");
    expect(r.portfolio.failures[0]).toMatchObject({ scope: "group", key: group });
  });
  it("same underlying + same expiry is the tighter concentration group; a different expiry is not", async () => {
    const s = sym();
    await makeSized(s, { expiry: "2031-12-30" });
    const same = await makeSized(s, { expiry: "2031-12-30", confidence01: 0.6 });
    const r = await rejected(same, limits({ TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "0.001" })); // 10,000 < 10,000 + 5,000
    expect(r.out.reasonCode).toBe("CANDIDATE_CONCENTRATION_LIMIT_EXCEEDED");
    const other = await makeSized(s, { expiry: "2032-01-27", confidence01: 0.6 });
    expect(await evaluatePortfolioRisk(db(), other.decisionId, opts(limits({ TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "0.001" })))).toMatchObject({ portfolioOutcome: "APPROVED_FOR_REVIEW" });
  });
  it("equity, futures and options-style records on one underlying are related exposure", async () => {
    const s = sym();
    await makeSized(s, { instrumentType: "equity" });
    const future = await makeSized(s, { instrumentType: "future", lotSize: "10", entry: 1000, stop: 950 });
    const r = await rejected(future, limits({ TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015" }));
    expect(r.out.reasonCode).toBe("UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED");
  });
  it("maximum active decisions", async () => {
    await makeSized(sym());
    const m = await makeSized(sym());
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_ACTIVE: "1" }));
    expect(r.out.reasonCode).toBe("MAX_ACTIVE_DECISIONS_EXCEEDED");
    expect(r.portfolio.failures.find((f) => f["reason"] === "MAX_ACTIVE_DECISIONS_EXCEEDED")).toMatchObject({ kind: "count", limit: 1 });
  });
  it("maximum decisions per underlying and per correlation group", async () => {
    const s = sym();
    await makeSized(s);
    const m = await makeSized(s);
    expect((await rejected(m, limits({ TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "1" }))).out.reasonCode).toBe("UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED");
    const a = sym(), b = sym();
    await makeSized(a);
    const m2 = await makeSized(b);
    const r2 = await rejected(m2, limits({ TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "1" }, `GC${sfx().toUpperCase()}=${a},${b}`));
    expect(r2.out.reasonCode).toBe("CORRELATION_GROUP_LIMIT_EXCEEDED");
  });
  it("open-position exposure from the (future) open-position source counts too", async () => {
    const s = sym();
    const m = await makeSized(s);
    const positions: OpenPositionSource = { listOpenExposures: async () => [{ id: "pos-1", source: "open_position", maxLossAmount: 10000, market: "NSE", instrumentType: "future", underlying: s, side: "SELL", expiry: null }] };
    const r = await rejected(m, limits({ TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015" }), { openPositions: positions });
    expect(r.out.reasonCode).toBe("UNDERLYING_CONCENTRATION_LIMIT_EXCEEDED");
    expect((r.v3.evidenceReferences as { activeExposureIds: string[] }).activeExposureIds).toContain("pos-1");
  });
});

describe("only active risk counts", () => {
  it("rejected, expired and superseded decisions, and decisions without a size, are not active exposure", async () => {
    const s = sym();
    const cfg = limits({ TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015" });
    const first = await makeSized(s); // active 10,000
    // sanity: while it is active a second decision on the symbol is rejected (10,000 + 10,000 > 15,000)
    expect((await evaluatePortfolioRisk(db(), (await makeSized(s)).decisionId, opts(cfg))).portfolioOutcome).toBe("REJECTED");
    await retire(first, "REJECTED");
    const second = await makeSized(s);
    await retire(second, "EXPIRED");
    const sig = await makeSignal(s); // a PENDING decision with no size at all
    await createRiskDecision(db(), pending(sig.id, (await evidence(sig.id)).id, { symbol: s }));
    // the earlier portfolio-REJECTED version and the superseded sized versions are also inactive: the symbol now has no active exposure
    const fresh = await makeSized(s);
    expect(await evaluatePortfolioRisk(db(), fresh.decisionId, opts(cfg))).toMatchObject({ portfolioOutcome: "APPROVED_FOR_REVIEW" });
    const rows = await listRiskDecisions(db(), { signalId: first.signalId });
    expect(rows.map((r) => r.effectiveStatus)).toContain("SUPERSEDED");
  });
});

describe("versioned, idempotent recalculation", () => {
  it("identical inputs return the existing version; changed exposure appends the next version without mutating the old one", async () => {
    const s = sym();
    const blocker = await makeSized(s);
    const m = await makeSized(s);
    const cfg = limits({ TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "0.0015" });
    const v3 = await evaluatePortfolioRisk(db(), m.decisionId, opts(cfg));
    expect(v3).toMatchObject({ created: true, decisionVersion: 3, status: "REJECTED" });
    const before = await raw(v3.id);
    const again = await evaluatePortfolioRisk(db(), v3.id, opts(cfg)); // same inputs, against the current version
    expect(again).toMatchObject({ id: v3.id, created: false });
    expect(await evaluatePortfolioRisk(db(), m.decisionId, opts(cfg))).toMatchObject({ id: v3.id, created: false }); // retried against the version it superseded
    expect(await listRiskDecisions(db(), { signalId: m.signalId })).toHaveLength(3);
    // the blocker leaves the portfolio: the rejected decision can be evaluated again and is approved as version 4
    await retire(blocker, "EXPIRED");
    const v4 = await evaluatePortfolioRisk(db(), v3.id, opts(cfg));
    expect(v4).toMatchObject({ created: true, decisionVersion: 4, status: "APPROVED_FOR_REVIEW" });
    expect(must(await getRiskDecision(db(), v4.id))).toMatchObject({ supersedesId: v3.id });
    expect(await raw(v3.id)).toEqual(before);
    expect(must(await getRiskDecision(db(), v3.id)).effectiveStatus).toBe("SUPERSEDED");
  });
  it("parallel evaluations are serialized: the group limit is never exceeded by the approvals together", async () => {
    const symbols = [sym(), sym(), sym(), sym()];
    const group = `GP${sfx().toUpperCase()}`;
    const cfg = limits({ TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "0.0025" }, `${group}=${symbols.join(",")}`); // 25,000: at most two 10,000 decisions
    const results = await Promise.all(symbols.map(async (s) => { const m = await makeSized(s); return evaluatePortfolioRisk(db(), m.decisionId, opts(cfg)); }));
    const approved = results.filter((r) => r.portfolioOutcome === "APPROVED_FOR_REVIEW");
    expect(approved.length).toBeLessThanOrEqual(2);
    const sum = await pool.query("select coalesce(sum(planned_max_loss_amount), 0)::float as s from risk_decisions_effective where id = any($1) and status = 'APPROVED_FOR_REVIEW'", [results.map((r) => r.id)]);
    expect(Number(must(sum.rows[0])["s"])).toBeLessThanOrEqual(25000);
  });
});

describe("no evaluation or approval without valid sizing and stop-loss evidence", () => {
  it("an unsized PENDING decision is refused (sizing_missing) and nothing is written", async () => {
    const signal = await makeSignal(sym());
    const ev = await evidence(signal.id);
    const v1 = await createRiskDecision(db(), pending(signal.id, ev.id));
    const before = await rowCount("risk_decisions");
    expect((await err(evaluatePortfolioRisk(db(), v1.id, opts()))).code).toBe("sizing_missing");
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("a sizing-rejected decision (no size) is not evaluable", async () => {
    const signal = await makeSignal(sym());
    const ev = await evidence(signal.id);
    const v1 = await createRiskDecision(db(), pending(signal.id, ev.id, { sourceTrustTier: "UNKNOWN" }));
    const rejectedBySizing = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
    expect(rejectedBySizing.status).toBe("REJECTED");
    expect((await err(evaluatePortfolioRisk(db(), rejectedBySizing.id, opts()))).code).toBe("not_evaluable");
  });
  it("a later INVALID stop-loss validation blocks the evaluation (stop_loss_not_valid) and nothing is written", async () => {
    const m = await makeSized(sym());
    await evidence(m.signalId, "INVALID");
    const before = await rowCount("risk_decisions");
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, opts()))).code).toBe("stop_loss_not_valid");
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("unknown ids and decisions approved elsewhere are refused", async () => {
    expect((await err(evaluatePortfolioRisk(db(), randomUUID(), opts()))).code).toBe("not_found");
    const m = await makeSized(sym());
    const d = must(await getRiskDecision(db(), m.decisionId));
    const approvedElsewhere = await supersedeRiskDecision(db(), d.id, {
      stopLossValidationId: m.evidenceId, status: "APPROVED_FOR_REVIEW", idempotencyKey: `pf-elsewhere:${randomUUID()}`, createdBy: "operator:itest", instrumentType: "equity", market: "NSE", symbol: m.symbol, side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price",
      plannedQuantity: 1000, plannedNotional: 100000, plannedMaxLossAmount: 5000, plannedMaxLossPercent: 0.5, decisionReasonCode: "manual", inputSnapshot: { x: 1 }, outputSnapshot: { sizing: { status: "SIZED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW" } },
    });
    expect((await err(evaluatePortfolioRisk(db(), approvedElsewhere.id, opts()))).code).toBe("not_evaluable");
  });
  it("the database refuses APPROVED_FOR_REVIEW without a passing portfolio evaluation, even for a SIZED decision", async () => {
    const m = await makeSized(sym());
    const d = must(await getRiskDecision(db(), m.decisionId));
    const attempt = (outputSnapshot: Record<string, unknown>) => supersedeRiskDecision(db(), d.id, {
      stopLossValidationId: m.evidenceId, status: "APPROVED_FOR_REVIEW", idempotencyKey: `pf-nopf:${randomUUID()}`, createdBy: "operator:itest", instrumentType: "equity", market: "NSE", symbol: m.symbol, side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price",
      plannedQuantity: 1000, plannedNotional: 100000, plannedMaxLossAmount: 5000, plannedMaxLossPercent: 0.5, decisionReasonCode: "manual", inputSnapshot: { x: 1 }, outputSnapshot,
    });
    for (const snap of [{ sizing: { status: "SIZED" } }, { sizing: { status: "SIZED" }, portfolio: { outcome: "REJECTED" } }, { sizing: { status: "SIZED" }, portfolio: {} }]) {
      expect((await err(attempt(snap))).code).toBe("stop_loss_not_valid"); // mapped from the database check violation for an approval
    }
    expect(await listRiskDecisions(db(), { signalId: m.signalId })).toHaveLength(2);
  });
});

describe("runtime state is fail closed; nothing downstream is written", () => {
  it("kill switch, intake off and an unreadable state refuse and append nothing", async () => {
    const m = await makeSized(sym());
    const before = await rowCount("risk_decisions");
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, opts()))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false, INTAKE_ENABLED: false });
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, opts()))).code).toBe("safety_refused");
    source.set({ INTAKE_ENABLED: true });
    source.failWith(new Error("state unreadable"));
    expect((await err(evaluatePortfolioRisk(db(), m.decisionId, opts()))).code).toBe("safety_refused");
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("an open-position source that fails aborts the evaluation (fail closed) and appends nothing", async () => {
    const m = await makeSized(sym());
    const before = await rowCount("risk_decisions");
    await expect(evaluatePortfolioRisk(db(), m.decisionId, opts(limits(), { openPositions: { listOpenExposures: async () => { throw new Error("position store down"); } } }))).rejects.toThrow(/position store down/);
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("evaluations write no order, fill, position, legacy decision or approval card, and the audit chain verifies", async () => {
    const counts = async () => Promise.all(["orders", "fills", "positions", "decisions", "claim_review_cards"].map(rowCount));
    const before = await counts();
    const a = await makeSized(sym());
    const b = await makeSized(sym());
    await evaluatePortfolioRisk(db(), a.decisionId, opts());
    await evaluatePortfolioRisk(db(), b.decisionId, opts(limits({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "1" })));
    expect(await counts()).toEqual(before);
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
});
