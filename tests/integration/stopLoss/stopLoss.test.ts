/**
 * Mandatory stop-loss invariant against REAL PostgreSQL (Stage 1 / Task 4): the evidence table, the signal_validations APPROVE trigger, the real
 * validation / options-claim flows, the eligibility view for historical rows and the API field. Destructive probes run in transactions that are
 * always rolled back; the real-flow tests append committed rows (the audit tables are append-only) with unique ids.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { validateSignal } from "../../../packages/decision-intelligence/src/index";
import { decide } from "../../../packages/decision-intelligence/src/decide";
import { persistDecisionIntelligence } from "../../../packages/decision-intelligence/src/persist";
import { assessOptionsClaim, getValidationEligibility, recordOptionsIntake } from "../../../packages/signals/src/index";
import { analyzeOptionsText } from "../../../packages/signals/src/options/parse";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { StopLossInvariantError, validateStopLoss } from "../../../packages/stop-loss/src/index";
import { buildApp } from "../../support/apiWithTestPolicy";
import { fixtureQuality, fixtureReport } from "../../unit/decision-intelligence/fixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { TEST_API_KEY, TEST_WEBHOOK_SECRET, must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
const sfx = () => randomUUID().slice(0, 8);

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 });
});
afterAll(async () => {
  await handle?.close();
  await pool.end();
});

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const errCode = async (c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string> => {
  await c.query("savepoint p");
  try {
    await c.query(sql, params);
    await c.query("release savepoint p");
    return "ok";
  } catch (e) {
    await c.query("rollback to savepoint p");
    return (e as { code?: string }).code ?? "error";
  }
};

/** A signal (with its message, source and instrument) inside the transaction. */
async function signalIn(c: pg.PoolClient, over: { entry?: string | null; stop?: string | null; direction?: string } = {}): Promise<string> {
  const s = sfx();
  const source = randomUUID();
  const message = randomUUID();
  const instrument = randomUUID();
  const signal = randomUUID();
  await c.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [source, `tg_chat_-100${Date.now()}${s}`]);
  await c.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text) values ($1, $2, '1', now(), $3)", [message, source, `BUY X ${s}`]);
  await c.query("insert into instruments (id, symbol, exchange, instrument_type) values ($1, $2, 'NSE', 'equity')", [instrument, `S${s}`.toUpperCase()]);
  await c.query("insert into signals (id, source_type, telegram_message_id, instrument_id, parser_version, direction, entry_price, stop_loss, signal_timestamp) values ($1, 'telegram', $2, $3, 'itest-sl', $4, $5, $6, now())", [signal, message, instrument, over.direction ?? "buy", over.entry === undefined ? "100" : over.entry, over.stop === undefined ? "95" : over.stop]);
  return signal;
}
const evidence = (c: pg.PoolClient, signalId: string, result: "VALID" | "INVALID" | "MISSING" | "AMBIGUOUS", reason: string | null = result === "VALID" ? null : "MISSING_STOP_LOSS") =>
  c.query(
    `insert into stop_loss_validations (id, subject_kind, signal_id, rule_version, result, reason_code, instrument_type, instrument_kind, side, original_stop_loss, normalized_stop_loss, entry_price, risk_distance, risk_pct, max_risk_pct, max_risk_source, expected_stop_side)
     values ($1, 'signal', $2, 'stop-loss-v1', $3, $4, 'equity', 'equity', 'buy', ${result === "VALID" ? "'95', 95, 100, 5, 5, 10, 'default', 'below'" : "null, null, null, null, null, 10, 'default', null"})`,
    [randomUUID(), signalId, result, reason],
  );
const verdict = (c: pg.PoolClient, signalId: string, outcome: string) =>
  `insert into signal_validations (id, signal_id, outcome, decision_confidence, confidence_label, bull_thesis, bear_thesis, counter_thesis, counter_thesis_severity, source_reliability, source_reliability_reason, rationale) values ('${randomUUID()}', '${signalId}', '${outcome}', 0.5, 'l', '{}', '{}', '{}', 'low', 'UNKNOWN', 'n', 'itest ${c ? "" : ""}')`;

