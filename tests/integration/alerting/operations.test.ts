/**
 * Operational alerting, dead-letter operations and the status surface against REAL PostgreSQL (disposable twins_ci target). Alerts are captured by a
 * test-owned sender; nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlerter, alertingSink, type AlertPayload } from "../../../packages/alerting/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { claimOutboxRow, PgIntakeOutbox, readOutboxRow } from "../../../packages/ingestion/src/index";
import { processOutboxQueueJob, reconcileOutbox } from "../../../services/worker/src/outbox";
import { main as deadLetter } from "../../../scripts/ops/outbox-deadletter";
import { main as safetyControl } from "../../../scripts/ops/safety-control";
import { main as verifyAudit } from "../../../scripts/ops/verify-audit-chain";
import { buildApp } from "../../support/apiWithTestPolicy";
import { DATABASE_URL, must, TEST_API_KEY, TEST_WEBHOOK_SECRET } from "../runtime/harness";

let pool: pg.Pool;
let handle: BoundedDbHandle;
const sent: AlertPayload[] = [];
const alerter = createAlerter({ context: { environment: "ci", service: "itest", build: "test-build" }, sender: { label: "test", send: async (p) => { sent.push(p); return true; } }, throttleMs: 0 });
const records: LogRecord[] = [];
const logger = createStructuredLogger(alertingSink((r) => records.push(r), alerter), { service: "itest" });

beforeAll(() => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  handle = createBoundedDb(DATABASE_URL, { max: 3, idleTimeoutMillis: 10_000 });
});
afterAll(async () => { await pool?.end(); await handle?.close(); });

async function seedRow(maxAttempts = 8, channel = `tg_chat_-100${Math.floor(Math.random() * 1e9)}`): Promise<string> {
  const r = await new PgIntakeOutbox(handle.db).record({ messageType: "message", intakeSource: "user_capture", sourceMessageId: String(Math.floor(Math.random() * 1e9)), channelId: channel, receivedAt: new Date(), maxAttempts, payload: { jobType: "telegram_messages", note: "synthetic" } });
  return r.id;
}
const lines = async (argv: string[], env: Record<string, string> = { DATABASE_URL }) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await deadLetter(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
};

describe("alerts raised by real events", () => {
  it("an outbox dead letter raises CRITICAL outbox.dead_lettered (ids and codes only, no payload)", async () => {
    const id = await seedRow(1);
    sent.length = 0;
    const result = await processOutboxQueueJob({ id: "j", data: { jobType: "telegram_outbox", outboxId: id } } as never, handle.db, { logger, runPipeline: () => Promise.reject(Object.assign(new Error("row values here: BUY RELIANCE"), { code: "BOOM" })), workerId: "t:1" });
    expect(result).toBe("dead_lettered");
    await alerter.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "outbox.dead_lettered", severity: "CRITICAL", code: "BOOM", service: "itest", build: "test-build" });
    expect(sent[0]?.details["outboxId"]).toBe(id);
    expect(JSON.stringify(sent)).not.toMatch(/RELIANCE|row values/);
  });
  it("a row approaching its retry limit raises a WARNING, far from the limit raises nothing", async () => {
    const id = await seedRow(3);
    sent.length = 0;
    const fail = () => Promise.reject(new Error("x"));
    const t0 = new Date("2031-05-01T00:00:00Z");
    await processOutboxQueueJob({ id: "j", data: { jobType: "telegram_outbox", outboxId: id } } as never, handle.db, { logger, runPipeline: fail, workerId: "t:1", now: () => t0, retryPolicy: { baseMs: 10, maxMs: 20 } });
    await alerter.flush();
    expect(sent.map((a) => a.event)).toEqual(["outbox.retry_threshold"]); // attempt 1 of 3 is within 2 of the limit
    expect(sent[0]).toMatchObject({ severity: "WARNING", details: { attempt: 1, maxAttempts: 3 } });
  });
  it("the reconciler recovering an expired lease raises a WARNING; rows that stay stuck raise CRITICAL outbox.stuck", async () => {
    const id = await seedRow();
    await claimOutboxRow(handle.db, id, "dead-worker:1");
    await seedRow(); // due since 'now' and never processed: by the injected clock it has been due for 10 minutes
    sent.length = 0;
    const later = new Date(Date.now() + 10 * 60_000);
    const queue = { add: async () => ({}) } as never;
    await reconcileOutbox(handle.db, { logger, queue, now: () => later, stuckAfterMs: 5 * 60_000 });
    await alerter.flush();
    expect(sent.map((a) => a.event)).toEqual(expect.arrayContaining(["outbox.stale_job_recovered", "outbox.stuck"]));
    expect(sent.find((a) => a.event === "outbox.stale_job_recovered")).toMatchObject({ severity: "WARNING", code: "lease_expired" });
    expect(sent.find((a) => a.event === "outbox.stuck")).toMatchObject({ severity: "CRITICAL" });
    expect(Number(sent.find((a) => a.event === "outbox.stuck")?.details["count"])).toBeGreaterThanOrEqual(1);
  });
  it("kill switch activation and trading enabled raise CRITICAL alerts from the real control change; clearing is INFO", async () => {
    const run = async (control: string, value: string) => {
      const out: string[] = [];
      const code = await safetyControl(["set", "--control", control, "--value", value, "--reason", `integration test: alert policy check ${randomUUID()}`, "--changed-by", "operator:itest"], { env: { DATABASE_URL }, out: (l) => out.push(l), err: () => undefined, logger, flush: () => alerter.flush() });
      expect(code).toBe(0);
    };
    void 0;
    sent.length = 0;
    try {
      await run("KILL_SWITCH_ACTIVE", "true");
      await run("KILL_SWITCH_ACTIVE", "false");
      await run("TRADING_ENABLED", "true");
    } finally {
      // never leave the shared test database with trading on or the kill switch active, even when an assertion above fails
      await run("TRADING_ENABLED", "false").catch(() => undefined);
      await run("KILL_SWITCH_ACTIVE", "false").catch(() => undefined);
    }
    const events = sent.map((a) => `${a.event}:${a.severity}`);
    expect(events).toContain("safety.kill_switch_activated:CRITICAL");
    expect(events).toContain("safety.trading_enabled:CRITICAL");
    expect(events.filter((e) => e.startsWith("safety.trading_enabled")).length).toBe(1); // switching it OFF is not an alert
    expect(sent.find((a) => a.event === "safety.kill_switch_activated")?.details).toMatchObject({ control: "KILL_SWITCH_ACTIVE", changedBy: "operator:itest" });
    const state = (await pool.query("select control_name, value from system_controls order by 1")).rows.map((r) => `${r.control_name}=${r.value}`);
    expect(state).toEqual(expect.arrayContaining(["KILL_SWITCH_ACTIVE=false", "TRADING_ENABLED=false"])); // restored
  });
  it("audit verification failures: a tampered chain raises audit.verification_failed, a disabled protection trigger raises audit.protection_failed (both CRITICAL, exit 1)", async () => {
    const attempt = async (tamper: (c: pg.PoolClient) => Promise<void>) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("insert into audit_events (id, event_type, entity_type, actor_type) values ($1, 'itest.alert', 'x', 'system')", [randomUUID()]);
        await tamper(c);
        sent.length = 0;
        const code = await verifyAudit(["--chain", "audit_events"], { env: { DATABASE_URL: "unused" }, out: () => undefined, err: () => undefined, alerter, open: () => ({ db: c, close: async () => undefined }) });
        return code;
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    const guard = (await pool.query("select tgname from pg_trigger where tgrelid = 'public.audit_events'::regclass and not tgisinternal and tgname like '%no_update_delete'")).rows[0]?.tgname as string;
    expect(guard).toBeTruthy();
    const code1 = await attempt(async (c) => {
      await c.query(`alter table audit_events disable trigger ${guard}`);
      await c.query("update audit_events set event_type = event_type || '-x' where chain_index = (select max(chain_index) from audit_events)");
      await c.query(`alter table audit_events enable always trigger ${guard}`);
    });
    expect(code1).toBe(1);
    expect(sent[0]).toMatchObject({ event: "audit.verification_failed", severity: "CRITICAL", code: "payload_modified" });
    const code2 = await attempt(async (c) => { await c.query(`alter table audit_events disable trigger ${guard}`); });
    expect(code2).toBe(1);
    expect(sent[0]).toMatchObject({ event: "audit.protection_failed", severity: "CRITICAL", code: "protection_missing" });
    // and a clean chain raises nothing
    sent.length = 0;
    expect(await verifyAudit(["--chain", "audit_events"], { env: { DATABASE_URL }, out: () => undefined, err: () => undefined, alerter })).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("dead-letter operations", () => {
  async function deadRow(): Promise<{ id: string; channel: string }> {
    const channel = `tg_chat_-100${Math.floor(Math.random() * 1e9)}`;
    const id = await seedRow(1, channel);
    await processOutboxQueueJob({ id: "j", data: { jobType: "telegram_outbox", outboxId: id } } as never, handle.db, { logger, runPipeline: () => Promise.reject(Object.assign(new Error("secret message text"), { code: "E_DEAD" })), workerId: "t:1" });
    expect((await readOutboxRow(handle.db, id))?.status).toBe("DEAD_LETTER");
    return { id, channel };
  }
  it("list and show print safe metadata only", async () => {
    const { id, channel } = await deadRow();
    const list = await lines(["list", "--limit", "500"]);
    expect(list.code).toBe(0);
    const row = list.out.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r["id"] === id);
    expect(row).toEqual({ id, channelId: channel, messageType: "message", intakeSource: "user_capture", status: "DEAD_LETTER", attemptCount: 1, maxAttempts: 1, lastErrorCode: "E_DEAD", receivedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(list.out.join("\n")).not.toMatch(/secret message text|raw_payload|rawPayload|payload|synthetic/);
    const show = await lines(["show", id]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out[0] as string)).toMatchObject({ id, replaysRecorded: 0 });
    expect((await lines(["show", randomUUID()])).code).toBe(3);
  });
  it("replay reopens exactly one row by id, records who/why in the replay log and a chained audit event, and the worker can process it again", async () => {
    const { id } = await deadRow();
    const other = await deadRow();
    const before = Number(must((await pool.query("select count(*)::int as n from audit_events where event_type = 'outbox.replayed'")).rows[0])["n"]);
    const r = await lines(["replay", "--id", id, "--reason", "integration test replay of one row", "--changed-by", "operator:itest"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0] as string)).toMatchObject({ event: "outbox.replayed", outboxId: id, changedBy: "operator:itest", previousAttemptCount: 1, previousErrorCode: "E_DEAD" });
    expect(await readOutboxRow(handle.db, id)).toMatchObject({ status: "PENDING", attemptCount: 0, enqueuedAt: null, lockedBy: null });
    expect((await readOutboxRow(handle.db, other.id))?.status).toBe("DEAD_LETTER"); // no other row is touched
    const log = (await pool.query("select * from telegram_intake_outbox_replays where outbox_id = $1", [id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ requested_by: "operator:itest", previous_attempt_count: 1, previous_last_error: "E_DEAD" });
    expect(Number(must((await pool.query("select count(*)::int as n from audit_events where event_type = 'outbox.replayed'")).rows[0])["n"])).toBe(before + 1);
    // it can be processed again, and a second replay of a non-dead row is refused
    const done = await processOutboxQueueJob({ id: "j", data: { jobType: "telegram_outbox", outboxId: id } } as never, handle.db, { logger, runPipeline: async () => undefined, workerId: "t:2" });
    expect(done).toBe("completed");
    expect((await lines(["replay", "--id", id, "--reason", "second replay should be refused", "--changed-by", "operator:itest"])).code).toBe(3);
  });
  it("is deliberately narrow: no bulk replay, no replay without an id, reason or operator identity, and the database refuses an un-recorded reopen", async () => {
    const { id } = await deadRow();
    for (const argv of [["replay"], ["replay", "--all"], ["replay", "--id", id], ["replay", "--id", id, "--reason", "short", "--changed-by", "operator:itest"], ["replay", "--id", id, "--reason", "a valid reason text", "--changed-by", "bob"], ["replay", "--id", "not-a-uuid", "--reason", "a valid reason text", "--changed-by", "operator:itest"], ["replay", id], ["list", "--status", "DEAD_LETTER"], ["nonsense"]]) {
      expect((await lines(argv)).code, JSON.stringify(argv)).toBe(2);
    }
    expect((await readOutboxRow(handle.db, id))?.status).toBe("DEAD_LETTER");
    // direct SQL: no replay record in this transaction => refused; a replay record from ANOTHER transaction does not count either
    await expect(pool.query("update telegram_intake_outbox set status = 'PENDING', attempt_count = 0 where id = $1", [id])).rejects.toThrow(/DEAD_LETTER is terminal/);
    await pool.query("insert into telegram_intake_outbox_replays (id, outbox_id, reason, requested_by, previous_attempt_count) values (gen_random_uuid(), $1, 'earlier unrelated replay', 'operator:itest', 1)", [id]);
    await expect(pool.query("update telegram_intake_outbox set status = 'PENDING', attempt_count = 0 where id = $1", [id])).rejects.toThrow(/DEAD_LETTER is terminal/);
    await expect(pool.query("update telegram_intake_outbox set last_error = 'x' where id = $1", [id])).rejects.toThrow();
    await expect(pool.query("update telegram_intake_outbox_replays set reason = 'changed afterwards' where outbox_id = $1", [id])).rejects.toThrow();
    await expect(pool.query("delete from telegram_intake_outbox_replays where outbox_id = $1", [id])).rejects.toThrow();
  });
});

describe("status surface GET /health/status", () => {
  it("requires the API key, and reports uptime, database, redis, runtime state, backup/audit timestamps and outbox counts without secrets or paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "twins-status-"));
    const okAt = Math.floor(Date.now() / 1000) - 3600;
    await writeFile(join(dir, "backup.json"), JSON.stringify({ ok: true, ts: "x", epoch: okAt, detail: "twins-staging-daily-20310101T000000Z.dump.enc" }));
    await writeFile(join(dir, "audit-verify.json"), JSON.stringify({ ok: false, epoch: okAt + 100, last_ok_epoch: okAt + 50, first_failure: null }));
    process.env["TWINS_STATUS_DIR"] = dir;
    const app = await buildApp({ apiKey: TEST_API_KEY, telegramWebhookSecret: TEST_WEBHOOK_SECRET, telegramQueue: { add: async () => ({}) } as never, db: handle.db, logger: false, structuredLogger: createStructuredLogger(() => undefined) });
    try {
      expect((await app.inject({ method: "GET", url: "/health/status" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/health/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
      const res = await app.inject({ method: "GET", url: "/health/status", headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(body).toMatchObject({ status: "ok", service: "api", database: { ok: true }, redis: { ok: "unknown" }, runtimeState: { available: true, TRADING_ENABLED: false, INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false } });
      expect(typeof body.uptimeSeconds).toBe("number");
      expect(body.lastSuccessfulBackupAt).toBe(new Date(okAt * 1000).toISOString());
      expect(body.lastSuccessfulAuditVerificationAt).toBe(new Date((okAt + 50) * 1000).toISOString()); // the last PASS, although the latest run failed
      expect(body.outbox).toMatchObject({ available: true });
      expect(Object.keys(body.outbox).sort()).toEqual(["available", "completed", "deadLetter", "pending", "processing"]);
      const text = res.body;
      expect(text).not.toMatch(/postgres|password|secret|\/tmp|twins-status|stack|at .*\(|DATABASE_URL|\.json/i);
      // the unauthenticated endpoint stays minimal
      expect(Object.keys((await app.inject({ method: "GET", url: "/health" })).json() as object).sort()).toEqual(["appEnv", "liveTradingEnabled", "service", "status", "tradingMode"]);
    } finally {
      delete process.env["TWINS_STATUS_DIR"];
      await app.close();
    }
    void schema;
  });
});
