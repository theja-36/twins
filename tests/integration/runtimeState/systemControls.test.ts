/**
 * Runtime safety state against REAL PostgreSQL and Redis (Stage 1 / Task 2): the migration, the triggers, concurrent changes, fail-closed
 * behaviour of the real reader, and a real BullMQ worker that must hold a queued job - without losing it or consuming an attempt - while the
 * kill switch is active. Every test that mutates the controls lives in THIS file (files run in parallel; the controls are global), and the
 * controls are restored to their defaults at the end. The events table is append-only, so the audit rows this file creates remain.
 */
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RuntimeState,
  changeControl,
  configureRuntimeState,
  pgStateSource,
  readControlEvents,
  readControlStatus,
  type ControlName,
  type Queryable,
} from "../../../packages/runtime-state/src/index";
import { schema, createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { marketDataProviders, YAHOO_PROVIDER_NAME } from "../../../adapters/market/src/index";
import { withIntakeGate } from "../../../services/worker/src/safetyGate";
import { processSignalQueueJob } from "../../support/workerWithTestPolicy";
import { buildApp } from "../../support/apiWithTestPolicy";
import type { SignalQueueJobPayload as TelegramJobPayload } from "../../../services/worker/src/index";
import { requireTestDatabaseUrl, requireTestRedisUrl } from "../targetConfig";
import { main as safetyControlCli } from "../../../scripts/ops/safety-control";
import { TEST_API_KEY, TEST_WEBHOOK_SECRET, syntheticMarketProvider, telegramWebhookPayload, uniqueChatId, waitFor, webhookHeaders, must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const REDIS_URL = requireTestRedisUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 12 });
const NAMES: ControlName[] = ["INTAKE_ENABLED", "KILL_SWITCH_ACTIVE", "TRADING_ENABLED"];
const uniq = (what: string) => `${what} ${randomUUID().slice(0, 8)}`;
const by = "service:itest-runner";

async function setControl(control: ControlName, value: boolean, reason = uniq("integration test")) {
  return changeControl(pool, { control, value, reason, changedBy: by, mechanism: "service", sourceProcess: "itest" });
}
async function restoreDefaults() {
  await setControl("KILL_SWITCH_ACTIVE", false);
  await setControl("TRADING_ENABLED", false);
  await setControl("INTAKE_ENABLED", true);
}
async function sqlCode(sql: string, params: unknown[] = []): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(sql, params);
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
const countEvents = async () => Number((await pool.query("select count(*) as n from system_control_events")).rows[0]?.n);

beforeAll(async () => {
  await restoreDefaults();
});
afterAll(async () => {
  await restoreDefaults();
  await pool.end();
});

describe("migration 0009: seeded defaults and audit", () => {
  it("holds exactly the three controls, each with a seed event that records the documented default", async () => {
    const rows = (await pool.query("select control_name from system_controls order by control_name")).rows.map((r) => r.control_name);
    expect(rows).toEqual(NAMES);
    const seeds = (await pool.query("select control_name, previous_value, new_value, version, changed_by, event_type from system_control_events where event_type = 'seed' order by control_name")).rows;
    expect(seeds).toEqual([
      { control_name: "INTAKE_ENABLED", previous_value: null, new_value: true, version: "1", changed_by: "migration", event_type: "seed" },
      { control_name: "KILL_SWITCH_ACTIVE", previous_value: null, new_value: false, version: "1", changed_by: "migration", event_type: "seed" },
      { control_name: "TRADING_ENABLED", previous_value: null, new_value: false, version: "1", changed_by: "migration", event_type: "seed" },
    ]);
  });
  it("after restoring defaults the live state is: trading off, intake on, kill switch off", async () => {
    const status = Object.fromEntries((await readControlStatus(pool)).map((c) => [c.control, c.value]));
    expect(status).toEqual({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false, TRADING_ENABLED: false });
  });
});