describe("database invariant: signal_validations cannot record an APPROVE without a VALID stop-loss validation of the same signal", () => {
  it("APPROVE without any evidence is refused (check_violation 23514)", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("23514");
    });
  });
  it.each([
    ["MISSING", "MISSING_STOP_LOSS"],
    ["INVALID", "STOP_LOSS_DIRECTION_INVALID"],
    ["AMBIGUOUS", "STOP_LOSS_REFERENCE_MISSING"],
  ] as const)("APPROVE after a %s stop-loss validation is refused", async (result, reason) => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      await evidence(c, signal, result, reason);
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("23514");
    });
  });
  it("APPROVE after a VALID validation is accepted; a later non-valid validation takes it away again (the latest decides); other signals' evidence does not count", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      const other = await signalIn(c);
      await evidence(c, other, "VALID");
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("23514"); // somebody else's evidence is irrelevant
      await evidence(c, signal, "VALID");
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("ok");
      await evidence(c, signal, "INVALID", "STOP_LOSS_TOO_FAR"); // the stop-loss was later found invalid (e.g. a revision)
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("23514");
    });
  });
  it("non-approval verdicts need no evidence, and the guard also holds with session_replication_role = replica", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      for (const outcome of ["REJECT", "INSUFFICIENT_EVIDENCE"]) expect(await errCode(c, verdict(c, signal, outcome))).toBe("ok");
      await c.query("set local session_replication_role = replica");
      expect(await errCode(c, verdict(c, signal, "APPROVE"))).toBe("23514");
    });
  });
  it("the evidence table's own constraints: VALID has no reason, non-VALID has one, exactly one subject, VALID needs a positive stop, entry and distance", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      const base = "insert into stop_loss_validations (id, subject_kind, signal_id, options_claim_id, rule_version, result, reason_code, normalized_stop_loss, entry_price, risk_distance) values ($1, $2, $3, $4, 'stop-loss-v1', $5, $6, $7, $8, $9)";
      const args = (over: unknown[]) => [randomUUID(), "signal", signal, null, "VALID", null, 95, 100, 5, ...[]].map((v, i) => (over[i] !== undefined ? over[i] : v));
      expect(await errCode(c, base, args([]))).toBe("ok");
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, undefined, "MISSING_STOP_LOSS"]))).toBe("23514"); // VALID with a reason
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, "MISSING", null]))).toBe("23514"); // non-VALID without one
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, "BOGUS", "X"]))).toBe("23514");
      expect(await errCode(c, base, args([undefined, "options_claim"]))).toBe("23514"); // subject kind says claim but only a signal is set
      expect(await errCode(c, base, args([undefined, undefined, undefined, randomUUID()]))).toBe("23514"); // two subjects
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, undefined, undefined, 0]))).toBe("23514"); // zero stop
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, undefined, undefined, -1]))).toBe("23514");
      expect(await errCode(c, base, args([undefined, undefined, undefined, undefined, undefined, undefined, undefined, null]))).toBe("23514"); // no entry
    });
  });
});

