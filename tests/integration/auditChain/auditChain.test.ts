/**
 * Immutable audit trail and tamper evidence against REAL PostgreSQL (Stage 1 / Task 3).
 * Tamper simulations run as the OWNER inside transactions that are ALWAYS rolled back (the guard trigger is disabled in that transaction only), so the
 * shared test database is never left tampered. Committed appends (valid flows) only extend the chains.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { addEventWindow, createPendingRiskDecisionForSignal, evaluateCircuitBreakers, recordLossEvent, recordRiskApproval } from "../../../packages/risk/src/index";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAIN_SPECS, checkRuntimeRolePrivileges, computeEventHash, enforceRuntimeRoleSeparation, GENESIS_HASH, verifyAuditChains, verifyAuditChainsWithPool, verifyChain, type Queryable } from "../../../packages/audit-chain/src/index";
import { changeControl } from "../../../packages/runtime-state/src/index";
import { validateStopLoss } from "../../../packages/stop-loss/src/index";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { persistDecisionIntelligence } from "../../../packages/decision-intelligence/src/persist";
import { recordOptionsIntake } from "../../../packages/signals/src/index";
import { main as verifyCli } from "../../../scripts/ops/verify-audit-chain";
import { main as safetyCli } from "../../../scripts/ops/safety-control";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../../support/must";

/*
 * These tests take heavy locks (TRUNCATE ... CASCADE, ALTER TABLE ... DISABLE TRIGGER, DROP TRIGGER/INDEX) and verify WHOLE chains, so they run in their
 * OWN scratch database, created from the migration chain for this file and dropped afterwards (name prefix twins_ci_scratch_, on the same approved test
 * cluster). Running them in the shared twins_ci database would block, deadlock with or be perturbed by the other integration files that run in parallel.
 */
const ADMIN_URL = requireTestDatabaseUrl();
const SCRATCH_DB = `twins_ci_scratch_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const scratchUrl = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
})();
const DATABASE_URL = scratchUrl;
let pool: pg.Pool;
let handle: BoundedDbHandle;
const TABLES = ["audit_events", "signal_validations", "telegram_messages", "options_claims", "system_control_events", "stop_loss_validations", "risk_decisions", "loss_events", "circuit_breaker_events", "event_blackout_windows", "risk_approvals"] as const;
type Table = (typeof TABLES)[number];
const GUARD: Record<Table, string> = Object.fromEntries(TABLES.map((t) => [t, `${t}_no_update_delete`])) as Record<Table, string>;
/** A content column per table that a tamperer would change. */
const CONTENT: Record<Table, string> = { audit_events: "event_type", signal_validations: "rationale", telegram_messages: "raw_text", options_claims: "parser_version", system_control_events: "reason", stop_loss_validations: "detail", risk_decisions: "decision_reason", loss_events: "source_ref", circuit_breaker_events: "reason_code", event_blackout_windows: "reason", risk_approvals: "reason" };

async function code(sql: string, params: unknown[] = [], tx = false): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(sql, params);
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
    void tx;
  }
}

interface Fixture { sourceId: string; messageIds: string[]; signalId: string }
/** Appends a small, valid set of rows to every chained table inside the given transaction. */
async function appendFixtures(c: pg.PoolClient, extraMessages = 3): Promise<Fixture> {
  const sourceId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await c.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [sourceId, `tg_chat_-100${Date.now()}${suffix}`]);
  const messageIds: string[] = [];
  for (let i = 0; i < extraMessages; i++) {
    const id = randomUUID();
    messageIds.push(id);
    await c.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text, raw_payload) values ($1, $2, $3, now(), $4, $5::jsonb)", [id, sourceId, String(1000 + i), `BUY RELIANCE ${suffix} #${i}`, JSON.stringify({ i, k: "v" })]);
  }
  const instrumentId = randomUUID();
  await c.query("insert into instruments (id, symbol, exchange, instrument_type) values ($1, $2, 'NSE', 'equity')", [instrumentId, `T${suffix}`.toUpperCase()]);
  const signalId = randomUUID();
  await c.query("insert into signals (id, source_type, telegram_message_id, instrument_id, parser_version, direction, signal_timestamp) values ($1, 'telegram', $2, $3, 'itest-v1', 'buy', now())", [signalId, messageIds[0], instrumentId]);
  let lastRiskId: string | null = null;
  for (let i = 0; i < 2; i++) {
    await c.query(
      `insert into signal_validations (id, signal_id, outcome, decision_confidence, confidence_label, bull_thesis, bear_thesis, counter_thesis, counter_thesis_severity, source_reliability, source_reliability_reason, rationale)
       values ($1, $2, 'INSUFFICIENT_EVIDENCE', 0.5, 'label', '{}', '{}', '{}', 'low', 'UNKNOWN', 'none', $3)`,
      [randomUUID(), signalId, `rationale ${suffix} ${i}`],
    );
    await c.query("insert into options_claims (id, telegram_message_id, parser_version, result_kind, reasons, provenance) values ($1, $2, $3, 'ambiguous', '[]', '{}')", [randomUUID(), messageIds[0], `itest-${suffix}-${i}`]);
    const stopLossId = randomUUID();
    await c.query(
      `insert into stop_loss_validations (id, subject_kind, signal_id, rule_version, result, reason_code, detail, instrument_type, instrument_kind, side)
       values ($1, 'signal', $2, 'stop-loss-v1', 'MISSING', 'MISSING_STOP_LOSS', $3, 'equity', 'equity', 'buy')`,
      [stopLossId, signalId, `absent_or_blank ${suffix} ${i}`],
    );
    // risk decisions (Stage 3): version 1, then version 2 superseding it
    const riskId = randomUUID();
    await c.query(
      `insert into risk_decisions (id, signal_id, stop_loss_validation_id, supersedes_id, decision_version, status, idempotency_key, instrument_type, symbol, decision_reason_code, decision_reason, input_snapshot, evidence_references, created_by)
       values ($1, $2, $3, $4, $5, 'PENDING', $6, 'equity', $7, 'stop_loss_missing', $8, '{"itest":true}', '{}', 'service:itest')`,
      [riskId, signalId, stopLossId, i === 0 ? null : lastRiskId, i + 1, `itest-risk-${suffix}-${i}`, `T${suffix}`.toUpperCase(), `risk reason ${suffix} ${i}`],
    );
    lastRiskId = riskId;
    // a risk approval (Stage 3 / Task 6): a REJECT of the decision above (the table guard allows it for any existing decision version)
    await c.query(
      `insert into risk_approvals (id, risk_decision_id, decision_version, action, actor, actor_context, reason, decision_snapshot, evidence_references) values (gen_random_uuid(), $1, $2, 'REJECT', 'operator:itest', '{}', $3, '{"itest":true}', '{}')`,
      [riskId, i + 1, `approval reason ${suffix} ${i}`],
    );
    // loss events and circuit-breaker events (Stage 3 / Task 4); WARNED rows only, so no breaker is ever left open
    await c.query(
      "insert into loss_events (id, amount, occurred_at, source, source_ref, idempotency_key, created_by) values ($1, 10, '1960-01-04T10:00:00Z', 'synthetic', $2, $3, 'service:itest')",
      [randomUUID(), `itest-${suffix}-${i}`, `itest-loss-${suffix}-${i}`],
    );
    await c.query(
      `insert into circuit_breaker_events (id, scope, event_type, period_start, period_end, loss_amount, limit_amount, capital, loss_pct, planned_exposure_amount, reason_code, idempotency_key, snapshot, created_by)
       values ($1, 'DAILY', 'WARNED', '1960-01-04T00:00:00Z', '1960-01-05T00:00:00Z', 15, 20, 1000, 1.5, 0, $2, $3, '{}', 'service:itest')`,
      [randomUUID(), `daily_loss_warning_${suffix}_${i}`, `itest-breaker-${suffix}-${i}`],
    );
    // event blackout windows (Stage 3 / Task 5): a WINDOW (far past, so it never matters to anything) and its CANCELLATION
    const windowId = randomUUID();
    await c.query(
      `insert into event_blackout_windows (id, entry_type, market, scope, severity, starts_at, ends_at, reason_code, reason, idempotency_key, created_by)
       values ($1, 'WINDOW', 'NSE', 'MARKET', 'WARNING', '1960-01-04T00:00:00Z', '1960-01-05T00:00:00Z', $2, 'itest window reason', $3, 'operator:itest')`,
      [windowId, `itest_window_${suffix}_${i}`, `itest-window-${suffix}-${i}`],
    );
    if (i === 0) {
      await c.query(
        `insert into event_blackout_windows (id, entry_type, market, scope, severity, starts_at, ends_at, reason_code, cancels_id, idempotency_key, created_by)
         values (gen_random_uuid(), 'CANCELLATION', 'NSE', 'MARKET', 'WARNING', '1960-01-04T00:00:00Z', '1960-01-05T00:00:00Z', $1, $2, $3, 'operator:itest')`,
        [`itest_window_${suffix}_${i}`, windowId, `itest-window-cancel-${suffix}-${i}`],
      );
    }
    await c.query("insert into audit_events (id, event_type, entity_type, actor_type, metadata) values ($1, $2, 'itest', 'system', $3::jsonb)", [randomUUID(), `itest.${suffix}.${i}`, JSON.stringify({ b: 2, a: [1, null, "x"] })]);
  }
  return { sourceId, messageIds, signalId };
}