describe("database-level integrity (even the owner using raw SQL cannot skip the rules or the audit)", () => {
  const base = (set: string) => `update system_controls set ${set} where control_name = 'INTAKE_ENABLED'`;
  it("rejects a change that does not bump the version by exactly 1, does not flip the value, or reuses the reason (SQLSTATE 23001)", async () => {
    expect(await sqlCode(base("value = false"))).toBe("23001"); // version not bumped
    expect(await sqlCode(base("value = false, version = version + 2, reason = 'a brand new reason'"))).toBe("23001");
    expect(await sqlCode(base("version = version + 1, reason = 'a brand new reason'"))).toBe("23001"); // value not flipped
    expect(await sqlCode(base("value = false, version = version + 1"))).toBe("23001"); // reason not renewed
    expect(await sqlCode("update system_controls set control_name = 'TRADING_ENABLED', value = true, version = version + 1, reason = 'renamed row' where control_name = 'INTAKE_ENABLED'")).toBe("23001");
  });
  it("enforces reason and changed_by through CHECK constraints (23514)", async () => {
    expect(await sqlCode(base("value = false, version = version + 1, reason = 'short'"))).toBe("23514");
    expect(await sqlCode(base("value = false, version = version + 1, reason = '          '"))).toBe("23514");
    expect(await sqlCode(base("value = false, version = version + 1, reason = 'a valid reason here', changed_by = 'x'"))).toBe("23514");
    expect(await sqlCode(base("value = false, version = version + 1, reason = 'a valid reason here', changed_by = 'bad actor!'"))).toBe("23514");
  });
  it("rows are permanent and there are exactly three: no delete, no truncate, no duplicate, no unknown control", async () => {
    expect(await sqlCode("delete from system_controls")).toBe("23001");
    expect(await sqlCode("delete from system_controls where control_name = 'KILL_SWITCH_ACTIVE'")).toBe("23001");
    expect(await sqlCode("truncate system_controls")).toBe("23001");
    expect(await sqlCode("insert into system_controls (control_name, value, reason, changed_by) values ('KILL_SWITCH_ACTIVE', false, 'duplicate row attempt', 'itest.runner')")).toBe("23505");
    expect(await sqlCode("insert into system_controls (control_name, value, reason, changed_by) values ('LIVE_TRADING', true, 'unknown control attempt', 'itest.runner')")).toBe("23514");
  });
  it("the audit table is append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    expect(await sqlCode("update system_control_events set reason = 'tampered with the audit'")).toBe("23001");
    expect(await sqlCode("delete from system_control_events")).toBe("23001");
    expect(await sqlCode("truncate system_control_events")).toBe("23001");
  });
  it("a valid raw UPDATE still produces the audit event itself (trigger), and changed_at is server-stamped (cannot be back-dated)", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const reason = uniq("raw sql change");
      await client.query("update system_controls set value = false, version = version + 1, reason = $1, changed_by = 'itest.raw', changed_at = '1999-01-01' where control_name = 'INTAKE_ENABLED'", [reason]);
      const ev = (await client.query("select previous_value, new_value, reason, changed_by, changed_at, event_type from system_control_events where reason = $1", [reason])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ previous_value: true, new_value: false, changed_by: "itest.raw", event_type: "change" });
      expect(Math.abs(Date.now() - new Date(must(ev[0]).changed_at as string).getTime())).toBeLessThan(60_000);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});

