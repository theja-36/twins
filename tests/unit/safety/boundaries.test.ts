import { describe, expect, it, vi } from "vitest";
import { Worker } from "bullmq";
import { INTAKE_PAUSE_MS, withIntakeGate } from "../../../services/worker/src/safetyGate";
import { runScheduledJob } from "../../../services/scheduler/src/scheduledJob";
import { processTelegramEventsQueueJob, processTelegramQueueJob } from "../../../services/worker/src/index";
import { createSignalFromTelegramMessage, recordOptionsIntake, reparseTelegramMessage } from "../../../packages/signals/src/index";
import { validateSignal } from "../../../packages/decision-intelligence/src/index";
import { buildApp } from "../../../apps/api/src/index";
import { INTERNAL_INGEST_PATH } from "../../../apps/api/src/internalIngest";
import { createTelegramIntakePolicy } from "../../../adapters/telegram/src/index";
import { configureRuntimeState, inMemoryStateSource, SafetyRefusalError, type ControlName, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { ApprovalBot } from "../../../services/approval-bot/src/bot";
import { createLogger } from "../../../services/approval-bot/src/log";
import { FakeBotApi, MemoryBotDb, TestClock, makeClaim, silentLogger, testConfig } from "../../support/approvalBotFakes";
import { must } from "../../support/must";

/** Installs a fresh, uncached in-memory state for the test and returns it. */
function use(initial: Partial<Record<ControlName, boolean>> = {}): InMemoryStateSource {
  const source = inMemoryStateSource(initial);
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
  return source;
}
/** A database handle that fails the test if anything touches it: proves a refusal happens BEFORE any read or write. */
const untouchableDb = () =>
  new Proxy({}, { get: (_t, prop) => { throw new Error(`database touched (${String(prop)}) despite a safety refusal`); } }) as never;

/** The three states that must stop intake-class operations, with the reason each reports. */
const INTAKE_STOPS: Array<[string, (s: InMemoryStateSource) => void, string]> = [
  ["intake disabled", (s) => s.set({ INTAKE_ENABLED: false }), "intake_disabled"],
  ["kill switch active", (s) => s.set({ KILL_SWITCH_ACTIVE: true }), "kill_switch_active"],
  ["state unreadable", (s) => s.failWith(new Error("db down")), "state_unavailable"],
];

describe("worker intake boundary", () => {
  const job = { id: "j1", data: { jobType: "telegram_messages" } } as never;

  it.each(INTAKE_STOPS)("processTelegramQueueJob refuses before touching anything: %s", async (_n, stop, reason) => {
    stop(use());
    await expect(processTelegramQueueJob(job, undefined, untouchableDb())).rejects.toMatchObject({ name: "SafetyRefusalError", reason, operation: "worker.telegram_job" });
  });
  it.each(INTAKE_STOPS)("processTelegramEventsQueueJob (observed deletions) refuses too: %s", async (_n, stop, reason) => {
    stop(use());
    await expect(processTelegramEventsQueueJob(job, undefined, untouchableDb())).rejects.toMatchObject({ reason, operation: "worker.telegram_events_job" });
  });

  it("withIntakeGate turns a refusal into a rate-limit + RateLimitError (job returns to the queue, no attempt consumed), never a failure", async () => {
    const rateLimit = vi.fn(async () => undefined);
    const warnings: LogRecord[] = [];
    const logger = createStructuredLogger((r) => warnings.push(r));
    const gated = withIntakeGate(async () => { throw new SafetyRefusalError("worker.telegram_job", "kill_switch_active"); }, () => ({ rateLimit }), { logger });
    await expect(gated(job)).rejects.toMatchObject({ message: Worker.RateLimitError().message });
    expect(rateLimit).toHaveBeenCalledWith(INTAKE_PAUSE_MS);
    expect(warnings[0]).toMatchObject({ event: "worker.intake.paused", reason: "kill_switch_active", pauseMs: INTAKE_PAUSE_MS });
  });
  it("withIntakeGate passes real failures through untouched, so normal attempts/backoff still apply", async () => {
    const rateLimit = vi.fn();
    const boom = new Error("real failure");
    await expect(withIntakeGate(async () => { throw boom; }, () => ({ rateLimit }))(job)).rejects.toBe(boom);
    expect(rateLimit).not.toHaveBeenCalled();
    await expect(withIntakeGate(async () => undefined, () => ({ rateLimit }))(job)).resolves.toBeUndefined();
  });
  it("withIntakeGate without a worker handle surfaces the refusal instead of swallowing it", async () => {
    const refusal = new SafetyRefusalError("x", "intake_disabled");
    await expect(withIntakeGate(async () => { throw refusal; }, () => null)(job)).rejects.toBe(refusal);
  });
});

describe("signal parser / claim creation boundary", () => {
  it.each(INTAKE_STOPS)("createSignalFromTelegramMessage, reparseTelegramMessage and recordOptionsIntake refuse before any database access: %s", async (_n, stop, reason) => {
    stop(use());
    const db = untouchableDb();
    await expect(createSignalFromTelegramMessage(db, "m1", { exchange: "NSE", instrumentType: "equity" })).rejects.toMatchObject({ reason, operation: "signals.createSignalFromTelegramMessage" });
    await expect(reparseTelegramMessage(db, "m1", { exchange: "NSE", instrumentType: "equity", parserVersion: "telegram-regex-v2" })).rejects.toMatchObject({ reason, operation: "signals.reparseTelegramMessage" });
    await expect(recordOptionsIntake(db, { telegramMessageId: "m1", parserVersion: "v", intake: { kind: "ambiguous", directives: [] } as never, assessment: undefined, master: null, premium: null })).rejects.toMatchObject({ reason, operation: "signals.recordOptionsIntake" });
  });
});

describe("decision creation boundary", () => {
  it("validateSignal refuses with the kill switch active or the state unreadable, before any database access", async () => {
    use({ KILL_SWITCH_ACTIVE: true });
    await expect(validateSignal(untouchableDb(), "s1")).rejects.toMatchObject({ reason: "kill_switch_active", operation: "decision.validateSignal" });
    use().failWith(new Error("down"));
    await expect(validateSignal(untouchableDb(), "s1")).rejects.toMatchObject({ reason: "state_unavailable" });
  });
});

describe("API intake boundaries (webhook and internal capture endpoint)", () => {
  const SECRET = "boundary-webhook-secret-0123456789";
  const TOKEN = "cap-0123456789abcdefghijklmnopqrstuvwxyz-XYZ";
  const CHAT = -1001000000001;
  async function make() {
    const add = vi.fn(async () => ({ id: "x" }));
    const records: LogRecord[] = [];
    const app = await buildApp({
      apiKey: "boundary-api-key-0123456789",
      telegramWebhookSecret: SECRET,
      telegramQueue: { add, getJob: async () => undefined } as never,
      telegramIntakePolicy: createTelegramIntakePolicy({ allowedChatIds: String(CHAT) }),
      structuredLogger: createStructuredLogger((r) => records.push(r)),
      captureIngestToken: TOKEN,
    } as never);
    const webhook = () => app.inject({ method: "POST", url: "/webhooks/telegram", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, payload: { update_id: 1, message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "channel", username: "u" }, text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900" } } as never });
    const ingest = () => app.inject({ method: "POST", url: INTERNAL_INGEST_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, payload: JSON.stringify({ schemaVersion: 1, captureMethod: "api_live", event: "message", chat: { id: CHAT, type: "channel", title: "T" }, messages: [{ id: 9, date: Math.floor(Date.now() / 1000) - 5, text: "BUY NIFTY 24500 CE" }] }) });
    return { app, add, records, webhook, ingest };
  }

  it("accepts while intake is enabled (control)", async () => {
    use();
    const { webhook, ingest, add } = await make();
    expect((await webhook()).statusCode).toBe(202);
    expect((await ingest()).statusCode).toBe(200);
    expect(add).toHaveBeenCalledTimes(2);
  });
  it.each(INTAKE_STOPS)("returns 503 + Retry-After and enqueues nothing: %s", async (_n, stop, reason) => {
    stop(use());
    const { webhook, ingest, add, records } = await make();
    for (const call of [webhook, ingest]) {
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("30");
      expect(res.json()).toEqual({ error: "intake_paused", reason });
    }
    expect(add).not.toHaveBeenCalled();
    expect(records.some((r) => r.event === "api.intake.paused")).toBe(true);
  });
  it("the pause only applies to authenticated callers: a wrong secret or token still gets the normal 403/401, never state information", async () => {
    use({ KILL_SWITCH_ACTIVE: true });
    const { app, add } = await make();
    const badWebhook = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, payload: { update_id: 1 } as never });
    expect(badWebhook.statusCode).toBe(403);
    const badIngest = await app.inject({ method: "POST", url: INTERNAL_INGEST_PATH, headers: { "content-type": "application/json", authorization: "Bearer wrong" }, payload: "{}" });
    expect(badIngest.statusCode).toBe(401);
    expect(JSON.stringify([badWebhook.json(), badIngest.json()])).not.toMatch(/kill|intake_paused|safety/i);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("approval bot boundaries (card creation and approval persistence)", () => {
  async function bot() {
    const clock = new TestClock();
    const db = new MemoryBotDb(clock);
    const api = new FakeBotApi();
    const out = silentLogger();
    const b = new ApprovalBot({ cfg: testConfig(), api, db, log: createLogger(out.write, () => clock.ms), now: clock.now, sleep: async (ms) => clock.advance(ms / 1000) });
    await b.startup(async () => true, true);
    clock.advance(10);
    const claim = makeClaim(clock);
    db.claims.push(claim);
    return { clock, db, api, b, claim };
  }

  it("card creation stops with the kill switch active or the state unreadable; nothing is created or sent; existing records stay", async () => {
    for (const stop of [(s: InMemoryStateSource) => s.set({ KILL_SWITCH_ACTIVE: true }), (s: InMemoryStateSource) => s.failWith(new Error("down"))]) {
      const s = use();
      stop(s);
      const x = await bot();
      const r = await x.b.runCycle(0);
      expect(r.sent).toBe(0);
      expect(x.db.cards.size).toBe(0);
      expect(x.api.sent).toHaveLength(0);
      expect(x.db.claims).toHaveLength(1); // the record is untouched and readable
      expect(x.db.eventTypes().some((t) => t.startsWith("safety_refused:card_creation"))).toBe(true);
    }
  });
  it("card creation still works while trading is disabled (cards are record-only review) and while intake is disabled", async () => {
    use({ TRADING_ENABLED: false, INTAKE_ENABLED: false });
    const x = await bot();
    expect((await x.b.runCycle(0)).sent).toBe(1);
  });
  it("an APPROVE is not persisted while the kill switch is active or the state is unreadable; a REJECT still is", async () => {
    for (const [name, stop] of [["kill switch", (s: InMemoryStateSource) => s.set({ KILL_SWITCH_ACTIVE: true })], ["unreadable", (s: InMemoryStateSource) => s.failWith(new Error("down"))]] as const) {
      const s = use();
      const x = await bot();
      await x.b.runCycle(0); // card sent while healthy
      const buttons = must(must(x.api.sent[0]).buttons);
      stop(s);
      x.api.inbox.push(x.api.tap(20, must(buttons[0]).callback_data));
      const r = await x.b.runCycle(0);
      expect(r.decisions[0], name).toMatchObject({ kind: "rejected", reason: "safety_halt" });
      expect(x.db.reviews, name).toHaveLength(0);
      expect(must(x.db.cards.get(must([...x.db.cards.keys()][0]))).state, name).toBe("sent"); // still awaiting a decision
      expect(must(x.api.answers.at(-1)).text).toContain("System halted");
      if (name === "kill switch") {
        x.api.inbox.push(x.api.tap(21, must(buttons[1]).callback_data)); // reject: risk-reducing, allowed
        await x.b.runCycle(0);
        expect(x.db.reviews).toHaveLength(1);
        expect(x.db.reviews[0]).toMatchObject({ decision: "reject" });
      }
    }
  });
  it("an approve works normally while healthy, including with trading disabled (control)", async () => {
    use();
    const x = await bot();
    await x.b.runCycle(0);
    x.api.inbox.push(x.api.tap(30, must(must(must(x.api.sent[0]).buttons)[0]).callback_data));
    expect((await x.b.runCycle(0)).decisions[0]).toMatchObject({ kind: "decision", action: "approve" });
  });
});

describe("scheduler boundary", () => {
  it("market_data jobs are not trade state: they run regardless of the control state", async () => {
    use({ KILL_SWITCH_ACTIVE: true }).failWith(new Error("down"));
    const run = vi.fn(async () => undefined);
    expect(await runScheduledJob({ name: "market", effect: "market_data" }, run)).toBe("ran");
    expect(run).toHaveBeenCalledOnce();
  });
  it.each([
    ["trading disabled (the seeded default)", (s: InMemoryStateSource) => s.set({}), "trading_disabled"],
    ["kill switch active", (s: InMemoryStateSource) => s.set({ TRADING_ENABLED: true, KILL_SWITCH_ACTIVE: true }), "kill_switch_active"],
    ["state unreadable", (s: InMemoryStateSource) => s.failWith(new Error("down")), "state_unavailable"],
  ])("trade_state jobs are skipped with a safety event: %s", async (_n, stop, reason) => {
    const s = use();
    stop(s);
    const run = vi.fn(async () => undefined);
    const events: Array<[string, Record<string, unknown>]> = [];
    expect(await runScheduledJob({ name: "manage-positions", effect: "trade_state" }, run, { log: (e, f) => events.push([e, f]) })).toBe("skipped_by_safety");
    expect(run).not.toHaveBeenCalled();
    expect(events[0]).toEqual(["scheduler.job.skipped_by_safety", { job: "manage-positions", effect: "trade_state", reason }]);
  });
  it("trade_state jobs run only with trading enabled and the kill switch inactive", async () => {
    use({ TRADING_ENABLED: true });
    const run = vi.fn(async () => undefined);
    expect(await runScheduledJob({ name: "manage-positions", effect: "trade_state" }, run)).toBe("ran");
  });
});
