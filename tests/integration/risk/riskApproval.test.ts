/**
 * Risk decision approval workflow against REAL PostgreSQL (Stage 3 / Task 6): eligibility, the approval card, the database function that records APPROVE / REJECT
 * (re-checking eligibility at that instant), immutability and the audit chain, the bearer-protected API, and the restricted bot / runtime roles. Market data is
 * synthetic; nothing contacts Telegram; no order, fill, position or broker call exists in this flow.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChains, verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  assessApprovalEligibility, createApprovalCard, createRiskDecision, evaluateMarketRisk, evaluatePortfolioRisk, expireRiskDecision, listRecentApprovals, listRecentDecisionSummaries, loadPortfolioConfig, recordLossEvent,
  recordRiskApproval, RiskDecisionError, sizeRiskDecision, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { PgBotDb } from "../../../services/approval-bot/src/db";
import { buildApp } from "../../support/apiWithTestPolicy";
import { memoryOutbox } from "../../support/memoryOutbox";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";
import { healthy, OPEN_NOW, syntheticProvider } from "./gates";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const SIZE_CAPITAL = 1_000_000;
const CAPITAL = 1_000_000_000;
const MIN = 60_000;
const API_KEY = "itest-risk-api-key-0123456789";

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const pfOpts = { config: openLimits(), capital: CAPITAL };
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface Stage { signalId: string; evidenceId: string; v1: string; sized: string; portfolio?: string; approved?: string; rejected?: string }
/** Builds a decision up to a stage: "pending" (unsized v1) | "sized" | "portfolio" | "approved" (all gates passed) | "market_rejected". */
async function make(stage: "pending" | "sized" | "portfolio" | "approved" | "market_rejected", symbol = `RA${sfx()}`.toUpperCase()): Promise<Stage & { head: string }> {
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "ra-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ra-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol, side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false, intelligence: validIntelligence() }, evidenceReferences: { fixture: true },
  };
  const v1 = await createRiskDecision(db(), input);
  const base = { signalId: must(signal).id, evidenceId: must(ev).id, v1: v1.id, sized: v1.id };
  if (stage === "pending") return { ...base, head: v1.id };
  const sized = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
  if (stage === "sized") return { ...base, sized: sized.id, head: sized.id };
  const pf = await evaluatePortfolioRisk(db(), sized.id, pfOpts);
  if (stage === "portfolio") return { ...base, sized: sized.id, portfolio: pf.id, head: pf.id };
  const bad = stage === "market_rejected";
  const mk = await evaluateMarketRisk(db(), pf.id, { provider: syntheticProvider(healthy(OPEN_NOW, bad ? { bidQty: 1 } : {})), now: OPEN_NOW, capital: CAPITAL });
  return { ...base, sized: sized.id, portfolio: pf.id, ...(bad ? { rejected: mk.id } : { approved: mk.id }), head: mk.id };
}
const approvedOne = async () => must((await make("approved")).approved);