/** Runs `fn` in a transaction that is rolled back. `tamper` may disable a guard trigger there. */
async function inRolledBackTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

beforeAll(async () => {
  if (!/^twins_ci_scratch_[0-9a-f]{12}$/.test(SCRATCH_DB)) throw new Error("refusing: unexpected scratch database name");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
  const migrationPool = new pg.Pool({ connectionString: scratchUrl, max: 1 });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: "packages/database/drizzle" });
  } finally {
    await migrationPool.end();
  }
  pool = new pg.Pool({ connectionString: scratchUrl, max: 8 });
  handle = createBoundedDb(scratchUrl, { max: 4, idleTimeoutMillis: 10_000 }); // (a plain string: an object form would fall back to DATABASE_URL, i.e. the shared database)
}, 120_000);
afterAll(async () => {
  await handle?.close();
  await pool?.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    if (/^twins_ci_scratch_[0-9a-f]{12}$/.test(SCRATCH_DB)) await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
  } finally {
    await admin.end();
  }
}, 60_000);

describe("append-only: UPDATE, DELETE and TRUNCATE are rejected on every protected table, raw SQL included", () => {
  it.each(TABLES)("%s", async (table) => {
    await inRolledBackTx(async (c) => {
      await appendFixtures(c);
      for (const sql of [
        `update ${table} set ${CONTENT[table]} = ${CONTENT[table]} || 'x'`,
        `update ${table} set event_hash = repeat('a', 64)`,
        `update ${table} set previous_hash = repeat('a', 64)`,
        `update ${table} set payload_hash = repeat('a', 64)`,
        `update ${table} set chain_index = chain_index + 1000000`,
        `update ${table} set created_at = created_at - interval '1 day'`,
        `delete from ${table}`,
        `truncate ${table}`,
        `truncate ${table} cascade`,
      ]) {
        await c.query("savepoint s");
        const err = await c.query(sql).then(() => null, (e: { code?: string; message?: string }) => e);
        await c.query("rollback to savepoint s");
        // A plain TRUNCATE of a table that other tables reference is refused by PostgreSQL itself (0A000) before any trigger; every other form hits the guard.
        const plainTruncate = sql === `truncate ${table}`;
        expect(plainTruncate ? ["23001", "0A000"] : ["23001"], `${sql} -> ${err?.code}`).toContain(err?.code);
      }
    });
  });
  it("the guards also hold under session_replication_role = replica (the usual way to switch triggers off) and cannot be bypassed by a no-op-looking UPDATE", async () => {
    await inRolledBackTx(async (c) => {
      await appendFixtures(c);
      await c.query("set local session_replication_role = replica");
      for (const table of TABLES) {
        await c.query("savepoint s");
        const err = await c.query(`update ${table} set event_hash = event_hash`).then(() => null, (e: { code?: string }) => e);
        await c.query("rollback to savepoint s");
        expect(err?.code, table).toBe("23001");
      }
    });
  });
  it("chain columns cannot be supplied or influenced by the inserter: the database assigns them", async () => {
    await inRolledBackTx(async (c) => {
      const fx = await appendFixtures(c, 1);
      const forged = "f".repeat(64);
      await c.query("insert into audit_events (id, event_type, entity_type, actor_type, chain_index, previous_hash, payload_hash, event_hash) values ($1, 'itest.forged', 'x', 'system', 1, $2, $2, $2)", [randomUUID(), forged]);
      const row = must((await c.query("select chain_index::text, previous_hash, payload_hash, event_hash from audit_events where event_type = 'itest.forged'")).rows[0]);
      expect(row["chain_index"]).not.toBe("1");
      expect([row["previous_hash"], row["payload_hash"], row["event_hash"]]).not.toContain(forged);
      expect(fx.messageIds).toHaveLength(1);
    });
  });
});

