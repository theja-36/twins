/**
 * Risk decisions against REAL PostgreSQL (Stage 3 / Task 1): creation, evidence rules, idempotency, supersession, immutability, hash chain,
 * relationship integrity, runtime-state fail-closed behaviour, the orders guard and the "nothing else is written" boundaries.
 * Committed rows are append-only and use unique ids; destructive probes run in transactions that are always rolled back.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChains, verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  computeRiskReward, createPendingRiskDecisionForOptionsClaim, createPendingRiskDecisionForSignal, createRiskDecision, getLatestRiskDecisionForOptionsClaim, getLatestRiskDecisionForSignal,
  getRiskDecision, listRiskDecisions, RiskDecisionError, supersedeRiskDecision, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });
const db = () => handle.db;

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("set local lock_timeout = '5s'"); return await fn(c); } finally { await c.query("rollback").catch(() => undefined); c.release(); }
}

// ── fixtures ──
async function makeSignal(over: { stopLoss?: string | null; entry?: string | null } = {}) {
  const [instrument] = await db().insert(schema.instruments).values({ symbol: `RD${sfx()}`.toUpperCase(), exchange: "NSE", instrumentType: "equity" }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "rd-test", direction: "buy", entryPrice: over.entry ?? "100", stopLoss: over.stopLoss ?? "95", targets: [110, 120, 130], signalTimestamp: new Date() }).returning();
  return { signal: must(signal), instrument: must(instrument) };
}
async function makeClaim(claim: Record<string, unknown> | null = { action: "BUY", underlying: "NIFTY", strike: 24500, optionType: "CE", expiry: { status: "full", day: 30, month: 12, year: 2031, raw: "30DEC2031" }, entry: { type: "at", price: 120 }, stopLoss: 90, targets: [150, 180], levelBasis: "premium" }, resultKind = "claim") {
  const [row] = await db().insert(schema.optionsClaims).values({ telegramMessageId: await makeMessage(), parserVersion: `rd-${sfx()}`, resultKind, claim, assessmentOutcome: "INSUFFICIENT_EVIDENCE", reasons: [], provenance: {}, approvalPossible: false }).returning();
  return must(row);
}
async function makeMessage(): Promise<string> {
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const [m] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: sfx(), messageTimestamp: new Date(), rawText: "SYNTHETIC risk-decision fixture", rawPayload: {} }).returning();
  return must(m).id;
}
type Subject = { signalId?: string; optionsClaimId?: string };
async function evidence(subject: Subject, result: "VALID" | "INVALID" | "MISSING" | "AMBIGUOUS", extra: { stop?: string; entry?: string } = {}) {
  const valid = result === "VALID";
  const [row] = await db().insert(schema.stopLossValidations).values({
    subjectKind: subject.signalId ? "signal" : "options_claim", signalId: subject.signalId ?? null, optionsClaimId: subject.optionsClaimId ?? null, ruleVersion: "stop-loss-v1", result,
    reasonCode: valid ? null : result === "MISSING" ? "MISSING_STOP_LOSS" : "STOP_LOSS_WRONG_SIDE", levelBasis: "price",
    normalizedStopLoss: valid ? (extra.stop ?? "95") : null, entryPrice: valid ? (extra.entry ?? "100") : null, riskDistance: valid ? "5" : null, riskPct: valid ? "5" : null, maxRiskPct: "10",
  }).returning();
  return must(row);
}
function input(subject: Subject, stopLossValidationId: string, over: Partial<RiskDecisionInput> = {}): RiskDecisionInput {
  return {
    subject: subject.signalId ? { kind: "signal", signalId: subject.signalId } : { kind: "options_claim", optionsClaimId: must(subject.optionsClaimId) },
    stopLossValidationId, status: "PENDING", idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "service:risk-test", instrumentType: "equity", market: "NSE", symbol: "SYNTH", side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, target2: 120, target3: 130, confidenceScore: 61.5, sourceTrustTier: "MODERATE",
    decisionReasonCode: "awaiting_risk_gates", decisionReason: "synthetic", inputSnapshot: { synthetic: true, signal: "fixture" }, outputSnapshot: { stage: "test" }, evidenceReferences: { fixture: true }, ...over,
  };
}
/** What a SIZED position size looks like on a row (Stage 3 / Task 2: the database refuses APPROVED_FOR_REVIEW without it). */
const SIZED = { plannedQuantity: 100, plannedNotional: 10000, plannedMaxLossAmount: 500, plannedMaxLossPercent: 0.5, outputSnapshot: { sizing: { status: "SIZED" } } };
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);