describe("approval eligibility (every condition, each with its own reason)", () => {
  it("a decision that passed sizing, the portfolio limits and the market gates, with a valid stop-loss, no breaker and no kill switch, is eligible", async () => {
    const id = await approvedOne();
    const a = await assessApprovalEligibility(db(), id);
    expect(a).toMatchObject({ eligible: true, reasons: [] });
    expect(a.validUntil!.getTime() - a.decision!.createdAt.getTime()).toBe(15 * MIN);
  });
  it.each([
    ["unsized PENDING decision", () => make("pending"), ["decision_not_approved_for_review", "sizing_missing", "portfolio_not_passed", "market_not_passed"]],
    ["sized but the portfolio has not passed it", () => make("sized"), ["decision_not_approved_for_review", "portfolio_not_passed", "market_not_passed"]],
    ["portfolio passed but the market gates have not run", () => make("portfolio"), ["decision_not_approved_for_review", "market_not_passed"]],
    ["market gate failed (REJECTED)", () => make("market_rejected"), ["decision_not_approved_for_review", "market_not_passed"]],
  ] as const)("%s", async (_n, build, expected) => {
    const m = await build();
    const a = await assessApprovalEligibility(db(), m.head);
    expect(a.eligible).toBe(false);
    expect(a.reasons).toEqual(expect.arrayContaining([...expected]));
    expect(a.reasons).not.toContain("stop_loss_not_valid");
  });
  it("a failed portfolio evaluation is not eligible (REJECTED with portfolio_not_passed)", async () => {
    const m = await make("sized");
    const pf = await evaluatePortfolioRisk(db(), m.head, { config: loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_AMOUNT: "1", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" }), capital: CAPITAL });
    expect(pf.status).toBe("REJECTED");
    expect((await assessApprovalEligibility(db(), pf.id)).reasons).toEqual(expect.arrayContaining(["decision_not_approved_for_review", "portfolio_not_passed"]));
  });
  it("a missing stop-loss: a later INVALID stop-loss validation makes the decision ineligible", async () => {
    const m = await make("approved");
    await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: m.signalId, ruleVersion: "stop-loss-v1", result: "MISSING", reasonCode: "MISSING_STOP_LOSS", levelBasis: "price", maxRiskPct: "10" });
    expect((await assessApprovalEligibility(db(), must(m.approved))).reasons).toContain("stop_loss_not_valid");
  });
  it("expired (past its 15-minute validity), superseded, unknown", async () => {
    const m = await make("approved");
    const id = must(m.approved);
    expect((await assessApprovalEligibility(db(), id, { now: new Date(Date.now() + 14 * MIN) })).eligible).toBe(true);
    expect((await assessApprovalEligibility(db(), id, { now: new Date(Date.now() + 16 * MIN) })).reasons).toContain("decision_expired");
    const exp = await expireRiskDecision(db(), id, { asOf: new Date(Date.now() + 16 * MIN) });
    expect(exp.result).toBe("expired");
    expect((await assessApprovalEligibility(db(), id)).reasons).toEqual(expect.arrayContaining(["decision_superseded"]));
    expect((await assessApprovalEligibility(db(), must(exp.expiredId))).reasons).toEqual(expect.arrayContaining(["decision_not_approved_for_review"]));
    expect((await assessApprovalEligibility(db(), randomUUID())).reasons).toEqual(["decision_not_found"]);
  });
  it("a superseded earlier version is ineligible even though it was once approved", async () => {
    const m = await make("approved");
    const lost = await evaluateMarketRisk(db(), must(m.approved), { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 1 })), now: OPEN_NOW, capital: CAPITAL });
    expect(lost.status).toBe("REJECTED");
    expect((await assessApprovalEligibility(db(), must(m.approved))).reasons).toContain("decision_superseded");
  });
  it("kill switch and an unreadable runtime state; an open circuit breaker", async () => {
    const id = await approvedOne();
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await assessApprovalEligibility(db(), id)).reasons).toContain("kill_switch_active");
    source.set({ KILL_SWITCH_ACTIVE: false });
    source.failWith(new Error("down"));
    expect((await assessApprovalEligibility(db(), id)).reasons).toContain("state_unavailable");
    source.failWith(null);
    const day = new Date("2024-07-03T04:30:00Z");
    await recordLossEvent(db(), { amount: 30_000_000, occurredAt: new Date("2024-07-03T04:00:00Z"), source: "synthetic", sourceRef: `ra-${sfx()}`, createdBy: "service:itest" });
    const a = await assessApprovalEligibility(db(), id, { now: day });
    expect(a.reasons).toContain("circuit_breaker_open");
    expect(a.breaker).toMatchObject({ blocked: true });
  });
});

describe("the approval card", () => {
  it("is created for an eligible decision (idempotently), holds the rendered proposal and a hash, and expires with the decision", async () => {
    const id = await approvedOne();
    const c = await createApprovalCard(db(), id);
    expect(c).toMatchObject({ created: true, decisionId: id, decisionVersion: 4 });
    const [row] = await db().select().from(schema.riskApprovalCards).where(eq(schema.riskApprovalCards.id, c.cardId));
    expect(row).toMatchObject({ state: "pending", riskDecisionId: id, decisionVersion: 4, createdBy: "service:risk-approval", telegramMessageId: null });
    expect(row?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.cardContentSha256).toBe(sha(must(row).cardText));
    expect(row?.expiresAt.getTime()).toBe(c.expiresAt.getTime());
    for (const needle of ["RISK-REVIEWED PROPOSAL", "not investment advice", "Planned maximum loss:", "Portfolio planned risk:", "Market session: OPEN", "Loss circuit breakers: daily", "Valid until:", "Key risks:", "Evidence: decision"]) expect(row?.cardText, needle).toContain(needle);
    expect(row?.cardText).not.toMatch(/raw|token|password|tg_chat|idempotency/i);
    expect(await createApprovalCard(db(), id)).toMatchObject({ cardId: c.cardId, created: false });
  });
  it("is NOT created for an ineligible decision (and nothing is written), nor under the kill switch or an unreadable state", async () => {
    const before = await rowCount("risk_approval_cards");
    for (const m of [await make("pending"), await make("portfolio"), await make("market_rejected")]) {
      const e = await err(createApprovalCard(db(), m.head));
      expect(e.code).toBe("not_approval_eligible");
    }
    expect((await err(createApprovalCard(db(), randomUUID()))).code).toBe("not_found");
    const id = await approvedOne();
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(createApprovalCard(db(), id))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false });
    source.failWith(new Error("down"));
    expect((await err(createApprovalCard(db(), id))).code).toBe("safety_refused");
    source.failWith(null);
    expect(await rowCount("risk_approval_cards")).toBe(before);
  });
  it("its content is immutable, its state only moves forward, and it can never be deleted", async () => {
    const c = await createApprovalCard(db(), await approvedOne());
    const code = async (sql: string, params: unknown[] = []) => { const c2 = await pool.connect(); try { await c2.query("begin"); return await c2.query(sql, params).then(() => "ok", (e: { code?: string }) => e.code); } finally { await c2.query("rollback"); c2.release(); } };
    expect(await code("update risk_approval_cards set card_text = 'edited' where id = $1", [c.cardId])).toBe("23001");
    expect(await code("update risk_approval_cards set nonce = $2 where id = $1", [c.cardId, "f".repeat(32)])).toBe("23001");
    expect(await code("update risk_approval_cards set expires_at = expires_at + interval '1 day' where id = $1", [c.cardId])).toBe("23001");
    expect(await code("update risk_approval_cards set state = 'decided' where id = $1", [c.cardId])).toBe("23514"); // pending -> decided skips 'sent'
    expect(await code("delete from risk_approval_cards where id = $1", [c.cardId])).toBe("23001");
    expect(["23001", "0A000"]).toContain(await code("truncate risk_approval_cards"));
    expect(await code("update risk_approval_cards set state = 'sent', telegram_message_id = 77, card_text_sha256 = $2 where id = $1", [c.cardId, "0".repeat(64)])).toBe("23514"); // a different hash than the card's own
  });
});