describe("valid append flows still work and extend the chain", () => {
  it("real application writers append to every chained table (committed), and the whole database still verifies", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [source] = await handle.db.insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Date.now()}${suffix}` }).returning();
    const [msg] = await handle.db.insert(schema.telegramMessages).values({ telegramSourceId: must(source).id, externalMessageId: "1", messageTimestamp: new Date(), rawText: `valid flow ${suffix}`, rawPayload: { ok: true } }).onConflictDoNothing().returning();
    expect(msg).toBeDefined();
    // a duplicate insert (ON CONFLICT DO NOTHING) leaves no gap in the chain
    const dup = await handle.db.insert(schema.telegramMessages).values({ telegramSourceId: must(source).id, externalMessageId: "1", messageTimestamp: new Date(), rawText: "duplicate", rawPayload: {} }).onConflictDoNothing().returning();
    expect(dup).toHaveLength(0);
    const [instrument] = await handle.db.insert(schema.instruments).values({ symbol: `V${suffix}`.toUpperCase(), exchange: "NSE", instrumentType: "equity" }).returning();
    const [signal] = await handle.db.insert(schema.signals).values({ sourceType: "telegram", telegramMessageId: must(msg).id, instrumentId: must(instrument).id, parserVersion: "itest-v1", direction: "buy", signalTimestamp: new Date() }).returning();
    const validation = await persistDecisionIntelligence(handle.db, {
      signalId: must(signal).id, outcome: "INSUFFICIENT_EVIDENCE", decisionConfidence: 0.5, confidenceLabel: "l",
      bullThesis: { stance: "supporting", factors: [], evidenceIds: [], strength: "weak" }, bearThesis: { stance: "contradicting", factors: [], evidenceIds: [], strength: "weak" },
      stopLoss: validateStopLoss({ instrumentType: "equity", side: "buy", stopLoss: 95, entryPrice: 100 }), counterThesis: { severity: "low" } as never, sourceReliability: { level: "UNKNOWN", reason: "none" }, rationale: "valid flow", validatedAt: new Date(), structuralIssues: [],
    } as never, `itest-${suffix}`);
    expect(validation.reused).toBe(false);
    const claim = await recordOptionsIntake(handle.db, { telegramMessageId: must(msg).id, parserVersion: `itest-${suffix}`, intake: { kind: "ambiguous", directives: [] } as never, assessment: undefined, master: null, premium: null });
    expect(claim.created).toBe(true);
    const pendingDecision = await createPendingRiskDecisionForSignal(handle.db, must(signal).id);
    expect(pendingDecision).toMatchObject({ created: true, status: "PENDING" });
    expect(await recordRiskApproval(handle.db, { decisionId: (pendingDecision as { id: string }).id, action: "REJECT", actor: "operator:itest", reason: "itest real writer" })).toMatchObject({ outcome: "recorded" }); // the real approval writer (Task 6) // the real writer of risk decisions (evidence recorded by the validation above)
    // Task 4 real writers: a loss event, then the breaker records the breach (and, a week later, the automatic reset); a far-past date keeps every breaker closed at the database clock
    const when = new Date(Date.UTC(1800 + Math.floor(Math.random() * 100), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 10)); // a random far-past day per run, so repeated runs on one database do not share a period
    expect(await recordLossEvent(handle.db, { amount: 25_000, occurredAt: when, source: "synthetic", sourceRef: `itest-${suffix}`, createdBy: "service:itest" })).toMatchObject({ created: true });
    const breached = await evaluateCircuitBreakers(handle.db, { capital: 1_000_000, asOf: new Date(when.getTime() + 2 * 3_600_000) });
    expect(breached.events.filter((e) => e.created).map((e) => e.eventType)).toContain("BREACHED");
    const reset = await evaluateCircuitBreakers(handle.db, { capital: 1_000_000, asOf: new Date(when.getTime() + 10 * 86_400_000) });
    expect(reset.events.filter((e) => e.created).map((e) => e.eventType)).toContain("RESET");
    expect(await addEventWindow(handle.db, { market: "NSE", scope: "MARKET", severity: "WARNING", startsAt: new Date("1960-03-07T00:00:00Z"), endsAt: new Date("1960-03-08T00:00:00Z"), reasonCode: `itest_${suffix}`, createdBy: "operator:itest" })).toMatchObject({ created: true });
    await handle.db.insert(schema.auditEvents).values({ eventType: `itest.valid.${suffix}`, entityType: "itest", actorType: "system", metadata: { suffix } });
    const report = await verifyAuditChainsWithPool(pool);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    for (const c of report.chains) expect(c.rows, c.chain).toBeGreaterThan(0);
    expect(await handle.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.id, must(msg).id))).toHaveLength(1);
  });
  it("a rolled-back insert leaves no gap (the next index is derived from committed rows)", async () => {
    const before = Number(must((await pool.query("select max(chain_index) as m from audit_events")).rows[0])["m"]);
    await inRolledBackTx(async (c) => {
      await c.query("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, 'itest.rollback', 'x', 'system')", [randomUUID()]);
    });
    const type = `itest.after_rollback.${randomUUID().slice(0, 8)}`;
    await pool.query("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, $2, 'x', 'system')", [randomUUID(), type]);
    const idx = Number(must((await pool.query("select chain_index from audit_events where event_type = $1", [type])).rows[0])["chain_index"]);
    expect(idx).toBeGreaterThan(before);
    expect((await verifyAuditChainsWithPool(pool)).ok).toBe(true);
  });
  it("20 concurrent appends serialize into a gap-free chain without deadlock", async () => {
    const before = Number(must((await pool.query("select max(chain_index) as m from audit_events")).rows[0])["m"]);
    await Promise.all(Array.from({ length: 20 }, (_, i) => pool.query("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, $2, 'x', 'system')", [randomUUID(), `itest.concurrent.${i}`])));
    const rows = (await pool.query("select chain_index::int as i from audit_events where chain_index > $1 order by chain_index", [before])).rows.map((r) => r["i"] as number);
    expect(rows).toEqual(Array.from({ length: rows.length }, (_, k) => before + 1 + k));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect((await verifyAuditChainsWithPool(pool)).ok).toBe(true);
  });
  it("the canonical payload computed independently in TypeScript equals the database's, for awkward content (quotes, backslashes, control characters, emoji, U+2028, NULLs, jsonb numbers)", async () => {
    await inRolledBackTx(async (c) => {
      const source = randomUUID();
      await c.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [source, `tg_chat_-100${Date.now()}${randomUUID().slice(0, 6)}`]);
      const text = 'q"uote \\ back\nline\ttab\u0001ctl   sep é 😀 end';
      await c.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text, raw_payload, edit_date) values ($1, $2, $3, '2026-10-29 01:02:03.123456+05:30', $4, $5::jsonb, null)", [randomUUID(), source, "9", text, '{"z":1.50,"a":{"b":[true,null,"é\\u0001x"]},"n":1e3}']);
      const spec = must(CHAIN_SPECS.find((s) => s.chain === "telegram_messages"));
      const r = await verifyChain(c, spec);
      expect(r.firstFailure).toBeUndefined();
      expect(r.ok).toBe(true);
    });
  });
});

describe("tamper evidence: every kind of tampering is detected, at the first failing row", () => {
  // The owner disables the guard trigger (this is what a determined admin would have to do) and edits the data; the verifier must notice.
  async function tampered(table: Table, tamper: (c: pg.PoolClient, ctx: { first: number; last: number }) => Promise<void>, opts: { alsoHeads?: boolean; alsoGuard?: string[] } = {}) {
    return inRolledBackTx(async (c) => {
      await appendFixtures(c);
      const first = Number(must((await c.query(`select min(chain_index) as m from ${table} where chain_index > (select max(chain_index) - 2 from ${table})`)).rows[0])["m"]);
      const last = Number(must((await c.query(`select max(chain_index) as m from ${table}`)).rows[0])["m"]);
      expect((await verifyAuditChains(c, { chains: [table] })).ok).toBe(true); // intact before tampering
      await c.query(`alter table ${table} disable trigger ${GUARD[table]}`);
      for (const g of opts.alsoGuard ?? []) await c.query(`alter table ${table} disable trigger ${g}`);
      if (opts.alsoHeads) await c.query("alter table audit_chain_heads disable trigger audit_chain_heads_guard");
      // a determined tamperer also has to get past the foreign keys that now protect evidence and predecessors (restrict): replica mode skips FK triggers
      await c.query("set local session_replication_role = replica");
      await tamper(c, { first, last });
      await c.query("set local session_replication_role = origin");
      await c.query(`alter table ${table} enable always trigger ${GUARD[table]}`);
      for (const g of opts.alsoGuard ?? []) await c.query(`alter table ${table} enable always trigger ${g}`);
      if (opts.alsoHeads) await c.query("alter table audit_chain_heads enable always trigger audit_chain_heads_guard");
      return { report: await verifyAuditChains(c, { chains: [table] }), first, last };
    });
  }

  it.each(TABLES)("%s: a modified payload is detected (and located)", async (table) => {
    const { report, last } = await tampered(table, async (c, { last }) => void (await c.query(`update ${table} set ${CONTENT[table]} = ${CONTENT[table]} || '-edited' where chain_index = $1`, [last])));
    expect(report.ok).toBe(false);
    expect(report.firstFailure).toMatchObject({ code: "payload_modified", chain: table, chainIndex: last });
  });
  it.each(TABLES)("%s: a deleted event in the middle is detected as missing rows", async (table) => {
    const { report, last } = await tampered(table, async (c, { last }) => void (await c.query(`delete from ${table} where chain_index = $1`, [last - 1])));
    expect(report.firstFailure).toMatchObject({ code: "missing_rows", chain: table, chainIndex: last });
  });
  it.each(TABLES)("%s: deleting the NEWEST event is detected through the chain head", async (table) => {
    const { report } = await tampered(table, async (c, { last }) => void (await c.query(`delete from ${table} where chain_index = $1`, [last])));
    expect(report.firstFailure).toMatchObject({ code: "missing_rows", chain: table });
    // (for audit_events the DDL watch itself appends an event after the tampering statement, so the deleted row is then "in the middle" rather than the newest)
    expect(must(report.firstFailure).detail).toMatch(table === "audit_events" ? /newest|missing before/ : /newest/);
  });
  it.each(TABLES)("%s: a tampered previous_hash is detected as a broken link", async (table) => {
    const { report, last } = await tampered(table, async (c, { last }) => void (await c.query(`update ${table} set previous_hash = repeat('b', 64) where chain_index = $1`, [last])));
    expect(report.firstFailure).toMatchObject({ code: "broken_link", chain: table, chainIndex: last });
  });
  it.each(TABLES)("%s: a tampered event_hash is detected", async (table) => {
    const { report, last } = await tampered(table, async (c, { last }) => void (await c.query(`update ${table} set event_hash = repeat('c', 64) where chain_index = $1`, [last])));
    expect(report.ok).toBe(false);
    expect(report.firstFailure).toMatchObject({ code: "invalid_event_hash", chain: table, chainIndex: last });
  });
  it.each(TABLES)("%s: a tampered payload_hash is detected", async (table) => {
    const { report, last } = await tampered(table, async (c, { last }) => void (await c.query(`update ${table} set payload_hash = repeat('d', 64) where chain_index = $1`, [last])));
    expect(report.firstFailure).toMatchObject({ code: "payload_modified", chain: table, chainIndex: last });
  });
  it("audit_events: a repeated/reordered chain_index is detected (the unique index was dropped by the tamperer)", async () => {
    const r = await inRolledBackTx(async (c) => {
      await appendFixtures(c);
      const last = Number(must((await c.query("select max(chain_index) as m from audit_events")).rows[0])["m"]);
      await c.query("alter table audit_events disable trigger audit_events_no_update_delete");
      await c.query("alter table audit_events drop constraint audit_events_chain_check");
      await c.query("drop index audit_events_chain_index_unique");
      await c.query("update audit_events set chain_index = $2 where chain_index = $1", [last, last - 1]);
      await c.query("alter table audit_events enable always trigger audit_events_no_update_delete");
      return verifyAuditChains(c, { chains: ["audit_events"] });
    });
    expect(r.ok).toBe(false);
    expect(["out_of_order", "broken_link"]).toContain(must(r.firstFailure).code); // (which duplicate is read first is up to the planner; the unit tests pin out_of_order exactly)
    expect(r.firstFailure).toMatchObject({ chain: "audit_events" });
  });
  it("a disabled or missing guard trigger is reported even when no data was touched (protection_missing)", async () => {
    const r = await inRolledBackTx(async (c) => {
      await c.query("alter table telegram_messages disable trigger telegram_messages_no_update_delete");
      return verifyAuditChains(c);
    });
    expect(r.ok).toBe(false);
    expect(r.protection.problems.map((p) => p.detail).join(" ")).toMatch(/telegram_messages_no_update_delete.*not ENABLE ALWAYS/);
    const r2 = await inRolledBackTx(async (c) => {
      await c.query("drop trigger options_claims_no_truncate on options_claims");
      return verifyAuditChains(c);
    });
    expect(r2.firstFailure).toMatchObject({ code: "protection_missing", chain: "options_claims" });
  });
  it("hiding a tail deletion by also rewriting the chain head is caught by the external anchor file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-anchor-"));
    const anchorFile = join(dir, "anchor.json");
    try {
      const first = await verifyAuditChainsWithPool(pool, { anchorFile });
      expect(first.ok).toBe(true);
      expect(existsSync(anchorFile)).toBe(true);
      const anchors = JSON.parse(readFileSync(anchorFile, "utf8")).anchors as Record<string, { index: number }>;
      expect(Object.keys(anchors).sort()).toEqual([...TABLES].sort());
      // a later run inside a tampered transaction: delete the newest audit row AND rewrite the head to match, so chain + head alone pass
      const r = await inRolledBackTx(async (c) => {
        await c.query("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, 'itest.anchor.victim', 'x', 'system')", [randomUUID()]);
        const anchorIdx = must(anchors["audit_events"]).index;
        await c.query("alter table audit_events disable trigger audit_events_no_update_delete");
        await c.query("alter table audit_chain_heads disable trigger audit_chain_heads_guard");
        await c.query("delete from audit_events where chain_index >= $1", [anchorIdx]);
        const prev = must((await c.query("select chain_index, event_hash from audit_events order by chain_index desc limit 1")).rows[0]);
        await c.query("update audit_chain_heads set last_index = $1, last_hash = $2 where chain_name = 'audit_events'", [prev["chain_index"], prev["event_hash"]]);
        await c.query("alter table audit_events enable always trigger audit_events_no_update_delete");
        await c.query("alter table audit_chain_heads enable always trigger audit_chain_heads_guard");
        const withoutAnchor = await verifyAuditChains(c, { chains: ["audit_events"] });
        const withAnchor = await verifyAuditChains(c, { chains: ["audit_events"], anchorFile });
        return { withoutAnchor, withAnchor };
      });
      expect(r.withoutAnchor.ok).toBe(true); // chain + head alone cannot see it...
      expect(r.withAnchor.ok).toBe(false); // ...the anchor kept outside the database can
      expect(r.withAnchor.firstFailure).toMatchObject({ code: "anchor_mismatch", chain: "audit_events" });
      // a failing run must not overwrite the anchor
      expect(JSON.parse(readFileSync(anchorFile, "utf8")).anchors.audit_events.index).toBe(must(anchors["audit_events"]).index);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the event-hash definition is the documented one (domain, chain, index, previous hash, payload hash) and genesis is 64 zeros", async () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const first = must((await pool.query("select previous_hash, payload_hash, event_hash from audit_events where chain_index = 1")).rows[0]);
    expect(first["previous_hash"]).toBe(GENESIS_HASH);
    expect(computeEventHash("audit_events", 1, GENESIS_HASH, String(first["payload_hash"]))).toBe(first["event_hash"]);
  });
});

describe("verifier CLI (npm run audit:verify)", () => {
  const run = async (argv: string[], open?: Parameters<typeof verifyCli>[1]["open"]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await verifyCli(argv, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => err.push(l), ...(open ? { open } : {}) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  it("PASS on the intact database: exit 0, a per-chain report, JSON mode and a status file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-status-"));
    try {
      const statusFile = join(dir, "status.json");
      const r = await run(["--status-file", statusFile]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("AUDIT CHAIN VERIFICATION: PASS");
      for (const t of TABLES) expect(r.out).toContain(t);
      expect(JSON.parse(readFileSync(statusFile, "utf8"))).toMatchObject({ ok: true, first_failure: null });
      const j = await run(["--json", "--chain", "audit_events"]);
      expect(j.code).toBe(0);
      expect(JSON.parse(j.out)).toMatchObject({ ok: true, chains: [{ chain: "audit_events", ok: true }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("FAIL on a tampered database: exit 1, prints the FIRST failure point, status file records it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-status-"));
    try {
      const statusFile = join(dir, "status.json");
      const r = await inRolledBackTx(async (c) => {
        await appendFixtures(c);
        const last = Number(must((await c.query("select max(chain_index) as m from telegram_messages")).rows[0])["m"]);
        await c.query("alter table telegram_messages disable trigger telegram_messages_no_update_delete");
        await c.query("update telegram_messages set raw_text = 'TAMPERED' where chain_index = $1", [last]);
        await c.query("alter table telegram_messages enable always trigger telegram_messages_no_update_delete");
        const result = await run(["--status-file", statusFile], () => ({ db: c as Queryable, close: async () => undefined }));
        return { ...result, last };
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("AUDIT CHAIN VERIFICATION: FAIL");
      expect(r.out).toContain(`FIRST FAILURE: payload_modified in telegram_messages at chain_index ${r.last}`);
      expect(JSON.parse(readFileSync(statusFile, "utf8"))).toMatchObject({ ok: false, first_failure: "payload_modified" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("usage errors exit 2 and an unreachable database exits 3 without printing the connection string", async () => {
    for (const argv of [["--bogus"], ["--chain", "nope"], ["--batch-size", "0"], ["--anchor-file"]]) expect((await run(argv)).code, argv.join(" ")).toBe(2);
    const down = await verifyCli([], { env: { DATABASE_URL: "postgresql://u:secret-pw@127.0.0.1:1/x" }, out: () => undefined, err: () => undefined, open: () => ({ db: { query: async () => { throw Object.assign(new Error("connect ECONNREFUSED secret-pw"), { code: "ECONNREFUSED" }); } }, close: async () => undefined }) });
    expect(down).toBe(3);
    const errs: string[] = [];
    await verifyCli([], { env: { DATABASE_URL: "postgresql://u:secret-pw@127.0.0.1:1/x" }, out: () => undefined, err: (l) => errs.push(l), open: () => ({ db: { query: async () => { throw Object.assign(new Error("secret-pw"), { code: "ECONNREFUSED" }); } }, close: async () => undefined }) });
    expect(errs.join("")).not.toContain("secret-pw");
    expect((await verifyCli([], { env: {}, out: () => undefined, err: () => undefined })).valueOf()).toBe(2);
  });
  it("--require-ddl-watch turns an absent DDL watch into a failure (reported otherwise)", async () => {
    const r = await inRolledBackTx(async (c) => {
      await c.query("drop event trigger twins_audit_ddl_watch").catch(() => undefined);
      const plain = await verifyAuditChains(c);
      const strict = await verifyAuditChains(c, { requireDdlWatch: true });
      return { plain, strict };
    });
    expect(r.plain.ddlWatch).toBe("absent");
    expect(r.plain.ok).toBe(true);
    expect(r.strict.firstFailure).toMatchObject({ code: "ddl_watch_missing" });
  });
});

describe("DDL watch: schema-level bypass attempts are not silent", () => {
  it("disabling or dropping a protection is recorded in the immutable audit trail (inside the same transaction here, then rolled back)", async () => {
    const seen = await inRolledBackTx(async (c) => {
      await c.query("alter table audit_events disable trigger audit_events_no_update_delete");
      await c.query("drop trigger signal_validations_no_truncate on signal_validations");
      const rows = (await c.query("select event_type, metadata->>'statement' as s, metadata->>'session_user' as u from audit_events where event_type like 'ddl.%' order by chain_index desc limit 2")).rows;
      return rows;
    });
    expect(seen.map((r) => r["event_type"])).toEqual(["ddl.drop_trigger", "ddl.alter_table"]);
    expect(String(must(seen[0])["s"])).toContain("signal_validations_no_truncate");
    expect(String(must(seen[1])["s"])).toContain("disable trigger audit_events_no_update_delete");
    expect(must(seen[0])["u"]).toBeTruthy();
  });
});

describe("operator identity in system_control_events", () => {
  const cleanup = async () => {
    for (const [control, value] of [["KILL_SWITCH_ACTIVE", false], ["TRADING_ENABLED", false], ["INTAKE_ENABLED", true]] as const) {
      await changeControl(pool, { control, value, reason: `restore defaults ${randomUUID().slice(0, 8)}`, changedBy: "service:itest-audit", mechanism: "service", sourceProcess: "itest-audit" }).catch(() => undefined);
    }
  };
  afterAll(cleanup);
  it("a CLI change records mechanism, source process, declared context and the database-observed session", async () => {
    await cleanup();
    const reason = `cli identity ${randomUUID().slice(0, 8)}`;
    const out: string[] = [];
    const code = await safetyCli(["set", "--control", "INTAKE_ENABLED", "--value", "false", "--reason", reason, "--changed-by", "operator:itest-alice"], {
      env: { DATABASE_URL }, out: (l) => out.push(l), err: () => undefined, openPool: () => ({ pool, close: async () => undefined }), operatorContext: () => ({ os_user: "alice", host: "ops-1", pid: 4242 }),
    });
    expect(code).toBe(0);
    const e = must((await pool.query("select changed_by, change_mechanism, source_process, operator_context, db_session_user, db_client_addr, db_application_name from system_control_events where reason = $1", [reason])).rows[0]);
    expect(e).toMatchObject({ changed_by: "operator:itest-alice", change_mechanism: "cli", source_process: "safety-control", operator_context: { os_user: "alice", host: "ops-1", pid: 4242 } });
    expect(e["db_session_user"]).toBeTruthy();
    await cleanup();
  });
  it("a service change records the service identity", async () => {
    const reason = `service identity ${randomUUID().slice(0, 8)}`;
    await changeControl(pool, { control: "INTAKE_ENABLED", value: false, reason, changedBy: "service:circuit-breaker", mechanism: "service", sourceProcess: "circuit-breaker", operatorContext: { trigger: "daily_loss" } });
    const e = must((await pool.query("select changed_by, change_mechanism, source_process, operator_context from system_control_events where reason = $1", [reason])).rows[0]);
    expect(e).toMatchObject({ changed_by: "service:circuit-breaker", change_mechanism: "service", source_process: "circuit-breaker", operator_context: { trigger: "daily_loss" } });
    await cleanup();
  });
  it("a raw SQL change is recorded as such (mechanism sql, source raw_sql, the database session), distinguishable from CLI and service changes", async () => {
    await cleanup();
    const reason = `raw sql ${randomUUID().slice(0, 8)}`;
    await pool.query("update system_controls set value = false, version = version + 1, reason = $1, changed_by = 'dba.bob' where control_name = 'INTAKE_ENABLED'", [reason]);
    const e = must((await pool.query("select changed_by, change_mechanism, source_process, db_session_user from system_control_events where reason = $1", [reason])).rows[0]);
    expect(e).toMatchObject({ changed_by: "dba.bob", change_mechanism: "sql", source_process: "raw_sql" });
    expect(e["db_session_user"]).toBeTruthy();
    await cleanup();
  });
  it("the identity convention is enforced by the database: claiming cli/service with a mismatching identity is rejected, and a change is never recorded without context", async () => {
    await cleanup();
    for (const [mech, who] of [["cli", "bob"], ["cli", "service:bob"], ["service", "operator:bob"], ["bogus", "operator:bob"]] as const) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('twins.change_mechanism', $1, true), set_config('twins.source_process', 'x-test', true)", [mech]);
        const err = await c.query("update system_controls set value = false, version = version + 1, reason = 'identity mismatch test', changed_by = $1 where control_name = 'INTAKE_ENABLED'", [who]).then(() => null, (e: { code?: string }) => e);
        expect(err?.code, `${mech}/${who}`).toBe("23514");
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    expect(await code("update system_control_events set change_mechanism = 'sql'")).toBe("23001");
  });
  it("the system_control_events chain verifies (including the operator context fields)", async () => {
    const r = await verifyAuditChainsWithPool(pool, { chains: ["system_control_events"] });
    expect(r.ok).toBe(true);
  });
});

describe("real processes refuse to start as a privileged database role outside development (exit 82)", () => {
  const base = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp", LIVE_TRADING: "false", TRADING_MODE: "paper", REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:1", TWINS_API_KEY: "k".repeat(24), TELEGRAM_WEBHOOK_SECRET: "s".repeat(24) };
  it.each([
    ["api", ["--import", "tsx", `${process.cwd()}/apps/api/src/index.ts`]],
    ["worker", ["--import", "tsx", "services/worker/src/index.ts"]],
  ])("%s as the owner/superuser role in APP_ENV=staging", (_name, args) => {
    const r = spawnSync("node", args as string[], { cwd: process.cwd(), env: { ...base, APP_ENV: "staging", DATABASE_URL: scratchUrl }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(82);
    const line = JSON.parse(r.stderr.trim().split("\n").pop() as string) as { event: string; problems: string[] };
    expect(line.event).toBe("audit.role_separation.refused");
    expect(line.problems).toEqual(expect.arrayContaining(["role_is:rolsuper"]));
    expect(r.stderr).not.toContain("ci_only_not_a_secret");
  }, 90_000);
});

describe("role separation: the runtime role (infrastructure/staging/app-role.sql)", () => {
  const ROLE = "twins_app";
  const roleSql = readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${ROLE}"`).replaceAll(":'app_role'", `'${ROLE}'`);
  let client: pg.PoolClient;
  let sp = 0;
  async function asApp<T>(fn: () => Promise<T>): Promise<T> {
    await client.query(`savepoint a${++sp}`);
    await client.query(`set local role ${ROLE}`);
    try {
      return await fn();
    } finally {
      await client.query(`rollback to savepoint a${sp}`);
      await client.query("reset role");
    }
  }
  const asCode = async (sql: string, params: unknown[] = []): Promise<string> => {
    try {
      await asApp(() => client.query(sql, params));
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };
  let fx: Fixture;

  beforeAll(async () => {
    client = await pool.connect();
    if ((await client.query("select 1 from pg_roles where rolname = $1", [ROLE])).rowCount) throw new Error(`a role named ${ROLE} already exists in this cluster; refusing to run`);
    await client.query("begin");
    await client.query(`create role ${ROLE} login`);
    const doBlock = must(/DO \$\$[\s\S]*?\$\$;/.exec(roleSql))[0];
    const withoutDo = roleSql.replace(doBlock, "");
    for (const statement of [...withoutDo.split(/;\s*\n/), doBlock.replace(/;$/, "")].map((x) => x.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean)) await client.query(statement);
    fx = await appendFixtures(client);
  });
  afterAll(async () => {
    await client?.query("rollback").catch(() => undefined);
    client?.release();
  });

  it("passes the runtime privilege self-check; the owner/superuser role does not", async () => {
    expect(await asApp(() => checkRuntimeRolePrivileges(client))).toEqual([]);
    const ownerProblems = await checkRuntimeRolePrivileges(client);
    expect(ownerProblems.some((p) => p.startsWith("owns:") || p.startsWith("role_is:"))).toBe(true);
  });
  it("can still append to every protected table (valid flows are not broken by least privilege) and the chain advances", async () => {
    expect(await asCode("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, 'itest.app', 'x', 'system')", [randomUUID()])).toBe("ok");
    expect(await asCode("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text) values ($1, $2, 'app-1', now(), 'by app role')", [randomUUID(), fx.sourceId])).toBe("ok");
    expect(await asCode("insert into options_claims (id, telegram_message_id, parser_version, result_kind, reasons, provenance) values ($1, $2, 'app-role-1', 'ambiguous', '[]', '{}')", [randomUUID(), fx.messageIds[0]])).toBe("ok");
    expect(await asCode(`insert into stop_loss_validations (id, subject_kind, signal_id, rule_version, result, reason_code) values ($1, 'signal', $2, 'stop-loss-v1', 'MISSING', 'MISSING_STOP_LOSS')`, [randomUUID(), fx.signalId])).toBe("ok");
    expect(await asCode(`insert into signal_validations (id, signal_id, outcome, decision_confidence, confidence_label, bull_thesis, bear_thesis, counter_thesis, counter_thesis_severity, source_reliability, source_reliability_reason, rationale)
                         values ($1, $2, 'REJECT', 1, 'l', '{}', '{}', '{}', 'low', 'UNKNOWN', 'n', 'by app role')`, [randomUUID(), fx.signalId])).toBe("ok");
    expect(await asCode("update signals set status = 'decided' where id = $1", [fx.signalId])).toBe("ok"); // ordinary tables keep UPDATE
  });
  it("cannot UPDATE, DELETE or TRUNCATE any protected table (privilege error 42501 before any trigger)", async () => {
    for (const t of TABLES) {
      for (const sql of [`update ${t} set ${CONTENT[t]} = 'x'`, `delete from ${t}`, `truncate ${t}`]) expect(await asCode(sql), sql).toBe("42501");
    }
    expect(await asCode("delete from signals")).toBe("42501"); // the application never deletes anything
  });
  it("cannot change a runtime control, write the audit heads, read the control audit, or touch the bot's tables", async () => {
    for (const sql of [
      "update system_controls set value = true, version = version + 1, reason = 'app role attempt', changed_by = 'service:app'",
      "insert into system_controls (control_name, value, reason, changed_by) values ('X', true, 'attempt', 'service:app')",
      "update audit_chain_heads set last_index = last_index + 1",
      "delete from audit_chain_heads",
      "select 1 from system_control_events",
      "insert into system_control_events (control_name, new_value, reason, changed_by, changed_at, version, event_type, change_mechanism, source_process, operator_context) values ('KILL_SWITCH_ACTIVE', false, 'forged', 'service:app', now(), 99, 'change', 'service', 'x', '{}')",
      "select 1 from claim_reviews",
      "update claim_review_cards set state = 'decided'",
    ]) expect(await asCode(sql), sql).toBe("42501");
    expect(await asCode("select control_name, value, version from system_controls")).toBe("ok");
  });
  it("cannot manage schema or bypass a guard: no ALTER, no DROP, no DISABLE TRIGGER, no CREATE, no role changes", async () => {
    for (const sql of [
      "alter table audit_events disable trigger audit_events_no_update_delete",
      "alter table audit_events disable trigger all",
      "drop trigger audit_events_no_truncate on audit_events",
      "alter table telegram_messages drop column raw_text",
      "alter table telegram_messages add column x int",
      "drop table audit_events",
      "create table app_made (a int)",
      "create trigger evil before insert on audit_events for each row execute function twins_audit_forbid_change()",
      "alter function twins_audit_chain_before_insert() security invoker",
      "create role other_role",
    ]) expect(await asCode(sql), sql).toBe("42501");
    expect(await asCode("set session_replication_role = replica")).toBe("42501"); // only superusers may change it
  });
  it("the privilege self-check flags a runtime role that has been given too much", async () => {
    await client.query("savepoint g");
    await client.query(`grant update on audit_events to ${ROLE}`);
    await client.query(`grant delete on telegram_messages to ${ROLE}`);
    const problems = await asApp(() => checkRuntimeRolePrivileges(client));
    expect(problems).toEqual(expect.arrayContaining(["can_update:audit_events", "can_delete:telegram_messages"]));
    const lines: string[] = [];
    let exitCode = -1;
    await asApp(() => enforceRuntimeRoleSeparation("test", client, { write: (l) => void lines.push(l), exit: ((c: number) => { exitCode = c; return undefined as never; }) }));
    expect(exitCode).toBe(82);
    expect(JSON.parse(must(lines[0]))).toMatchObject({ event: "audit.role_separation.refused", process: "test" });
    await client.query("rollback to savepoint g");
  });
});