describe("creating a risk decision", () => {
  it("stores a complete, hash-chained PENDING decision linked to the signal and its stop-loss evidence", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const out = await createRiskDecision(db(), input({ signalId: signal.id }, ev.id));
    expect(out).toMatchObject({ created: true, decisionVersion: 1, status: "PENDING" });
    const d = must(await getRiskDecision(db(), out.id));
    expect(d).toMatchObject({ signalId: signal.id, optionsClaimId: null, stopLossValidationId: ev.id, decisionVersion: 1, status: "PENDING", effectiveStatus: "PENDING", supersedesId: null, supersededById: null, supersededAt: null, instrumentType: "equity", market: "NSE", side: "BUY", createdBy: "service:risk-test" });
    expect(d.plannedQuantity).toBeNull(); // no sizing yet
    expect(d.plannedNotional).toBeNull();
    expect(d.plannedMaxLossAmount).toBeNull();
    expect(Number(d.entryPrice)).toBe(100);
    expect(Number(d.stopLoss)).toBe(95);
    expect(Number(d.plannedRiskRewardRatio ?? 0)).toBeCloseTo(2, 6); // |110-100| / |100-95|
    expect(d.evidenceReferences).toMatchObject({ fixture: true, stopLossValidationId: ev.id, stopLossResult: "VALID" });
    expect(d.inputSnapshot).toEqual({ synthetic: true, signal: "fixture" });
    expect(d.chainIndex).toBeGreaterThan(0);
    const raw = must((await pool.query("select previous_hash, payload_hash, event_hash from risk_decisions where id = $1", [out.id])).rows[0]);
    for (const k of ["previous_hash", "payload_hash", "event_hash"]) expect(raw[k]).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
  it("works the same for an options claim subject", async () => {
    const claim = await makeClaim();
    const ev = await evidence({ optionsClaimId: claim.id }, "VALID", { stop: "90", entry: "120" });
    const out = await createRiskDecision(db(), input({ optionsClaimId: claim.id }, ev.id, { instrumentType: "option", symbol: "NIFTY", entryPrice: 120, stopLoss: 90, expiry: "2031-12-30", strike: 24500, optionType: "CE" }));
    expect(out.created).toBe(true);
    expect(must(await getLatestRiskDecisionForOptionsClaim(db(), claim.id))).toMatchObject({ id: out.id, optionsClaimId: claim.id, signalId: null, expiry: "2031-12-30", optionType: "CE" });
  });
  it("computes reward-to-risk only when entry, stop and the first target are known", () => {
    expect(computeRiskReward(100, 95, 110)).toBe(2);
    expect(computeRiskReward(100, 95, null)).toBeNull();
    expect(computeRiskReward(100, 100, 110)).toBeNull();
    expect(computeRiskReward(null, 95, 110)).toBeNull();
  });
});

describe("stop-loss evidence rules", () => {
  it("missing evidence: a decision cannot be created (no row)", async () => {
    const { signal } = await makeSignal();
    const before = await rowCount("risk_decisions");
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, randomUUID())))).code).toBe("stop_loss_evidence_missing");
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("evidence that belongs to another subject is refused", async () => {
    const a = await makeSignal(); const b = await makeSignal();
    const evB = await evidence({ signalId: b.signal.id }, "VALID");
    expect((await err(createRiskDecision(db(), input({ signalId: a.signal.id }, evB.id)))).code).toBe("stop_loss_subject_mismatch");
    // and the database refuses it too, whatever the application says
    await expect(pool.query(`insert into risk_decisions (id, signal_id, stop_loss_validation_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by) values (gen_random_uuid(), $1, $2, 1, 'PENDING', $3, 'equity', 'X', 'raw_sql', '{"a":1}', '{}', 'service:raw')`, [a.signal.id, evB.id, `raw-${randomUUID()}`])).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["INVALID", "MISSING", "AMBIGUOUS"] as const)("a %s stop-loss validation can be recorded as PENDING/REJECTED but NEVER as APPROVED_FOR_REVIEW (service and database)", async (result) => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, result);
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id, { status: "APPROVED_FOR_REVIEW" })))).code).toBe("stop_loss_not_valid");
    await expect(pool.query(`insert into risk_decisions (id, signal_id, stop_loss_validation_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by, entry_price, stop_loss, stop_loss_basis) values (gen_random_uuid(), $1, $2, 1, 'APPROVED_FOR_REVIEW', $3, 'equity', 'X', 'raw_sql', '{"a":1}', '{}', 'service:raw', 100, 95, 'price')`, [signal.id, ev.id, `raw-${randomUUID()}`])).rejects.toThrow(/APPROVED_FOR_REVIEW requires a VALID stop-loss validation/);
    const pending = await createRiskDecision(db(), input({ signalId: signal.id }, ev.id, { stopLoss: null, entryPrice: null, decisionReasonCode: `stop_loss_${result.toLowerCase()}` }));
    expect(pending.created).toBe(true);
    const rejected = await supersedeRiskDecision(db(), pending.id, { stopLossValidationId: ev.id, status: "REJECTED", idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "service:risk-test", instrumentType: "equity", symbol: "SYNTH", decisionReasonCode: "stop_loss_not_valid", inputSnapshot: { synthetic: true } });
    expect(rejected).toMatchObject({ created: true, decisionVersion: 2, status: "REJECTED" });
  });
  it("APPROVED_FOR_REVIEW needs VALID evidence that is the LATEST for the subject and values equal to the validated ones", async () => {
    const { signal } = await makeSignal();
    const old = await evidence({ signalId: signal.id }, "VALID");
    const newer = await evidence({ signalId: signal.id }, "INVALID"); // a later validation supersedes the earlier VALID one
    expect(newer.id).not.toBe(old.id);
    await expect(createRiskDecision(db(), input({ signalId: signal.id }, old.id, { status: "APPROVED_FOR_REVIEW" }))).rejects.toMatchObject({ code: "stop_loss_not_valid" }); // not the latest
    const { signal: s2 } = await makeSignal();
    const ev = await evidence({ signalId: s2.id }, "VALID");
    await expect(createRiskDecision(db(), input({ signalId: s2.id }, ev.id, { status: "APPROVED_FOR_REVIEW", stopLoss: 94 }))).rejects.toMatchObject({ code: "stop_loss_not_valid" }); // differs from the validated stop
    const ok = await createRiskDecision(db(), input({ signalId: s2.id }, ev.id, { status: "APPROVED_FOR_REVIEW", ...SIZED }));
    expect(ok).toMatchObject({ created: true, status: "APPROVED_FOR_REVIEW" });
  });
  it("an APPROVED_FOR_REVIEW decision also needs a stop-loss, entry price and basis in the row itself (check constraint)", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id, { status: "APPROVED_FOR_REVIEW", stopLoss: null })))).code).toBe("stop_loss_not_valid");
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id, { status: "APPROVED_FOR_REVIEW", stopLossBasis: null })))).code).toBe("stop_loss_not_valid");
  });
});