describe("real validation flow (validateSignal): evidence is appended with every field, in the hash chain, and the verdict follows the rule", () => {
  async function createSignal(over: { entry?: string | null; stop?: string | null; direction?: string }) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const id = await signalIn(c, over);
      await c.query("commit");
      return id;
    } finally {
      c.release();
    }
  }
  const evidenceFor = async (signalId: string) => (await handle.db.select().from(schema.stopLossValidations).where(eq(schema.stopLossValidations.signalId, signalId)));

  it.each([
    ["missing", { stop: null }, "REJECT", "MISSING", "MISSING_STOP_LOSS"],
    ["zero", { stop: "0" }, "REJECT", "INVALID", "INVALID_STOP_LOSS"],
    ["negative", { stop: "-3" }, "REJECT", "INVALID", "INVALID_STOP_LOSS"],
    ["equal to the entry", { stop: "100" }, "REJECT", "INVALID", "STOP_LOSS_EQUALS_ENTRY"],
    ["wrong side for BUY", { stop: "104" }, "REJECT", "INVALID", "STOP_LOSS_DIRECTION_INVALID"],
    ["wrong side for SELL", { direction: "sell", stop: "96" }, "REJECT", "INVALID", "STOP_LOSS_DIRECTION_INVALID"],
    ["too far", { stop: "70" }, "REJECT", "INVALID", "STOP_LOSS_TOO_FAR"],
    ["no entry price", { entry: null }, "INSUFFICIENT_EVIDENCE", "AMBIGUOUS", "STOP_LOSS_REFERENCE_MISSING"],
  ])("%s -> %s, evidence %s / %s", async (_n, over, outcome, result, reason) => {
    const signalId = await createSignal(over);
    const key = `itest-sl-${sfx()}`;
    const out = await validateSignal(handle.db, signalId, { idempotencyKey: key });
    expect(out.result?.outcome).toBe(outcome);
    expect(out.result?.stopLossReasonCode).toBe(reason);
    const [row] = await evidenceFor(signalId);
    expect(row).toMatchObject({ subjectKind: "signal", signalId, ruleVersion: "stop-loss-v1", result, reasonCode: reason, instrumentType: "equity", instrumentKind: "equity", maxRiskSource: "default", idempotencyKey: `signal-validation:${key}` });
    expect(row?.side).toBe(over.direction ?? "buy");
    // the verdict is stored and is never an approval
    const [v] = await handle.db.select().from(schema.signalValidations).where(eq(schema.signalValidations.signalId, signalId));
    expect(v?.outcome).toBe(outcome);
  });

  it("a valid stop-loss: the evidence records original, normalized, entry, distance and bound; the verdict then depends on the evidence (here: insufficient)", async () => {
    const signalId = await createSignal({ stop: "95.50" });
    const out = await validateSignal(handle.db, signalId, { idempotencyKey: `itest-sl-${sfx()}` });
    expect(out.result?.outcome).toBe("INSUFFICIENT_EVIDENCE");
    const [row] = await evidenceFor(signalId);
    expect(row).toMatchObject({ result: "VALID", reasonCode: null, originalStopLoss: "95.50", normalizedStopLoss: "95.5", entryPrice: "100", riskDistance: "4.5", riskPct: "4.5", maxRiskPct: "10", expectedStopSide: "below", levelBasis: "price" });
  });

  it("a retried validation (same idempotency key) reuses the verdict and appends no second evidence row", async () => {
    const signalId = await createSignal({ stop: null });
    const key = `itest-sl-${sfx()}`;
    await validateSignal(handle.db, signalId, { idempotencyKey: key });
    const again = await validateSignal(handle.db, signalId, { idempotencyKey: key });
    expect(again.reused).toBe(true);
    expect(await evidenceFor(signalId)).toHaveLength(1);
  });

  it("an APPROVE is stored only with its VALID evidence, and the eligibility view / helper / API report it as eligible", async () => {
    const signalId = await createSignal({ stop: "95" });
    const r = fixtureReport({
      core: {
        telegramMessageQuality: fixtureQuality({ entityType: "telegram_messages", overallStatus: "trusted" }),
        macroContext: [{ id: "m1", source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), receivedAt: new Date(), value: "6.5", unit: null, dataQualityStatus: "ok", rawPayload: null, createdAt: new Date() }],
        newsContext: [{ id: "n1", newsSourceId: "s1", newsEventId: null, sourceUrl: "https://x.invalid", headline: "h", bodyExcerpt: null, sourceTimestamp: new Date(), receivedAt: new Date(), dedupeHash: "h", rawPayload: null, createdAt: new Date() }],
      } as never,
      entityContext: { company: { entityId: "e", entityType: "company", canonicalName: "C", strength: "structural", matchMethod: "deterministic_rule" }, sector: null, market: null, country: null, relevantEvents: [{ id: "ev", title: "Dividend declared", eventType: "dividend", firstSeenAt: new Date() }] },
    });
    const signal = { ...r.core.signal, id: signalId };
    const instrument = { id: "i", symbol: "T", exchange: "NSE", instrumentType: "equity", name: null, isin: null, currency: "INR", lotSize: null, tickSize: null, isActive: true, metadata: null, createdAt: new Date(), updatedAt: new Date() } as never;
    const result = decide(signal, instrument, { ...r, core: { ...r.core, signal } }, { now: signal.signalTimestamp });
    expect(result.outcome).toBe("APPROVE");
    const stored = await persistDecisionIntelligence(handle.db, result, `itest-sl-${sfx()}`);
    const elig = await getValidationEligibility(handle.db, stored.id);
    expect(elig).toMatchObject({ approvalEligible: true, note: "stop_loss_valid", stopLossResult: "VALID", stopLossReasonCode: null });
    // the same result with its stop-loss replaced by an invalid one is refused in application code...
    const forged = { ...result, stopLoss: validateStopLoss({ instrumentType: "equity", side: "buy", stopLoss: 105, entryPrice: 100 }) };
    await expect(persistDecisionIntelligence(handle.db, forged, `itest-sl-${sfx()}`)).rejects.toBeInstanceOf(StopLossInvariantError);
    // ...and the API reports the eligibility next to the verdict
    const app = await buildApp({ apiKey: TEST_API_KEY, telegramWebhookSecret: TEST_WEBHOOK_SECRET, telegramQueue: { add: async () => ({ id: "x" }) } as never, db: handle.db });
    try {
      const res = await app.inject({ method: "GET", url: `/signals/${signalId}/validation`, headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: "APPROVE", approvalEligible: true, stopLoss: { result: "VALID", reasonCode: null, note: "stop_loss_valid" } });
    } finally {
      await app.close();
    }
  });

  it("the evidence chain verifies (the table is hash-chained like the other audit tables)", async () => {
    const r = await verifyAuditChainsWithPool(pool, { chains: ["stop_loss_validations"] });
    expect(r.failures).toEqual([]);
    expect(r.chains[0]?.rows).toBeGreaterThan(0);
  });
});