describe("changeControl against the real database", () => {
  it("records previous value, new value, reason, changed_by and changed_at in an immutable event, and bumps the version", async () => {
    const before = await readControlStatus(pool);
    const kill0 = must(before.find((c) => c.control === "KILL_SWITCH_ACTIVE"));
    const reason = uniq("activate for the audit test");
    const r = await changeControl(pool, { control: "KILL_SWITCH_ACTIVE", value: true, reason, changedBy: by, mechanism: "service" as const, sourceProcess: "itest", expectedVersion: kill0.version });
    expect(r).toMatchObject({ changed: true, previousValue: false, newValue: true, version: kill0.version + 1 });
    const [event] = (await readControlEvents(pool, 50)).filter((e) => e.reason === reason);
    expect(event).toMatchObject({ controlName: "KILL_SWITCH_ACTIVE", previousValue: false, newValue: true, changedBy: by, version: kill0.version + 1, eventType: "change" });
    expect(Math.abs(Date.now() - must(event).changedAt.getTime())).toBeLessThan(60_000);
    const status = must((await readControlStatus(pool)).find((c) => c.control === "KILL_SWITCH_ACTIVE"));
    expect(status).toMatchObject({ value: true, reason, changedBy: by });
    // the event can no longer be altered or removed, even by the owner
    expect(await sqlCode("update system_control_events set new_value = false where reason = $1", [reason])).toBe("23001");
  });
  it("refuses to enable trading while the kill switch is active; allows it once cleared; a no-op records no event", async () => {
    await expect(setControl("TRADING_ENABLED", true)).rejects.toMatchObject({ name: "ControlChangeRefusedError", code: "kill_switch_active" });
    await setControl("KILL_SWITCH_ACTIVE", false);
    const n0 = await countEvents();
    expect((await setControl("KILL_SWITCH_ACTIVE", false)).changed).toBe(false);
    expect(await countEvents()).toBe(n0);
    expect((await setControl("TRADING_ENABLED", true)).changed).toBe(true);
    await setControl("TRADING_ENABLED", false);
  });
  it("a stale expectedVersion is refused and writes nothing", async () => {
    const n0 = await countEvents();
    const current = must((await readControlStatus(pool)).find((c) => c.control === "INTAKE_ENABLED")).version;
    await expect(changeControl(pool, { control: "INTAKE_ENABLED", value: false, reason: uniq("stale cas"), changedBy: by, mechanism: "service" as const, sourceProcess: "itest", expectedVersion: current + 7 })).rejects.toMatchObject({ name: "StaleControlVersionError" });
    expect(await countEvents()).toBe(n0);
  });
});

describe("concurrent state updates", () => {
  it("12 simultaneous changes to one control serialize: every success has exactly one event and the events form an unbroken chain", async () => {
    const start = must((await readControlStatus(pool)).find((c) => c.control === "INTAKE_ENABLED"));
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => setControl("INTAKE_ENABLED", i % 2 === 0 ? false : true, uniq(`concurrent ${i}`))));
    const changed = results.filter((r) => r.changed);
    const events = (await pool.query("select version, previous_value, new_value from system_control_events where control_name = 'INTAKE_ENABLED' and version > $1 order by version", [start.version])).rows;
    expect(events).toHaveLength(changed.length);
    expect(changed.length).toBeGreaterThan(0);
    let prevVersion = start.version;
    let prevValue = start.value;
    for (const e of events) {
      expect(Number(e.version)).toBe(prevVersion + 1); // no gap, no duplicate
      expect(e.previous_value).toBe(prevValue); // each event starts where the last ended
      expect(e.new_value).toBe(!prevValue); // and flips
      prevVersion = Number(e.version);
      prevValue = e.new_value as boolean;
    }
    const finalNow = must((await readControlStatus(pool)).find((c) => c.control === "INTAKE_ENABLED"));
    expect(finalNow).toMatchObject({ version: prevVersion, value: prevValue });
    await restoreDefaults();
  });
  it("enabling trading racing the kill switch never leaves trading enabled after the kill switch took effect first", async () => {
    for (let round = 0; round < 8; round++) {
      await restoreDefaults();
      const [enable, kill] = await Promise.allSettled([
        setControl("TRADING_ENABLED", true, uniq(`race enable ${round}`)),
        setControl("KILL_SWITCH_ACTIVE", true, uniq(`race kill ${round}`)),
      ]);
      expect(kill.status).toBe("fulfilled");
      if (enable.status === "rejected") expect(enable.reason).toMatchObject({ code: "kill_switch_active" }); // the kill switch won the lock
      const status = Object.fromEntries((await readControlStatus(pool)).map((c) => [c.control, c]));
      expect(must(status["KILL_SWITCH_ACTIVE"]).value).toBe(true);
      if (enable.status === "fulfilled") expect(must(status["TRADING_ENABLED"]).changedAt.getTime()).toBeLessThanOrEqual(must(status["KILL_SWITCH_ACTIVE"]).changedAt.getTime()); // enabled strictly before the kill
      else expect(must(status["TRADING_ENABLED"]).value).toBe(false);
    }
    await restoreDefaults();
  });
});