describe("duplicates and idempotency", () => {
  it("the same idempotency key returns the same decision; the same key for a different decision is a conflict; a second first-version for the subject must be a revision", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const base = input({ signalId: signal.id }, ev.id);
    const first = await createRiskDecision(db(), base);
    const again = await createRiskDecision(db(), base);
    expect(again).toMatchObject({ id: first.id, created: false });
    const parallel = await Promise.all([createRiskDecision(db(), base), createRiskDecision(db(), base), createRiskDecision(db(), base)]);
    expect(new Set(parallel.map((p) => p.id))).toEqual(new Set([first.id]));
    expect((await err(createRiskDecision(db(), { ...base, status: "REJECTED" }))).code).toBe("idempotency_conflict");
    const other = await err(createRiskDecision(db(), { ...base, idempotencyKey: `rd-test:${randomUUID()}` }));
    expect(other).toMatchObject({ code: "decision_exists", existingId: first.id });
    expect(await listRiskDecisions(db(), { signalId: signal.id })).toHaveLength(1);
  });
  it("the worker hooks are idempotent per subject (a retried job adds nothing)", async () => {
    const { signal } = await makeSignal();
    await evidence({ signalId: signal.id }, "VALID");
    const a = await createPendingRiskDecisionForSignal(db(), signal.id);
    const b = await createPendingRiskDecisionForSignal(db(), signal.id);
    expect(a).toMatchObject({ created: true, status: "PENDING" });
    expect(b).toMatchObject({ created: false });
    expect((a as { id: string }).id).toBe((b as { id: string }).id);
  });
});