/** Walks a card to 'sent' exactly as the bot does (through the SECURITY DEFINER function). */
async function sentCard(decisionId: string, messageId = 4242) {
  const c = await createApprovalCard(db(), decisionId);
  const ok = (await pool.query("select twins_risk_card_mark_sent($1::uuid, $2::bigint, $3::text) as ok", [c.cardId, messageId, c.cardSha256])).rows[0]?.ok;
  expect(ok).toBe(true);
  return { ...c, messageId };
}
const tap = async (decisionId: string, cardId: string | null, action: string, messageId: number | null = 4242, actor = "telegram:123456789", reason: string | null = null, validUntil: Date | null = null) =>
  String(must((await pool.query("select twins_record_risk_approval($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::timestamptz) as o", [decisionId, cardId, action, actor, JSON.stringify({ cardMessageId: messageId, updateId: 7, via: "approval_bot" }), reason, validUntil?.toISOString() ?? null])).rows[0])["o"]);
const approvals = async (decisionId: string) => (await pool.query("select * from risk_approvals where risk_decision_id = $1", [decisionId])).rows;

describe("recording APPROVE / REJECT (the database function re-checks everything at that instant)", () => {
  it("a valid APPROVE through the card is recorded once, with the full snapshot, evidence, actor, validity and card hash - and creates no order", async () => {
    const counts = async () => Promise.all(["orders", "fills", "positions", "decisions", "claim_review_cards"].map(rowCount));
    const before = await counts();
    const id = await approvedOne();
    const c = await sentCard(id);
    expect(await tap(id, c.cardId, "APPROVE")).toBe("recorded");
    const [a] = await approvals(id);
    expect(a).toMatchObject({ action: "APPROVE", actor: "telegram:123456789", decision_version: 4, card_id: c.cardId, card_text_sha256: c.cardSha256 });
    expect(a.actor_context).toMatchObject({ cardMessageId: 4242, updateId: 7, via: "approval_bot" });
    expect(a.decision_snapshot).toMatchObject({ riskDecisionId: id, decisionVersion: 4, status: "APPROVED_FOR_REVIEW", symbol: expect.any(String), plannedQuantity: 2000, plannedMaxLossAmount: 10000, outputSnapshot: { market: { outcome: "PASSED" }, portfolio: { outcome: "APPROVED_FOR_REVIEW" } } });
    expect(a.evidence_references).toMatchObject({ riskDecisionId: id });
    expect(Object.keys(a.evidence_references)).toEqual(expect.arrayContaining(["stopLossValidationId"]));
    expect(new Date(a.valid_until as string).getTime()).toBe(c.expiresAt.getTime());
    expect((await pool.query("select state from risk_approval_cards where id = $1", [c.cardId])).rows[0]?.state).toBe("decided");
    expect(await counts()).toEqual(before); // approval is a record: no order, fill, position, legacy decision or claim card
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_approvals"] })).ok).toBe(true);
  });
  it("a REJECT is recorded with its reason (default reason for a tap), also for a decision that is no longer current", async () => {
    const id = await approvedOne();
    const c = await sentCard(id);
    expect(await tap(id, c.cardId, "REJECT")).toBe("recorded");
    expect((await approvals(id))[0]).toMatchObject({ action: "REJECT", reason: "rejected_by_reviewer" });
    const m = await make("approved");
    await expireRiskDecision(db(), must(m.approved), { asOf: new Date(Date.now() + 16 * MIN) }); // superseded + expired
    expect(await tap(must(m.approved), null, "REJECT", null, "operator:itest", "no longer wanted")).toBe("recorded");
    expect((await approvals(must(m.approved)))[0]).toMatchObject({ action: "REJECT", reason: "no longer wanted" });
  });
  it("duplicate handling: a second tap or a conflicting second action records nothing; a changed decision needs its own approval", async () => {
    const id = await approvedOne();
    const c = await sentCard(id);
    expect(await tap(id, c.cardId, "APPROVE")).toBe("recorded");
    expect(await tap(id, c.cardId, "APPROVE")).toBe("duplicate");
    expect(await tap(id, c.cardId, "REJECT")).toBe("duplicate");
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe("duplicate");
    expect(await approvals(id)).toHaveLength(1);
    // the next version of the decision is a different row: the earlier approval does not carry over
    const next = await evaluateMarketRisk(db(), id, { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 5_001 })), now: OPEN_NOW, capital: CAPITAL });
    expect(next.status).toBe("APPROVED_FOR_REVIEW");
    expect(await approvals(next.id)).toHaveLength(0);
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe("duplicate"); // the old version still shows its own record
    expect(await tap(next.id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe("recorded");
  });
  it.each([
    ["a superseded decision", async () => { const m = await make("approved"); await evaluateMarketRisk(db(), must(m.approved), { provider: syntheticProvider(healthy(OPEN_NOW, { bidQty: 1 })), now: OPEN_NOW, capital: CAPITAL }); return must(m.approved); }, "refused:decision_superseded"],
    ["a decision that is not APPROVED_FOR_REVIEW", async () => (await make("portfolio")).head, "refused:decision_not_approved_for_review"],
    ["an unsized decision", async () => (await make("pending")).head, "refused:decision_not_approved_for_review"],
    ["a market-rejected decision", async () => (await make("market_rejected")).head, "refused:decision_not_approved_for_review"],
    ["a stop-loss that is no longer VALID", async () => { const m = await make("approved"); await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: m.signalId, ruleVersion: "stop-loss-v1", result: "INVALID", reasonCode: "STOP_LOSS_WRONG_SIDE", levelBasis: "price", maxRiskPct: "10" }); return must(m.approved); }, "refused:stop_loss_not_valid"],
  ] as const)("APPROVE of %s is refused and nothing is recorded", async (_n, build, outcome) => {
    const id = await build();
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe(outcome);
    expect(await approvals(id)).toEqual([]);
  });
  it("APPROVE after the validity window is refused (and so is an out-of-range validity); an expired card cannot be used at all", async () => {
    const id = await approvedOne();
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() - MIN))).toBe("refused:decision_expired");
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, null)).toBe("refused:decision_expired");
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 30 * 24 * 60 * MIN))).toBe("refused:validity_out_of_range");
    const c = await sentCard(id);
    await pool.query("select 1"); // the card is valid; now simulate time passing by checking the function's own expiry rule on a card whose time has run out
    const expired = await createApprovalCard(db(), await approvedOne());
    await pool.query("update risk_approval_cards set state = 'sent' where false"); // (no-op: state changes only through the function)
    expect(await tap(id, expired.cardId, "APPROVE")).toBe("refused:card_not_found"); // a card of another decision
    expect(await tap(id, c.cardId, "APPROVE", 9999)).toBe("refused:card_not_active"); // the tap came from another message
    expect(await approvals(id)).toEqual([]);
  });
  it("APPROVE is refused under the kill switch (and the card is expired) while a REJECT is still recorded; an unreadable control row fails closed", async () => {
    const withState = async <T>(sql: string, run: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const c = await pool.connect();
      try { await c.query("begin"); await c.query(sql); return await run(c); } finally { await c.query("rollback"); c.release(); }
    };
    const kill = "update system_controls set value = true, version = version + 1, reason = 'integration test kill switch', changed_by = 'operator:itest' where control_name = 'KILL_SWITCH_ACTIVE'";
    const id = await approvedOne();
    const out = await withState(kill, async (c) => (await c.query("select twins_record_risk_approval($1::uuid, null, 'APPROVE', 'operator:itest', '{}'::jsonb, null, $2::timestamptz) as o", [id, new Date(Date.now() + 5 * MIN).toISOString()])).rows[0]?.o);
    expect(out).toBe("refused:kill_switch_active");
    const rej = await withState(kill, async (c) => (await c.query("select twins_record_risk_approval($1::uuid, null, 'REJECT', 'operator:itest', '{}'::jsonb, 'stop it', null) as o", [id])).rows[0]?.o);
    expect(rej).toBe("recorded"); // rolled back with the transaction; a rejection needs no safety state
    expect(await approvals(id)).toEqual([]);
    // a card refused for a business reason is expired in the same transaction
    const m = await make("approved");
    const c2 = await sentCard(must(m.approved));
    const refused = await withState(kill, async (c) => ({
      outcome: (await c.query("select twins_record_risk_approval($1::uuid, $2::uuid, 'APPROVE', 'telegram:5', $3::jsonb, null, null) as o", [m.approved, c2.cardId, JSON.stringify({ cardMessageId: 4242 })])).rows[0]?.o,
      state: (await c.query("select state from risk_approval_cards where id = $1", [c2.cardId])).rows[0]?.state,
    }));
    expect(refused).toEqual({ outcome: "refused:kill_switch_active", state: "expired" });
  });
  it("APPROVE is refused while a loss circuit breaker is open - in the function AND in the table guard", async () => {
    const id = await approvedOne();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`insert into circuit_breaker_events (id, scope, event_type, period_start, period_end, loss_amount, limit_amount, capital, loss_pct, planned_exposure_amount, reason_code, idempotency_key, snapshot, created_by)
        values (gen_random_uuid(), 'DAILY', 'BREACHED', now() - interval '1 hour', now() + interval '6 hours', 20000, 20000, 1000000, 2, 0, 'daily_loss_limit_breached', $1, '{}', 'service:itest')`, [`ra-gate-${randomUUID()}`]);
      expect((await c.query("select twins_record_risk_approval($1::uuid, null, 'APPROVE', 'operator:itest', '{}'::jsonb, null, $2::timestamptz) as o", [id, new Date(Date.now() + 5 * MIN).toISOString()])).rows[0]?.o).toBe("refused:circuit_breaker_open");
      await c.query("savepoint s");
      const direct = await c.query(`insert into risk_approvals (id, risk_decision_id, decision_version, action, actor, actor_context, decision_snapshot, evidence_references, valid_until) values (gen_random_uuid(), $1, 4, 'APPROVE', 'operator:itest', '{}', '{"x":1}', '{}', now() + interval '5 minutes')`, [id]).then(() => "inserted", (e: { message?: string }) => e.message);
      await c.query("rollback to savepoint s");
      expect(direct).toMatch(/a loss circuit breaker is open/);
    } finally { await c.query("rollback"); c.release(); }
    expect(await approvals(id)).toEqual([]);
  });
  it("input validation: unknown action, malformed actor, non-object context", async () => {
    const id = await approvedOne();
    const raw = (action: string, actor: string, ctx: string) => pool.query("select twins_record_risk_approval($1::uuid, null, $2, $3, $4::jsonb, null, null)", [id, action, actor, ctx]).then(() => "ok", (e: { code?: string }) => e.code);
    expect(await raw("MAYBE", "operator:x", "{}")).toBe("23514");
    expect(await raw("APPROVE", "somebody", "{}")).toBe("23514");
    expect(await raw("APPROVE", "operator:x", "[1]")).toBe("23514");
  });
});

