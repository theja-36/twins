/**
 * Position sizing against REAL PostgreSQL (Stage 3 / Task 2): sizing is appended as a NEW, chained risk-decision version that cites the previous version and the
 * stop-loss evidence; nothing is updated, no order/decision/card/fill is written, and a decision without a SIZED size can never be approval-eligible.
 * Committed rows are append-only and use unique ids.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  createPendingRiskDecisionForSignal, createRiskDecision, DEFAULT_SIZING_CONFIG, getRiskDecision, listRiskDecisions, loadSizingConfig, RiskDecisionError, sizeLatestRiskDecisionForOptionsClaim,
  sizeLatestRiskDecisionForSignal, sizeRiskDecision, supersedeRiskDecision, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const CAPITAL = 1_000_000;

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

// ── fixtures ──
async function makeSignal(over: { instrumentType?: string; lotSize?: string | null; direction?: "buy" | "sell"; stop?: string; entry?: string } = {}) {
  const [instrument] = await db().insert(schema.instruments).values({ symbol: `SZ${sfx()}`.toUpperCase(), exchange: "NSE", instrumentType: over.instrumentType ?? "equity", lotSize: over.lotSize ?? null }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", instrumentId: must(instrument).id, parserVersion: "sz-test", direction: over.direction ?? "buy", entryPrice: over.entry ?? "100", stopLoss: over.stop ?? "95", targets: [110, 120, 130], signalTimestamp: new Date() }).returning();
  return { signal: must(signal), instrument: must(instrument) };
}
async function makeMessage(): Promise<string> {
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const [m] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: sfx(), messageTimestamp: new Date(), rawText: "SYNTHETIC sizing fixture", rawPayload: {} }).returning();
  return must(m).id;
}
async function makeClaim(verification: Record<string, unknown> | null) {
  const claim = { action: "BUY", underlying: "NIFTY", strike: 24500, optionType: "CE", expiry: { status: "full", day: 30, month: 12, year: 2031, raw: "30DEC2031" }, entry: { type: "at", price: 120 }, stopLoss: 90, targets: [150, 180], levelBasis: "premium" };
  const [row] = await db().insert(schema.optionsClaims).values({ telegramMessageId: await makeMessage(), parserVersion: `sz-${sfx()}`, resultKind: "claim", claim, assessmentOutcome: "INSUFFICIENT_EVIDENCE", reasons: [], verification, provenance: {}, approvalPossible: false }).returning();
  return must(row);
}
type Subject = { signalId?: string; optionsClaimId?: string };
async function evidence(subject: Subject, result: "VALID" | "INVALID" | "MISSING" | "AMBIGUOUS" = "VALID", extra: { stop?: string; entry?: string } = {}) {
  const valid = result === "VALID";
  const [row] = await db().insert(schema.stopLossValidations).values({
    subjectKind: subject.signalId ? "signal" : "options_claim", signalId: subject.signalId ?? null, optionsClaimId: subject.optionsClaimId ?? null, ruleVersion: "stop-loss-v1", result,
    reasonCode: valid ? null : result === "MISSING" ? "MISSING_STOP_LOSS" : "STOP_LOSS_WRONG_SIDE", levelBasis: "price",
    normalizedStopLoss: valid ? (extra.stop ?? "95") : null, entryPrice: valid ? (extra.entry ?? "100") : null, riskDistance: valid ? "5" : null, riskPct: valid ? "5" : null, maxRiskPct: "10",
  }).returning();
  return must(row);
}
/** A PENDING risk decision shaped like the one the worker creates (confidence as the 0-1 validation value, trust as the reliability label). */
function pending(subject: Subject, stopLossValidationId: string, over: Partial<RiskDecisionInput> & { confidence01?: number | null } = {}): RiskDecisionInput {
  const { confidence01, ...rest } = over;
  return {
    subject: subject.signalId ? { kind: "signal", signalId: subject.signalId } : { kind: "options_claim", optionsClaimId: must(subject.optionsClaimId) },
    stopLossValidationId, status: "PENDING", idempotencyKey: `sz-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol: "SYNTH", side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, target2: 120, target3: 130, sourceTrustTier: "HIGH",
    decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { synthetic: true, signalValidation: confidence01 === null ? null : { decisionConfidence: confidence01 ?? 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false }, evidenceReferences: { fixture: true }, ...rest,
  };
}
const err = async (p: Promise<unknown>): Promise<RiskDecisionError> => { try { await p; } catch (e) { return e as RiskDecisionError; } throw new Error("expected a RiskDecisionError"); };
const rowCount = async (t: string): Promise<number> => Number(must((await pool.query(`select count(*)::int as n from ${t}`)).rows[0])["n"]);
const raw = async (id: string) => must((await pool.query("select * from risk_decisions where id = $1", [id])).rows[0]);

describe("equity sizing creates a NEW versioned decision", () => {
  it("appends v2 (PENDING, planned fields, full snapshot, evidence link) superseding v1, which is untouched", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const before = await raw(v1.id);
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ created: true, decisionVersion: 2, status: "PENDING", sizingStatus: "SIZED", quantity: 2000, maxLossAmount: 10000 });
    const v2 = must(await getRiskDecision(db(), out.id));
    expect(v2).toMatchObject({ supersedesId: v1.id, decisionVersion: 2, status: "PENDING", createdBy: "service:position-sizing", stopLossValidationId: ev.id, decisionReasonCode: "sized_awaiting_limits", plannedRiskRewardRatio: "2" });
    expect(Number(v2.plannedQuantity)).toBe(2000);
    expect(Number(v2.plannedNotional)).toBe(200000);
    expect(Number(v2.plannedMaxLossAmount)).toBe(10000);
    expect(Number(v2.plannedMaxLossPercent)).toBe(1);
    expect(v2.outputSnapshot).toMatchObject({ stage: "position_sizing", sized: true, limitsApplied: false, sizing: { status: "SIZED", engineVersion: "sizing-v1", appliedTier: "HIGH" } });
    expect(v2.inputSnapshot).toMatchObject({ previousDecisionId: v1.id, previousVersion: 1, sizing: { input: { capital: CAPITAL, entryPrice: 100, stopLoss: 95, stopLossResult: "VALID" }, config: { maxRiskPct: 1 } }, base: { synthetic: true } });
    expect(v2.evidenceReferences).toMatchObject({ stopLossValidationId: ev.id, previousDecisionId: v1.id });
    // never mutated: the old row is byte-identical and only its derived state changed
    expect(await raw(v1.id)).toEqual(before);
    expect(must(await getRiskDecision(db(), v1.id))).toMatchObject({ effectiveStatus: "SUPERSEDED", supersededById: out.id });
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
  it("tiers change the stored size: medium confidence 0.6 and MODERATE trust", async () => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id, { confidence01: 0.6, sourceTrustTier: "HIGH" }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ sizingStatus: "SIZED", quantity: 1000, maxLossAmount: 5000 });
    expect(Number(must(await getRiskDecision(db(), out.id)).plannedMaxLossPercent)).toBe(0.5);
  });
  it("the sized values are stored as numbers the database accepts and the loss never exceeds the per-trade cap", async () => {
    const { signal } = await makeSignal({ stop: "97" });
    const ev = await evidence({ signalId: signal.id }, "VALID", { stop: "97" });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id, { stopLoss: 97 }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out.quantity).toBe(3333);
    expect(Number(must(await getRiskDecision(db(), out.id)).plannedMaxLossAmount)).toBeLessThanOrEqual(10000);
  });
});

describe("futures and options", () => {
  it("futures use the instrument's lot size as the contract multiplier", async () => {
    const { signal } = await makeSignal({ instrumentType: "future", lotSize: "10", entry: "1000", stop: "950" });
    const ev = await evidence({ signalId: signal.id }, "VALID", { stop: "950", entry: "1000" });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id, { instrumentType: "future", entryPrice: 1000, stopLoss: 950, target1: 1100 }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ sizingStatus: "SIZED", quantity: 20, maxLossAmount: 10000 });
    expect(Number(must(await getRiskDecision(db(), out.id)).plannedNotional)).toBe(200000);
  });
  it("a future with no lot size is REJECTED (INVALID_INPUT), not guessed", async () => {
    const { signal } = await makeSignal({ instrumentType: "future", lotSize: null });
    const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id, { instrumentType: "future" }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ sizingStatus: "INVALID_INPUT", status: "REJECTED", quantity: 0 });
    const v2 = must(await getRiskDecision(db(), out.id));
    expect([v2.plannedQuantity, v2.plannedNotional, v2.plannedMaxLossAmount]).toEqual([null, null, null]);
    expect(v2.decisionReasonCode).toBe("sizing_lot_size_invalid");
  });
  it("options use premium x the verified lot size from the claim's contract verification", async () => {
    const claim = await makeClaim({ status: "verified", contract: { lotSize: 25, expiryDate: "2031-12-30" } });
    const ev = await evidence({ optionsClaimId: claim.id }, "VALID", { stop: "90", entry: "120" });
    const v1 = await createRiskDecision(db(), pending({ optionsClaimId: claim.id }, ev.id, { instrumentType: "option", symbol: "NIFTY", entryPrice: 120, stopLoss: 90, target1: 150, strike: 24500, optionType: "CE", expiry: "2031-12-30", confidence01: 0.8 }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: 500_000 });
    expect(out).toMatchObject({ sizingStatus: "SIZED", quantity: 6, maxLossAmount: 4500 });
    expect(Number(must(await getRiskDecision(db(), out.id)).plannedNotional)).toBe(18000);
  });
  it("an option whose contract is NOT verified has no lot size and is not sized", async () => {
    const claim = await makeClaim({ status: "not_attempted", reason: "x" });
    const ev = await evidence({ optionsClaimId: claim.id }, "VALID", { stop: "90", entry: "120" });
    const v1 = await createRiskDecision(db(), pending({ optionsClaimId: claim.id }, ev.id, { instrumentType: "option", symbol: "NIFTY", entryPrice: 120, stopLoss: 90 }));
    expect(await sizeRiskDecision(db(), v1.id, { capital: 500_000 })).toMatchObject({ sizingStatus: "INVALID_INPUT", status: "REJECTED" });
  });
  it("one lot above the per-trade cap is REJECTED as RISK_LIMIT_EXCEEDED (never rounded up)", async () => {
    const claim = await makeClaim({ status: "verified", contract: { lotSize: 75 } });
    const ev = await evidence({ optionsClaimId: claim.id }, "VALID", { stop: "100", entry: "200" });
    const v1 = await createRiskDecision(db(), pending({ optionsClaimId: claim.id }, ev.id, { instrumentType: "option", symbol: "NIFTY", entryPrice: 200, stopLoss: 100 }));
    const out = await sizeRiskDecision(db(), v1.id, { capital: 500_000 });
    expect(out).toMatchObject({ sizingStatus: "RISK_LIMIT_EXCEEDED", status: "REJECTED", reasonCode: "min_lot_exceeds_risk_cap", quantity: 0 });
  });
});

describe("refusals are recorded, not sized", () => {
  it.each(["INVALID", "MISSING", "AMBIGUOUS"] as const)("%s stop-loss evidence -> REJECTED with the reason, no size", async (result) => {
    const { signal } = await makeSignal();
    const ev = await evidence({ signalId: signal.id }, result);
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ sizingStatus: "INVALID_INPUT", status: "REJECTED", reasonCode: "stop_loss_not_valid", quantity: 0 });
    expect(must(await getRiskDecision(db(), out.id)).plannedQuantity).toBeNull();
  });
  it("unknown confidence and unknown source trust are 0%: REJECTED, nothing sized", async () => {
    const a = await makeSignal(); const evA = await evidence({ signalId: a.signal.id });
    const unknownConfidence = await createRiskDecision(db(), pending({ signalId: a.signal.id }, evA.id, { confidence01: 0 }));
    expect(await sizeRiskDecision(db(), unknownConfidence.id, { capital: CAPITAL })).toMatchObject({ sizingStatus: "REJECTED", reasonCode: "confidence_unknown", quantity: 0 });
    const b = await makeSignal(); const evB = await evidence({ signalId: b.signal.id });
    const unknownTrust = await createRiskDecision(db(), pending({ signalId: b.signal.id }, evB.id, { sourceTrustTier: "UNKNOWN" }));
    expect(await sizeRiskDecision(db(), unknownTrust.id, { capital: CAPITAL })).toMatchObject({ sizingStatus: "REJECTED", reasonCode: "source_trust_unknown", quantity: 0 });
  });
  it("zero and negative capital -> INSUFFICIENT_CAPITAL", async () => {
    for (const capital of [0, -100]) {
      const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
      const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
      expect(await sizeRiskDecision(db(), v1.id, { capital })).toMatchObject({ sizingStatus: "INSUFFICIENT_CAPITAL", status: "REJECTED", quantity: 0 });
    }
  });
  it("capital below the minimum viable risk -> RISK_LIMIT_EXCEEDED", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    expect(await sizeRiskDecision(db(), v1.id, { capital: 400 })).toMatchObject({ sizingStatus: "RISK_LIMIT_EXCEEDED", status: "REJECTED" });
  });
  it("with no configured capital nothing is written (capital_not_configured / skipped)", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const before = await rowCount("risk_decisions");
    expect((await err(sizeRiskDecision(db(), v1.id, { config: DEFAULT_SIZING_CONFIG }))).code).toBe("capital_not_configured");
    expect(await sizeLatestRiskDecisionForSignal(db(), signal.id, { config: DEFAULT_SIZING_CONFIG })).toEqual({ skipped: "capital_not_configured" });
    expect(await rowCount("risk_decisions")).toBe(before);
  });
});

describe("idempotent and versioned recalculation", () => {
  it("the same inputs return the same version (nothing written), also in parallel", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const results = await Promise.all([1, 2, 3, 4].map(() => sizeRiskDecision(db(), v1.id, { capital: CAPITAL })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await listRiskDecisions(db(), { signalId: signal.id });
    expect(rows).toHaveLength(2);
    // sizing the CURRENT version again with unchanged inputs is a no-op
    const again = await sizeRiskDecision(db(), results[0]!.id, { capital: CAPITAL });
    expect(again).toMatchObject({ id: results[0]!.id, created: false, decisionVersion: 2 });
    expect(await listRiskDecisions(db(), { signalId: signal.id })).toHaveLength(2);
  });
  it("changed inputs (capital, configuration) append a new version that supersedes the previous sizing", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const v2 = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    const v3 = await sizeRiskDecision(db(), v2.id, { capital: 2_000_000 });
    expect(v3).toMatchObject({ created: true, decisionVersion: 3, quantity: 4000 });
    const v4 = await sizeRiskDecision(db(), v3.id, { capital: 2_000_000, config: loadSizingConfig({ TWINS_SIZING_MAX_RISK_PCT: "0.5" }) });
    expect(v4).toMatchObject({ decisionVersion: 4, quantity: 2000 });
    expect(must(await getRiskDecision(db(), v2.id)).effectiveStatus).toBe("SUPERSEDED");
    expect(must(await getRiskDecision(db(), v4.id))).toMatchObject({ supersedesId: v3.id, effectiveStatus: "PENDING" });
    // a REJECTED sizing can be recalculated once the inputs are fixed (capital was missing, now positive)
    const { signal: s2 } = await makeSignal(); const ev2 = await evidence({ signalId: s2.id });
    const w1 = await createRiskDecision(db(), pending({ signalId: s2.id }, ev2.id));
    const rejected = await sizeRiskDecision(db(), w1.id, { capital: 0 });
    expect(rejected.status).toBe("REJECTED");
    expect(await sizeRiskDecision(db(), rejected.id, { capital: CAPITAL })).toMatchObject({ decisionVersion: 3, sizingStatus: "SIZED", status: "PENDING" });
  });
  it("only the latest version of a PENDING (or sizing-rejected) decision can be sized", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect((await err(sizeRiskDecision(db(), v1.id, { capital: 2_000_000 }))).code).toBe("not_latest_version"); // different inputs against a superseded version
    expect(await sizeRiskDecision(db(), v1.id, { capital: CAPITAL })).toMatchObject({ created: false, decisionVersion: 2 }); // the same inputs: the existing sizing is returned
    expect((await err(sizeRiskDecision(db(), randomUUID(), { capital: CAPITAL }))).code).toBe("not_found");
    const { signal: s2 } = await makeSignal(); const ev2 = await evidence({ signalId: s2.id });
    const rejectedByOthers = await createRiskDecision(db(), pending({ signalId: s2.id }, ev2.id, { status: "REJECTED", createdBy: "service:other" }));
    expect((await err(sizeRiskDecision(db(), rejectedByOthers.id, { capital: CAPITAL }))).code).toBe("not_sizable");
    expect(await sizeLatestRiskDecisionForSignal(db(), s2.id, { capital: CAPITAL })).toEqual({ skipped: "already_sized_or_final" });
    expect(await sizeLatestRiskDecisionForSignal(db(), randomUUID(), { capital: CAPITAL })).toEqual({ skipped: "no_risk_decision" });
  });
  it("a newer stop-loss validation is the evidence the new version cites", async () => {
    const { signal } = await makeSignal();
    const old = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, old.id));
    const newer = await evidence({ signalId: signal.id }, "INVALID");
    const out = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    expect(out).toMatchObject({ sizingStatus: "INVALID_INPUT" });
    expect(must(await getRiskDecision(db(), out.id)).stopLossValidationId).toBe(newer.id);
  });
});

describe("a decision without a valid size can never be approval-eligible", () => {
  const approved = (subject: Subject, evId: string, over: Partial<RiskDecisionInput> = {}) => pending(subject, evId, { status: "APPROVED_FOR_REVIEW", createdBy: "operator:itest", ...over });
  it("APPROVED_FOR_REVIEW without planned values, or without a SIZED sizing snapshot, is refused by the database", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const sized = { plannedQuantity: 100, plannedNotional: 10000, plannedMaxLossAmount: 500, plannedMaxLossPercent: 0.5 };
    const attempts: Array<Partial<RiskDecisionInput>> = [
      {}, // nothing
      { ...sized }, // planned values but no sizing proof
      { ...sized, outputSnapshot: { sizing: { status: "REJECTED" } } },
      { plannedQuantity: 0, plannedNotional: 0, plannedMaxLossAmount: 0, plannedMaxLossPercent: 0, outputSnapshot: { sizing: { status: "SIZED" } } }, // zero size
      { ...sized, plannedMaxLossAmount: null, outputSnapshot: { sizing: { status: "SIZED" } } },
    ];
    for (const [i, a] of attempts.entries()) {
      const e = await err(supersedeRiskDecision(db(), v1.id, { ...approved({ signalId: signal.id }, ev.id, { idempotencyKey: `sz-approve:${randomUUID()}`, ...a }), subject: undefined } as never));
      expect(e, `attempt ${i}`).toBeInstanceOf(RiskDecisionError);
      expect(e.code).toBe("stop_loss_not_valid"); // mapped from the database check violation for an approval
    }
    expect(await listRiskDecisions(db(), { signalId: signal.id })).toHaveLength(1); // nothing was appended
    const rawInsert = pool.query(`insert into risk_decisions (id, signal_id, stop_loss_validation_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, input_snapshot, evidence_references, created_by, entry_price, stop_loss, stop_loss_basis) values (gen_random_uuid(), $1, $2, 1, 'APPROVED_FOR_REVIEW', $3, 'equity', 'X', 'raw_sql', '{"a":1}', '{"b":1}', 'service:raw', 100, 95, 'price')`, [(await makeSignal()).signal.id, ev.id, `sz-raw:${randomUUID()}`]);
    await expect(rawInsert).rejects.toThrow(/risk_decisions_sized_review_check|stop-loss|violates check|risk decision/i);
  });
  it("a SIZED decision with valid evidence CAN be approved for review (the structure for later stages), only as a new version", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const v2 = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL });
    const sized = must(await getRiskDecision(db(), v2.id));
    const out = await supersedeRiskDecision(db(), v2.id, {
      ...approved({ signalId: signal.id }, ev.id, { plannedQuantity: Number(sized.plannedQuantity), plannedNotional: Number(sized.plannedNotional), plannedMaxLossAmount: Number(sized.plannedMaxLossAmount), plannedMaxLossPercent: Number(sized.plannedMaxLossPercent), outputSnapshot: sized.outputSnapshot as Record<string, unknown> }),
      idempotencyKey: `sz-approve-ok:${randomUUID()}`,
    } as never);
    expect(out).toMatchObject({ created: true, decisionVersion: 3, status: "APPROVED_FOR_REVIEW" });
    expect((await err(sizeRiskDecision(db(), out.id, { capital: CAPITAL }))).code).toBe("not_sizable"); // an approval is never re-sized in place
  });
});

describe("runtime state is fail closed; nothing downstream is written", () => {
  it("kill switch, intake off and an unreadable state refuse, and no row is appended", async () => {
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    const v1 = await createRiskDecision(db(), pending({ signalId: signal.id }, ev.id));
    const before = await rowCount("risk_decisions");
    source.set({ KILL_SWITCH_ACTIVE: true });
    expect((await err(sizeRiskDecision(db(), v1.id, { capital: CAPITAL }))).code).toBe("safety_refused");
    source.set({ KILL_SWITCH_ACTIVE: false, INTAKE_ENABLED: false });
    expect((await err(sizeRiskDecision(db(), v1.id, { capital: CAPITAL }))).code).toBe("safety_refused");
    source.set({ INTAKE_ENABLED: true });
    source.failWith(new Error("state unreadable"));
    expect((await err(sizeRiskDecision(db(), v1.id, { capital: CAPITAL }))).code).toBe("safety_refused");
    expect(await rowCount("risk_decisions")).toBe(before);
  });
  it("sizing writes no order, fill, position, legacy decision or approval card; the hook sizes after the pending decision (no capital -> skipped)", async () => {
    const counts = async () => Promise.all(["orders", "fills", "positions", "decisions", "claim_review_cards"].map(rowCount));
    const before = await counts();
    const { signal } = await makeSignal(); const ev = await evidence({ signalId: signal.id });
    await createPendingRiskDecisionForSignal(db(), signal.id); // the worker's first step
    const sizedOut = await sizeLatestRiskDecisionForSignal(db(), signal.id, { capital: CAPITAL });
    expect(sizedOut).toMatchObject({ sizingStatus: "REJECTED", reasonCode: "confidence_unknown" }); // no signal validation row -> confidence unknown -> 0%
    const claim = await makeClaim({ status: "verified", contract: { lotSize: 25 } });
    await evidence({ optionsClaimId: claim.id }, "VALID", { stop: "90", entry: "120" });
    expect(await sizeLatestRiskDecisionForOptionsClaim(db(), claim.id, { capital: CAPITAL })).toEqual({ skipped: "no_risk_decision" });
    expect(await counts()).toEqual(before);
    void ev;
  });
  it("the whole chain still verifies after sizing", async () => {
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
});