describe("supersession (revisions without mutation)", () => {
  it("a revision is a new row; the old one is derived SUPERSEDED, byte-for-byte unchanged; only the latest can be superseded", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const v1 = await createRiskDecision(db(), input({ signalId: signal.id }, ev.id));
    const before = must((await pool.query("select event_hash, payload_hash, status from risk_decisions where id = $1", [v1.id])).rows[0]);
    const rev = await supersedeRiskDecision(db(), v1.id, { stopLossValidationId: ev.id, status: "APPROVED_FOR_REVIEW", ...SIZED, idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "operator:itest", instrumentType: "equity", symbol: "SYNTH", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 112, decisionReasonCode: "review_ready", inputSnapshot: { synthetic: true, revision: 2 } });
    expect(rev).toMatchObject({ created: true, decisionVersion: 2, status: "APPROVED_FOR_REVIEW" });
    const old = must(await getRiskDecision(db(), v1.id));
    expect(old).toMatchObject({ status: "PENDING", effectiveStatus: "SUPERSEDED", supersededById: rev.id });
    expect(old.supersededAt).toBeInstanceOf(Date);
    expect(must((await pool.query("select event_hash, payload_hash, status from risk_decisions where id = $1", [v1.id])).rows[0])).toEqual(before); // the stored row never changed
    expect(must(await getLatestRiskDecisionForSignal(db(), signal.id))).toMatchObject({ id: rev.id, decisionVersion: 2, supersedesId: v1.id, effectiveStatus: "APPROVED_FOR_REVIEW" });
    expect((await err(supersedeRiskDecision(db(), v1.id, { stopLossValidationId: ev.id, status: "REJECTED", idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "service:risk-test", instrumentType: "equity", symbol: "SYNTH", decisionReasonCode: "late_revision", inputSnapshot: { x: 1 } }))).code).toBe("not_latest_version");
    expect((await err(supersedeRiskDecision(db(), randomUUID(), { stopLossValidationId: ev.id, status: "REJECTED", idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "service:risk-test", instrumentType: "equity", symbol: "S", decisionReasonCode: "x_missing", inputSnapshot: { x: 1 } }))).code).toBe("not_found");
    expect((await listRiskDecisions(db(), { signalId: signal.id, status: "SUPERSEDED" })).map((r) => r.id)).toEqual([v1.id]);
    // the database enforces the version chain on raw SQL too: wrong version number, other subject, and a second successor are refused
    const other = await makeSignal(); const evO = await evidence({ signalId: other.signal.id }, "VALID");
    const ins = (supersedes: string, version: number, signalId: string, evId: string) => pool.query(`insert into risk_decisions (id, signal_id, stop_loss_validation_id, supersedes_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by) values (gen_random_uuid(), $1, $2, $3, $4, 'PENDING', $5, 'equity', 'X', 'raw_sql', '{"a":1}', '{}', 'service:raw')`, [signalId, evId, supersedes, version, `raw-${randomUUID()}`]);
    await expect(ins(rev.id, 5, signal.id, ev.id)).rejects.toThrow(/decision_version must be the predecessor/);
    await expect(ins(rev.id, 3, other.signal.id, evO.id)).rejects.toThrow(/same signal or options claim/);
    await expect(ins(v1.id, 2, signal.id, ev.id)).rejects.toMatchObject({ code: "23505" }); // a second successor of v1
  });
});