describe("operations CLI against the real database", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await safetyControlCli(argv, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => err.push(l), openPool: () => ({ pool, close: async () => undefined }) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  it("status lists the three controls; set changes one and writes an event naming the reason and identity; events shows it", async () => {
    const status = await run(["status"]);
    expect(status.code).toBe(0);
    for (const n of NAMES) expect(status.out).toContain(`${n}=`);
    const reason = uniq("cli change");
    const set = await run(["set", "--control", "INTAKE_ENABLED", "--value", "false", "--reason", reason, "--changed-by", "operator:itest-cli"]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("changed INTAKE_ENABLED: true -> false");
    const ev = await run(["events", "--limit", "5"]);
    expect(ev.out).toContain(reason);
    expect(ev.out).toContain("by operator:itest-cli");
    expect((await run(["set", "--control", "INTAKE_ENABLED", "--value", "true", "--reason", uniq("cli restore"), "--changed-by", "operator:itest-cli"])).code).toBe(0);
  });
  it("a refused change exits 3 and writes nothing; a missing reason exits 2 before any connection", async () => {
    await setControl("KILL_SWITCH_ACTIVE", true);
    const n0 = await countEvents();
    const refused = await run(["set", "--control", "TRADING_ENABLED", "--value", "true", "--reason", uniq("cli refused"), "--changed-by", "operator:itest-cli"]);
    expect(refused.code).toBe(3);
    expect(await countEvents()).toBe(n0);
    expect((await run(["set", "--control", "KILL_SWITCH_ACTIVE", "--value", "false", "--changed-by", "operator:itest-cli"])).code).toBe(2);
    await restoreDefaults();
  });
});

describe("the real reader fails closed", () => {
  const live = () => new RuntimeState({ source: pgStateSource(pool), ttlMs: 0, failureTtlMs: 0, timeoutMs: 1500 });

  it("reads the real controls and reflects a change immediately with forceRefresh", async () => {
    const state = new RuntimeState({ source: pgStateSource(pool), ttlMs: 5000, timeoutMs: 1500 });
    expect(await state.isIntakeEnabled()).toBe(true);
    expect(await state.isTradingEnabled()).toBe(false);
    await setControl("INTAKE_ENABLED", false);
    expect(await state.isIntakeEnabled()).toBe(true); // cached within the TTL
    await state.forceRefresh();
    expect(await state.isIntakeEnabled()).toBe(false);
    await setControl("INTAKE_ENABLED", true);
  });
  it("kill switch active: every assertion refuses, with trading and intake enabled", async () => {
    await setControl("TRADING_ENABLED", true);
    await setControl("KILL_SWITCH_ACTIVE", true);
    const state = live();
    for (const f of [() => state.assertIntakeEnabled("it"), () => state.assertTradingEnabled("it"), () => state.assertKillSwitchInactive("it")]) await expect(f()).rejects.toMatchObject({ reason: "kill_switch_active" });
    await restoreDefaults();
  });
  it("database unavailable (nothing listening): refuses with state_unavailable/query_failed", async () => {
    const dead = new pg.Pool({ connectionString: "postgresql://twins_ci:x@127.0.0.1:1/twins_ci", connectionTimeoutMillis: 500 });
    dead.on("error", () => undefined);
    const state = new RuntimeState({ source: pgStateSource(dead), ttlMs: 0, failureTtlMs: 0, timeoutMs: 1500 });
    await expect(state.assertIntakeEnabled("it")).rejects.toMatchObject({ reason: "state_unavailable" });
    expect(await state.isKillSwitchActive()).toBe(true);
    await dead.end();
  });
  it("query timeout (a read that takes 3 s against a 200 ms bound): refuses quickly with timeout", async () => {
    const slow: Queryable = { query: (text) => pool.query(`select pg_sleep(3), 1 where $1::text is not null`, [text]) as never };
    const state = new RuntimeState({ source: pgStateSource(slow), ttlMs: 0, failureTtlMs: 0, timeoutMs: 200 });
    const started = Date.now();
    const refusal = await state.assertTradingEnabled("it").then(() => null, (e: { reason: string; cause?: { reason: string } }) => e);
    expect(refusal).toMatchObject({ reason: "state_unavailable", cause: { reason: "timeout" } });
    expect(Date.now() - started).toBeLessThan(2500);
  });
  it("missing state row: refuses when a control row is absent (removed inside a rolled-back transaction with the guard trigger disabled)", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("alter table system_controls disable trigger system_controls_no_delete");
      await client.query("delete from system_controls where control_name = 'KILL_SWITCH_ACTIVE'");
      const state = new RuntimeState({ source: pgStateSource(client), ttlMs: 0, failureTtlMs: 0, timeoutMs: 1500 });
      await expect(state.assertKillSwitchInactive("it")).rejects.toMatchObject({ reason: "state_unavailable", cause: { reason: "missing_row", detail: "KILL_SWITCH_ACTIVE" } });
      await expect(state.assertIntakeEnabled("it")).rejects.toMatchObject({ reason: "state_unavailable" });
      expect(await state.isKillSwitchActive()).toBe(true);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    expect(Number((await pool.query("select count(*) as n from system_controls")).rows[0]?.n)).toBe(3);
    expect(await sqlCode("delete from system_controls")).toBe("23001"); // the trigger is enabled again
  });
});