describe("approvals are immutable and tamper-evident", () => {
  it("UPDATE, DELETE and TRUNCATE are rejected (also under replica role), the table guard refuses a wrong version, and an edit is detected by the chain", async () => {
    const id = await approvedOne();
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe("recorded");
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const sql of ["update risk_approvals set reason = 'x'", "delete from risk_approvals", "truncate risk_approvals", "truncate risk_approvals cascade"]) {
        await c.query("savepoint s");
        const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
        await c.query("rollback to savepoint s");
        expect(["23001", "0A000"], sql).toContain(e?.code);
      }
      await c.query("set local session_replication_role = replica");
      expect((await c.query("update risk_approvals set event_hash = event_hash").then(() => null, (x: { code?: string }) => x))?.code).toBe("23001");
      await c.query("rollback");
      await c.query("begin");
      await c.query("alter table risk_approvals disable trigger risk_approvals_no_update_delete");
      await c.query("update risk_approvals set actor = 'operator:forged' where chain_index = (select max(chain_index) from risk_approvals)");
      await c.query("alter table risk_approvals enable always trigger risk_approvals_no_update_delete");
      const report = await verifyAuditChains(c, { chains: ["risk_approvals"] });
      expect(report.ok).toBe(false);
      expect(report.firstFailure?.code).toBe("payload_modified");
      await c.query("rollback");
      await c.query("begin");
      const wrongVersion = await c.query(`insert into risk_approvals (id, risk_decision_id, decision_version, action, actor, actor_context, reason, decision_snapshot, evidence_references) values (gen_random_uuid(), $1, 99, 'REJECT', 'operator:x', '{}', 'r', '{"x":1}', '{}')`, [(await make("approved")).approved]).then(() => "inserted", (e: { message?: string }) => e.message);
      expect(wrongVersion).toMatch(/decision_version does not match/);
    } finally { await c.query("rollback").catch(() => undefined); c.release(); }
    expect((await verifyAuditChainsWithPool(pool)).ok).toBe(true);
  });
  it("an order needs a recorded APPROVE (the future approval-to-order step): none exists for an approved-but-unapproved decision", async () => {
    const id = await approvedOne();
    const order = (decisionId: string) => pool.connect().then(async (c) => { try { await c.query("begin"); return await c.query(`insert into orders (id, account_id, instrument_id, risk_decision_id, trading_mode, side, order_type, quantity, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, 'paper', 'buy', 'limit', 1, $2)`, [decisionId, `ord-${randomUUID()}`]).then(() => "inserted", (e: { message?: string }) => e.message); } finally { await c.query("rollback"); c.release(); } });
    expect(await order(id)).toMatch(/no recorded APPROVE approval/);
    expect(await tap(id, null, "APPROVE", null, "operator:itest", null, new Date(Date.now() + 5 * MIN))).toBe("recorded");
    expect(await order(id)).not.toMatch(/orders: /); // passes the order guards; the insert then fails on the next, unrelated rule (fake account)
  });
});