describe("immutability and tamper evidence", () => {
  it("UPDATE, DELETE and TRUNCATE are rejected (restrict_violation), even for the owner and with replica triggers", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const d = await createRiskDecision(db(), input({ signalId: signal.id }, ev.id));
    await expect(pool.query("update risk_decisions set decision_reason = 'edited' where id = $1", [d.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("update risk_decisions set status = 'REJECTED' where id = $1", [d.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("delete from risk_decisions where id = $1", [d.id])).rejects.toMatchObject({ code: "23001" });
    await inTx(async (c) => {
      await c.query("set local session_replication_role = replica");
      await expect(c.query("update risk_decisions set decision_reason = 'edited' where id = $1", [d.id])).rejects.toMatchObject({ code: "23001" });
    });
    // Postgres itself refuses to truncate a table that other tables reference (0A000) before the guard trigger is reached; with CASCADE the trigger answers (23001). Either way: rejected.
    await inTx(async (c) => { await expect(c.query("truncate risk_decisions")).rejects.toMatchObject({ code: expect.stringMatching(/^(23001|0A000)$/) }); });
    await inTx(async (c) => { await expect(c.query("truncate risk_decisions cascade")).rejects.toMatchObject({ code: "23001" }); });
    expect(must(await getRiskDecision(db(), d.id)).decisionReason).toBe("synthetic");
  });
  it("the hash chain verifies, and tampering (content edit, deleted row) is detected at the first bad row", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    await createRiskDecision(db(), input({ signalId: signal.id }, ev.id));
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
    const tamper = async (edit: (c: pg.PoolClient) => Promise<void>) => inTx(async (c) => {
      await c.query("alter table risk_decisions disable trigger risk_decisions_no_update_delete");
      await edit(c);
      await c.query("alter table risk_decisions enable always trigger risk_decisions_no_update_delete");
      return verifyAuditChains(c, { chains: ["risk_decisions"] });
    });
    const edited = await tamper(async (c) => void (await c.query("update risk_decisions set stop_loss = stop_loss - 1 where chain_index = (select max(chain_index) from risk_decisions)")));
    expect(edited.ok).toBe(false);
    expect(edited.firstFailure?.code).toBe("payload_modified");
    const removed = await tamper(async (c) => void (await c.query("delete from risk_decisions where chain_index = (select max(chain_index) from risk_decisions)")));
    expect(removed.ok).toBe(false);
    expect(["head_mismatch", "missing_rows"]).toContain(removed.firstFailure?.code);
  });
  it("the database refuses the stored status SUPERSEDED, a stored-legacy column, and malformed shapes", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const raw = (cols: string, vals: string, params: unknown[]) => pool.query(`insert into risk_decisions (id, signal_id, stop_loss_validation_id, decision_version, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by, ${cols}) values (gen_random_uuid(), $1, $2, 1, $3, 'equity', 'X', 'raw_sql', '{"a":1}', '{}', 'service:raw', ${vals})`, [signal.id, ev.id, `raw-${randomUUID()}`, ...params]);
    await expect(raw("status", "'SUPERSEDED'", [])).rejects.toThrow(/SUPERSEDED is derived/);
    await expect(raw("status", "'EXECUTED'", [])).rejects.toMatchObject({ code: "23514" }); // no execution states exist
    await expect(raw("status, approved", "'PENDING', true", [])).rejects.toMatchObject({ code: "23514" }); // deprecated legacy column must stay NULL
    await expect(raw("status, stop_loss", "'PENDING', -1", [])).rejects.toMatchObject({ code: "23514" });
    await expect(raw("status, created_by", "'PENDING', 'someone'", [])).rejects.toBeDefined();
  });
});

describe("relationship integrity", () => {
  it("a decision must reference exactly one existing subject", async () => {
    const { signal } = await makeSignal(); const claim = await makeClaim();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const raw = (signalId: string | null, claimId: string | null) => pool.query(`insert into risk_decisions (id, signal_id, options_claim_id, stop_loss_validation_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by) values (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', $4, 'equity', 'X', 'raw_sql', '{"a":1}', '{}', 'service:raw')`, [signalId, claimId, ev.id, `raw-${randomUUID()}`]);
    await expect(raw(null, null)).rejects.toMatchObject({ code: "23514" });
    await expect(raw(signal.id, claim.id)).rejects.toMatchObject({ code: "23514" });
    // (the integrity trigger answers first with 23514 because the evidence belongs to another subject; without it the foreign key answers 23503: either way it is refused)
    await expect(raw(randomUUID(), null)).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23514)$/) });
    await expect(raw(null, randomUUID())).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23514)$/) });
    // referenced rows cannot disappear (restrict) - and they are append-only anyway
    await expect(pool.query("delete from stop_loss_validations where id = $1", [ev.id])).rejects.toBeDefined();
  });
  it("orders: NO order can be created without a risk decision that is currently APPROVED_FOR_REVIEW and not superseded", async () => {
    const ordersBefore = await rowCount("orders");
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const pending = await createRiskDecision(db(), input({ signalId: signal.id }, ev.id));
    const tryOrder = (riskId: string | null) => inTx(async (c) => c.query(`insert into orders (id, account_id, instrument_id, risk_decision_id, trading_mode, side, order_type, quantity, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, 'paper', 'buy', 'limit', 1, $2)`, [riskId, `ord-${randomUUID()}`]).then(() => "inserted", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`));
    expect(await tryOrder(null)).toMatch(/23514:orders: an order requires a risk decision/);
    expect(await tryOrder(randomUUID())).toMatch(/orders: the risk decision must be APPROVED_FOR_REVIEW and not superseded \(is missing\)/);
    expect(await tryOrder(pending.id)).toMatch(/\(is PENDING\)/);
    const approved = await supersedeRiskDecision(db(), pending.id, { stopLossValidationId: ev.id, status: "APPROVED_FOR_REVIEW", ...SIZED, idempotencyKey: `rd-test:${randomUUID()}`, createdBy: "service:risk-test", instrumentType: "equity", symbol: "SYNTH", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", decisionReasonCode: "review_ready", inputSnapshot: { x: 1 } });
    expect(await tryOrder(pending.id)).toMatch(/\(is SUPERSEDED\)/);
    // an approved, un-superseded decision passes the risk-decision guard; the insert then fails on the NEXT rule (the fake account is not a real FK), proving the guard is not the blocker
    const outcome = await tryOrder(approved.id);
    expect(outcome).not.toMatch(/orders: /);
    expect(outcome).toMatch(/^23503|^23502/);
    expect(await rowCount("orders")).toBe(ordersBefore); // no order was created by any of the attempts
  });
});

describe("runtime-state behaviour (fail closed)", () => {
  it("kill switch, disabled intake and an unreadable state refuse the creation BEFORE anything is written", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const before = await rowCount("risk_decisions");
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id)))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false, INTAKE_ENABLED: false });
    expect((await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id)))).code).toBe("safety_refused");
    source.set({ INTAKE_ENABLED: true });
    source.failWith(new Error("database unreachable"));
    const e = await err(createRiskDecision(db(), input({ signalId: signal.id }, ev.id)));
    expect(e.code).toBe("safety_refused");
    expect(e.message).not.toMatch(/unreachable/);
    expect(await rowCount("risk_decisions")).toBe(before);
    source.failWith(null);
    expect((await createRiskDecision(db(), input({ signalId: signal.id }, ev.id))).created).toBe(true); // and works again once the state is healthy
  });
  it("a database failure while checking the evidence is a store_failure, never a silent success", async () => {
    const broken = new Proxy(db(), { get: (t, p, r) => (p === "execute" ? () => Promise.reject(new Error("connection reset")) : Reflect.get(t, p, r)) }) as typeof handle.db;
    expect((await err(createRiskDecision(broken, input({ signalId: randomUUID() }, randomUUID())))).code).toBe("store_failure");
  });
});

describe("integration with the validation flow, and what it must NOT do", () => {
  it("creates a PENDING decision for a validated signal and for a recorded options claim; skips subjects without stop-loss evidence; skips incomplete claims", async () => {
    const decisionsBefore = await rowCount("decisions");
    const ordersBefore = await rowCount("orders");
    const cardsBefore = await rowCount("claim_review_cards");
    const { signal } = await makeSignal();
    expect(await createPendingRiskDecisionForSignal(db(), signal.id)).toEqual({ skipped: "no_stop_loss_evidence" });
    const ev = await evidence({ signalId: signal.id }, "VALID");
    const s = await createPendingRiskDecisionForSignal(db(), signal.id);
    const sid = (s as { id: string }).id;
    const rec = must(await getRiskDecision(db(), sid));
    expect(rec).toMatchObject({ status: "PENDING", stopLossValidationId: ev.id, decisionReasonCode: "awaiting_risk_gates", symbol: expect.stringMatching(/^RD/), side: "BUY", market: "NSE" });
    expect(rec.inputSnapshot).toMatchObject({ subject: "signal", signal: { id: signal.id }, stopLossValidation: { id: ev.id, result: "VALID" } });
    expect(Number(rec.target1)).toBe(110);

    const claim = await makeClaim();
    const none = await createPendingRiskDecisionForOptionsClaim(db(), claim.id);
    expect(none).toEqual({ skipped: "no_stop_loss_evidence" });
    const evc = await evidence({ optionsClaimId: claim.id }, "MISSING");
    const c = await createPendingRiskDecisionForOptionsClaim(db(), claim.id);
    expect(must(await getRiskDecision(db(), (c as { id: string }).id))).toMatchObject({ status: "PENDING", optionsClaimId: claim.id, stopLossValidationId: evc.id, decisionReasonCode: "stop_loss_missing", instrumentType: "option", symbol: "NIFTY", expiry: "2031-12-30", strike: "24500", optionType: "CE", side: "BUY" });
    const ambiguous = await makeClaim(null, "ambiguous");
    expect(await createPendingRiskDecisionForOptionsClaim(db(), ambiguous.id)).toEqual({ skipped: "not_a_complete_claim" });
    expect(await createPendingRiskDecisionForSignal(db(), randomUUID())).toEqual({ skipped: "subject_not_found" });

    // nothing else moved: no decisions row, no order, no approval card
    expect(await rowCount("decisions")).toBe(decisionsBefore);
    expect(await rowCount("orders")).toBe(ordersBefore);
    expect(await rowCount("claim_review_cards")).toBe(cardsBefore);
    expect(Number(must((await db().execute(sql`select count(*)::int as n from risk_decisions where created_by = 'service:risk-decision' and status <> 'PENDING'`)).rows[0] as Record<string, unknown>)["n"])).toBe(0);
    void eq;
  });
});