describe("historical rows are never rewritten: an APPROVE without evidence is reported as NOT eligible", () => {
  it("legacy APPROVE (created while the invariant trigger was off, as before migration 0011) -> approval_eligible=false, legacy_no_stop_loss_evidence; with INVALID evidence -> stop_loss_not_valid; with VALID -> eligible", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      await c.query("alter table signal_validations disable trigger signal_validations_stop_loss_invariant"); // emulates rows that pre-date the rule
      const legacy = randomUUID();
      await c.query(verdict(c, signal, "APPROVE").replace(/values \('[^']+'/, `values ('${legacy}'`));
      await c.query("alter table signal_validations enable always trigger signal_validations_stop_loss_invariant");
      const view = async () => (await c.query("select approval_eligible, eligibility_note, stop_loss_result from signal_validation_eligibility where validation_id = $1", [legacy])).rows[0];
      expect(await view()).toMatchObject({ approval_eligible: false, eligibility_note: "legacy_no_stop_loss_evidence", stop_loss_result: null });
      // the legacy row itself is untouched and cannot be touched
      expect(await errCode(c, "update signal_validations set outcome = 'REJECT' where id = $1", [legacy])).toBe("23001");
      await evidence(c, signal, "INVALID", "STOP_LOSS_DIRECTION_INVALID");
      expect(await view()).toMatchObject({ approval_eligible: false, eligibility_note: "stop_loss_not_valid" });
    });
  });
  it("an unknown validation id is not eligible", async () => {
    expect(await getValidationEligibility(handle.db, randomUUID())).toMatchObject({ approvalEligible: false, note: "unknown_validation" });
  });
  it("a non-approval verdict is reported as not_an_approval", async () => {
    await inTx(async (c) => {
      const signal = await signalIn(c);
      const id = randomUUID();
      await c.query(verdict(c, signal, "REJECT").replace(/values \('[^']+'/, `values ('${id}'`));
      expect((await c.query("select approval_eligible, eligibility_note from signal_validation_eligibility where validation_id = $1", [id])).rows[0]).toMatchObject({ approval_eligible: false, eligibility_note: "not_an_approval" });
    });
  });
});

describe("options claims: the stop-loss evidence is recorded with the claim and the claim stays non-approvable", () => {
  const claim = (text: string) => {
    const a = analyzeOptionsText(text);
    if (a.kind !== "options_claim") throw new Error(a.kind);
    return a.claim;
  };
  async function intake(text: string) {
    const suffix = sfx();
    const [source] = await handle.db.insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Date.now()}${suffix}` }).returning();
    const [msg] = await handle.db.insert(schema.telegramMessages).values({ telegramSourceId: must(source).id, externalMessageId: "1", messageTimestamp: new Date(), rawText: text, rawPayload: {} }).returning();
    const c = claim(text);
    const assessment = await assessOptionsClaim(c);
    const rec = await recordOptionsIntake(handle.db, { telegramMessageId: must(msg).id, parserVersion: `itest-sl-${suffix}`, intake: { kind: "claim", claim: c }, assessment, master: null, premium: null });
    return { rec, assessment, claimId: rec.id };
  }
  const evidenceOf = (claimId: string) => handle.db.select().from(schema.stopLossValidations).where(and(eq(schema.stopLossValidations.optionsClaimId, claimId), eq(schema.stopLossValidations.subjectKind, "options_claim")));
  const BASE = "NIFTY 24500 CE 29 OCT 2026";

  it("valid / missing / wrong-side claims: evidence rows with the right result, and approval_possible stays false", async () => {
    const valid = await intake(`BUY ${BASE} ABOVE 120 SL 90 TGT 150 premium`);
    expect(await evidenceOf(valid.claimId)).toMatchObject([{ result: "VALID", reasonCode: null, levelBasis: "premium", instrumentKind: "option", optionType: "CE", side: "buy", originalStopLoss: "90", normalizedStopLoss: "90", entryPrice: "120", riskPct: "25", maxRiskPct: "70" }]);
    const missing = await intake(`BUY ${BASE} ABOVE 120 TGT 150 premium`);
    expect(await evidenceOf(missing.claimId)).toMatchObject([{ result: "MISSING", reasonCode: "MISSING_STOP_LOSS" }]);
    expect(missing.assessment.outcome).toBe("INSUFFICIENT_EVIDENCE");
    const wrong = await intake(`BUY ${BASE} ABOVE 120 SL 140 TGT 150 premium`);
    expect(await evidenceOf(wrong.claimId)).toMatchObject([{ result: "INVALID", reasonCode: "STOP_LOSS_DIRECTION_INVALID" }]);
    expect(wrong.assessment.outcome).toBe("REJECT");
    for (const x of [valid, missing, wrong]) {
      const [row] = await handle.db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.id, x.claimId));
      expect(row?.approvalPossible).toBe(false);
    }
  });
  it("a retried intake finds the existing claim and appends no second evidence row", async () => {
    const first = await intake(`BUY ${BASE} ABOVE 120 SL 90 TGT 150 premium`);
    const [row] = await handle.db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.id, first.claimId));
    const again = await recordOptionsIntake(handle.db, { telegramMessageId: must(row).telegramMessageId, parserVersion: must(row).parserVersion, intake: { kind: "claim", claim: claim(`BUY ${BASE} ABOVE 120 SL 90 TGT 150 premium`) }, assessment: first.assessment, master: null, premium: null });
    expect(again.created).toBe(false);
    expect(await evidenceOf(first.claimId)).toHaveLength(1);
  });
});