describe("kill switch end to end: API -> Redis -> worker -> PostgreSQL", () => {
  let queueName: string;
  let queue: Queue;
  let events: QueueEvents;
  let workerRedis: Redis;
  let producerRedis: Redis;
  let eventsRedis: Redis;
  let dbHandle: BoundedDbHandle;
  let worker: Worker<TelegramJobPayload> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    queueName = `r0b_test_kill_${randomUUID().replace(/-/g, "")}`;
    dbHandle = createBoundedDb({ url: DATABASE_URL, max: 4, idleTimeoutMillis: 10_000 });
    marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);
    producerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    workerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    eventsRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection: producerRedis });
    events = new QueueEvents(queueName, { connection: eventsRedis });
    await queue.waitUntilReady();
    await events.waitUntilReady();
    app = await buildApp({ apiKey: TEST_API_KEY, telegramWebhookSecret: TEST_WEBHOOK_SECRET, telegramQueue: queue, db: dbHandle.db });
    // This process now uses the REAL database state (uncached), exactly like the production processes.
    configureRuntimeState({ source: pgStateSource(pool), ttlMs: 0, failureTtlMs: 0 });
  });
  afterAll(async () => {
    await worker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await events?.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    for (const r of [producerRedis, workerRedis, eventsRedis]) await r?.quit().catch(() => undefined);
    await dbHandle?.close().catch(() => undefined);
  });

  it("a paused API refuses new intake; a job queued earlier is held by the worker (not lost, no attempt consumed, nothing written) and processed once the kill switch is cleared", async () => {
    const updateId = Math.floor(Math.random() * 1_000_000_000);
    const messageId = Math.floor(Math.random() * 1_000_000_000);
    const chatId = uniqueChatId();
    const payload = telegramWebhookPayload(updateId, messageId, `r0b_test_channel_${updateId}`, chatId);
    const channel = `tg_chat_${chatId}`;
    const outboxRows = () => dbHandle.db.select().from(schema.telegramIntakeOutbox).where(eq(schema.telegramIntakeOutbox.sourceMessageId, String(messageId)));

    // 1. healthy: the webhook writes the durable outbox row, then enqueues its id (no worker is running yet, so the job waits in Redis)
    const accepted = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload });
    expect(accepted.statusCode).toBe(202);
    const row = must((await outboxRows())[0]);
    expect(row.channelId).toBe(channel);
    const jobId = `outbox-${row.id}-0`;
    expect(await queue.getJob(jobId)).toBeTruthy();

    // 2. kill switch on: new intake is refused at the API with 503 and nothing is enqueued
    await setControl("KILL_SWITCH_ACTIVE", true, uniq("kill switch end-to-end test"));
    const second = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload: telegramWebhookPayload(updateId + 1, messageId + 1, `r0b_test_channel_${updateId}`, chatId) });
    expect(second.statusCode).toBe(503);
    expect(second.json()).toMatchObject({ error: "intake_paused", reason: "kill_switch_active" });
    expect(await dbHandle.db.select().from(schema.telegramIntakeOutbox).where(eq(schema.telegramIntakeOutbox.sourceMessageId, String(messageId + 1)))).toHaveLength(0); // refused intake leaves no outbox row

    // 3. start the worker with the real gate: the earlier job must be held, untouched
    let invocations = 0;
    worker = new Worker<TelegramJobPayload>(
      queueName,
      withIntakeGate(
        async (job: Job<TelegramJobPayload>) => {
          invocations += 1;
          await processSignalQueueJob(job, undefined, dbHandle.db, { analysisMarket: { source: "r0b-synthetic", timeframe: "1d", context: "synthetic" } });
        },
        () => worker ?? null,
        { pauseMs: 300 },
      ),
      { connection: workerRedis, concurrency: 1 },
    );
    await worker.waitUntilReady();
    await new Promise((r) => setTimeout(r, 2000));
    const held = must(await queue.getJob(jobId));
    expect(["waiting", "delayed", "prioritized"]).toContain(await held.getState());
    expect(held.attemptsMade).toBe(0); // the refusal did not consume an attempt
    expect(held.failedReason).toBeFalsy();
    expect(invocations).toBeGreaterThan(0); // the worker did take it and refuse it, repeatedly
    expect(await dbHandle.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.externalMessageId, String(messageId)))).toHaveLength(0);
    expect(must((await outboxRows())[0])).toMatchObject({ status: "PENDING", attemptCount: 0, lockedBy: null }); // the row was never claimed while the kill switch was active

    // 4. clear the kill switch: the SAME job completes and is persisted
    await setControl("KILL_SWITCH_ACTIVE", false, uniq("clear kill switch end-to-end test"));
    await waitFor(async () => ((await (await queue.getJob(jobId))?.getState()) === "completed" ? true : undefined), 30_000, "held job to complete after the kill switch was cleared");
    const rows = await dbHandle.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.externalMessageId, String(messageId)));
    expect(rows).toHaveLength(1);
    expect(must(await queue.getJob(jobId)).attemptsMade).toBe(1);
    expect(must((await outboxRows())[0])).toMatchObject({ status: "COMPLETED", attemptCount: 1 });
    // existing records stayed readable the whole time (the select above ran while/after the switch was active)
  }, 90_000);

  it("intake disabled alone (kill switch off) also holds the job; the database being unreachable holds it too (fail closed)", async () => {
    const chatId = uniqueChatId();
    const messageId = Math.floor(Math.random() * 1_000_000_000);
    const updateId = Math.floor(Math.random() * 1_000_000_000);
    await worker?.close();
    worker = undefined;
    await setControl("INTAKE_ENABLED", false, uniq("intake off end-to-end test"));
    const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload: telegramWebhookPayload(updateId, messageId, `r0b_test_channel_${updateId}`, chatId) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "intake_disabled" });
    await setControl("INTAKE_ENABLED", true, uniq("intake on end-to-end test"));
    // unreadable state: the API cannot establish that intake is allowed, so it refuses
    configureRuntimeState({ source: pgStateSource(new pg.Pool({ connectionString: "postgresql://twins_ci:x@127.0.0.1:1/twins_ci", connectionTimeoutMillis: 300 }).on("error", () => undefined)), ttlMs: 0, failureTtlMs: 0, timeoutMs: 1000 });
    const down = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload: telegramWebhookPayload(updateId + 1, messageId + 1, `r0b_test_channel_${updateId}`, chatId) });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ reason: "state_unavailable" });
    configureRuntimeState({ source: pgStateSource(pool), ttlMs: 0, failureTtlMs: 0 });
    expect(await queue.getJob(`tg-tg_chat_${chatId}-${messageId}`)).toBeFalsy();
    expect(await dbHandle.db.select().from(schema.telegramIntakeOutbox).where(eq(schema.telegramIntakeOutbox.channelId, `tg_chat_${chatId}`))).toHaveLength(0); // nothing was accepted while intake was off or the state unreadable
  }, 60_000);
});