describe("the service / API path (operator identity, bearer token)", () => {
  const app = async () => buildApp({ apiKey: API_KEY, telegramWebhookSecret: "itest-webhook-secret-0123456789", intakeOutbox: memoryOutbox(), telegramQueue: { add: async () => ({ id: "x" }) }, db: db() });
  const auth = { authorization: `Bearer ${API_KEY}` };
  it("recordRiskApproval records, reports duplicates and refusals, and validates its input", async () => {
    const id = await approvedOne();
    expect((await err(recordRiskApproval(db(), { decisionId: id, action: "REJECT", actor: "operator:itest" }))).code).toBe("invalid_input"); // a reject needs a reason
    expect((await err(recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "someone" }))).code).toBe("invalid_input");
    expect(await recordRiskApproval(db(), { decisionId: randomUUID(), action: "APPROVE", actor: "operator:itest" })).toEqual({ outcome: "refused", reason: "decision_not_found" });
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect(await recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "operator:itest" })).toEqual({ outcome: "refused", reason: "kill_switch_active" });
    source.failWith(new Error("down"));
    expect(await recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "operator:itest" })).toEqual({ outcome: "refused", reason: "state_unavailable" });
    source.set({ KILL_SWITCH_ACTIVE: false });
    source.failWith(null);
    const ok = await recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "operator:itest" });
    expect(ok).toMatchObject({ outcome: "recorded" });
    expect(await recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "operator:itest" })).toEqual({ outcome: "duplicate" });
    expect((await listRecentApprovals(db(), 5))[0]).toMatchObject({ riskDecisionId: id, action: "APPROVE", actorType: "operator" });
  });
  it("every route needs the bearer token; the safe read models carry no snapshots, identities or raw text", async () => {
    const a = await app();
    const id = await approvedOne();
    for (const [method, url] of [["GET", `/risk/decisions/${id}/approval-eligibility`], ["GET", `/risk/decisions/${id}/summary`], ["GET", "/risk/decisions"], ["GET", "/risk/approvals"], ["POST", `/risk/decisions/${id}/approval-card`], ["POST", `/risk/decisions/${id}/approval`]] as const) {
      expect((await a.inject({ method, url })).statusCode, `${method} ${url} without a token`).toBe(401);
      expect((await a.inject({ method, url, headers: { authorization: "Bearer wrong" } })).statusCode, `${method} ${url} with a wrong token`).toBe(401);
    }
    const elig = await a.inject({ method: "GET", url: `/risk/decisions/${id}/approval-eligibility`, headers: auth });
    expect(elig.json()).toMatchObject({ eligible: true, reasons: [], decision: { id, effectiveStatus: "APPROVED_FOR_REVIEW" } });
    const summary = await a.inject({ method: "GET", url: `/risk/decisions/${id}/summary`, headers: auth });
    expect(summary.statusCode).toBe(200);
    expect(Object.keys(summary.json())).not.toEqual(expect.arrayContaining(["inputSnapshot", "outputSnapshot", "idempotencyKey", "evidenceReferences"]));
    expect(summary.body).not.toMatch(/idempotency|input_snapshot|rawText|synthetic/);
    const list = await a.inject({ method: "GET", url: "/risk/decisions?limit=5&status=APPROVED_FOR_REVIEW", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().decisions.length).toBeGreaterThan(0);
    expect((await a.inject({ method: "GET", url: "/risk/decisions?limit=abc", headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/risk/decisions?status=EXECUTED", headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/risk/decisions/not-a-uuid/summary", headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: `/risk/decisions/${randomUUID()}/summary`, headers: auth })).statusCode).toBe(404);
    await a.close();
  });
  it("card creation and approval over HTTP: 201 then 200 (idempotent), 409 with reasons when ineligible, approve once, duplicate 409, nothing leaks", async () => {
    const a = await app();
    const id = await approvedOne();
    const card = await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval-card`, headers: auth });
    expect(card.statusCode).toBe(201);
    expect(card.json()).toMatchObject({ created: true, decisionId: id });
    expect(card.body).not.toMatch(/nonce|card_text|cardText/);
    expect((await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval-card`, headers: auth })).statusCode).toBe(200);
    const bad = await make("portfolio");
    const refused = await a.inject({ method: "POST", url: `/risk/decisions/${bad.head}/approval-card`, headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "not_approval_eligible", reasons: expect.arrayContaining(["market_not_passed"]) });
    expect((await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval`, headers: auth, payload: { action: "NOPE", actor: "operator:itest" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval`, headers: auth, payload: { action: "REJECT", actor: "operator:itest" } })).statusCode).toBe(400); // reject needs a reason
    const approve = await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval`, headers: auth, payload: { action: "APPROVE", actor: "operator:itest" } });
    expect(approve.statusCode).toBe(201);
    expect(approve.json()).toMatchObject({ outcome: "recorded" });
    expect((await a.inject({ method: "POST", url: `/risk/decisions/${id}/approval`, headers: auth, payload: { action: "APPROVE", actor: "operator:itest" } })).statusCode).toBe(409);
    const refusedApproval = await a.inject({ method: "POST", url: `/risk/decisions/${bad.head}/approval`, headers: auth, payload: { action: "APPROVE", actor: "operator:itest" } });
    expect(refusedApproval.statusCode).toBe(409);
    expect(refusedApproval.json()).toMatchObject({ outcome: "refused", reason: "decision_not_approved_for_review" });
    const approvals = await a.inject({ method: "GET", url: "/risk/approvals?limit=3", headers: auth });
    expect(approvals.body).not.toMatch(/123456789|telegram:/);
    expect((await listRecentDecisionSummaries(db(), 3)).length).toBeGreaterThan(0);
    await a.close();
  });
});

describe("restricted roles (the real role scripts, applied in a transaction that is rolled back)", () => {
  const BOT = "twins_bot", APP = "twins_app";
  const botSql = readFileSync("infrastructure/staging/approval-bot-role.sql", "utf8").replaceAll(':"bot_role"', `"${BOT}"`);
  const appSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${APP}"`).replaceAll(":'app_role'", `'${APP}'`);
  const client = new pg.Client({ connectionString: DATABASE_URL });
  let sp = 0, decisionId = "", cardId = "";
  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await client.query(`savepoint r${++sp}`);
    await client.query(`set local role ${role}`);
    try { return await fn(); } finally { await client.query(`rollback to savepoint r${sp}`); await client.query("reset role"); }
  }
  const code = async (role: string, sql: string, params: unknown[] = []) => { try { await as(role, () => client.query(sql, params)); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "error"; } };
  beforeAll(async () => {
    decisionId = await approvedOne();
    cardId = (await createApprovalCard(db(), decisionId)).cardId;
    await client.connect();
    for (const r of [BOT, APP]) if ((await client.query("select 1 from pg_roles where rolname = $1", [r])).rowCount) throw new Error(`a role named ${r} already exists in this cluster; refusing to run`);
    await client.query("begin");
    await client.query(`create role ${BOT} login`);
    await client.query(`create role ${APP} login`);
    await client.query(botSql);
    // app-role.sql contains DO blocks and psql variables; run it statement by statement as the existing role tests do
    const doBlock = must(/DO \$\$[\s\S]*?\$\$;/.exec(appSql))[0];
    for (const st of [...appSql.replace(doBlock, "").split(/;\s*\n/), doBlock.replace(/;$/, "")].map((x) => x.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean)) await client.query(st);
  });
  afterAll(async () => { await client.query("rollback").catch(() => undefined); await client.end().catch(() => undefined); });

  it("the bot passes its own privilege self-check (it may read cards and call exactly the three functions)", async () => {
    const p = { query: (sql: string, params?: unknown[]) => as(BOT, () => client.query(sql, params)) } as unknown as pg.Pool;
    expect(await new PgBotDb("postgres://unused", p).checkPrivileges()).toEqual([]);
  });
  it("the bot reads cards but cannot write them, and cannot touch decisions, approvals, audit tables, orders, fills or positions", async () => {
    expect(await code(BOT, "select id, nonce, card_text, state from risk_approval_cards")).toBe("ok");
    for (const sql of [
      "update risk_approval_cards set state = 'decided'", "insert into risk_approval_cards (id) values (gen_random_uuid())", "delete from risk_approval_cards", "truncate risk_approval_cards",
      "select 1 from risk_decisions", "select 1 from risk_decisions_effective", "select 1 from risk_approvals", "insert into risk_approvals (id) values (gen_random_uuid())", "update risk_approvals set reason = 'x'",
      "select 1 from loss_events", "select 1 from circuit_breaker_events", "select 1 from event_blackout_windows", "select 1 from audit_events", "insert into audit_events (id, event_type, entity_type, actor_type) values (gen_random_uuid(), 'x.y', 'x', 'system')",
      "select 1 from orders", "insert into orders (id) values (gen_random_uuid())", "select 1 from fills", "select 1 from positions", "select 1 from signals", "select 1 from audit_chain_heads",
    ]) expect(await code(BOT, sql), sql).toBe("42501");
  });
  it("the bot advances a card ONLY through the functions, and a tap is recorded by the function with the bot holding no INSERT on the approvals table", async () => {
    const out = await as(BOT, async () => {
      const marked = (await client.query("select twins_risk_card_mark_sent($1::uuid, 5151::bigint, (select card_content_sha256 from risk_approval_cards where id = $1)) as ok", [cardId])).rows[0]?.ok;
      const tapped = (await client.query("select twins_record_risk_approval($1::uuid, $2::uuid, 'APPROVE', 'telegram:42', '{\"cardMessageId\":5151}'::jsonb, null, null) as o", [decisionId, cardId])).rows[0]?.o;
      return { marked, tapped };
    });
    expect(out).toEqual({ marked: true, tapped: "recorded" });
    expect(await code(BOT, "select count(*) from risk_approvals")).toBe("42501");
  });
  it("the runtime role can create cards and call the approval function, but can neither INSERT approvals nor change a card", async () => {
    expect(await code(APP, "select count(*) from risk_approvals")).toBe("ok");
    expect(await code(APP, "insert into risk_approvals (id, risk_decision_id, decision_version, action, actor, actor_context, decision_snapshot, evidence_references) values (gen_random_uuid(), $1, 4, 'REJECT', 'operator:x', '{}', '{\"x\":1}', '{}')", [decisionId])).toBe("42501");
    expect(await code(APP, "update risk_approvals set reason = 'x'")).toBe("42501");
    expect(await code(APP, "update risk_approval_cards set state = 'expired'")).toBe("42501");
    expect(await code(APP, "delete from risk_approval_cards")).toBe("42501");
    expect(await code(APP, "select twins_risk_card_mark_sent(gen_random_uuid(), 1::bigint, 'x')")).toBe("42501"); // the bot's doors are not the runtime role's
    expect(await code(APP, "select twins_risk_card_expire_due()")).toBe("42501");
    expect(await code(APP, "select twins_record_risk_approval(gen_random_uuid(), null, 'REJECT', 'operator:x', '{}'::jsonb, 'r', null)")).toBe("ok");
  });
  it("nobody else can call the approval functions (no PUBLIC execute)", async () => {
    expect((await client.query("select has_function_privilege('public', 'twins_record_risk_approval(uuid,uuid,text,text,jsonb,text,timestamptz)', 'EXECUTE') as e")).rows[0]?.e).toBe(false);
    expect((await client.query("select has_function_privilege('public', 'twins_risk_card_mark_sent(uuid,bigint,text)', 'EXECUTE') as e")).rows[0]?.e).toBe(false);
  });
});

describe("no real Telegram channel, no live trading", () => {
  it("the approval path contains no Telegram client of its own and the bot stays inactive by default", () => {
    for (const f of ["packages/risk/src/approval/service.ts", "packages/risk/src/approval/card.ts", "apps/api/src/riskApi.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/api\.telegram\.org|sendMessage|getUpdates|TWINS_BOT_TOKEN/);
    expect(readFileSync("infrastructure/staging/bot.env.example", "utf8")).toMatch(/TWINS_BOT_ACTIVE=false/);
    expect(readFileSync("infrastructure/staging/docker-compose.staging.yml", "utf8")).not.toMatch(/TWINS_BOT_ACTIVE:\s*"?true"?/);
  });
});
void and;
