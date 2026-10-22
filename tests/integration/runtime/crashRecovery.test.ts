/**
 * REAL worker-process crash/recovery test (abrupt SIGKILL of a dedicated child process).
 *
 * GATED: runs only with TWINS_CRASH_TEST=1 (plus the guarded twins_ci environment), so normal
 * `npm run test:integration` / CI never kills a process. It terminates ONLY the child pid that this
 * test spawned (verified via the IPC-reported pid, the Node ChildProcess handle and `ps` showing the
 * unique test-owned queue name in that pid's command line). It never touches PostgreSQL, Redis,
 * Docker or any other process.
 *
 * Scenario: the child commits the message row, then is held just BEFORE its first INSERT into `signals`
 * (every statement in this pipeline autocommits - there are no explicit transactions - so the message
 * row is committed). The test SIGKILLs the child (an abrupt crash: not an exception, not worker.close()),
 * starts a replacement worker process, and expects BullMQ's stalled-job recovery (lock expiry + stalled
 * check, a test-only fast configuration in the child) to re-run the SAME job: no duplicate business
 * records, the canonical message reused, one signal and one validation, and the correlation context
 * of the original request visible in both processes' logs.
 * Not claimed: exactly-once delivery; "stalled" is an event/mechanism, not a job state.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "../../../apps/api/src/index";
import { createBoundedDb, schema } from "../../../packages/database/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { DATABASE_URL, REDIS_URL, TEST_API_KEY, TEST_WEBHOOK_SECRET, must, telegramWebhookPayload, uniqueChatId, waitFor, webhookHeaders } from "./harness";

const enabled = process.env.TWINS_CRASH_TEST === "1" && process.env.TWINS_CI === "1";
const CHILD = new URL("./crash/workerChild.ts", import.meta.url).pathname;
const RECOVERY_DEADLINE_MS = 45_000; // lock 3 s + stalled interval 1 s + processing + margin (test-only settings in the child)

interface Child { proc: ChildProcess; pid: number; label: string; logs: Array<Record<string, unknown>>; ipc: Array<Record<string, unknown>> }

function spawnChild(label: string, mode: "crash" | "recover", queue: string): Child {
  const proc = fork(CHILD, [`--queue=${queue}`, `--mode=${mode}`], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: { ...process.env, NODE_ENV: "test", LIVE_TRADING: "false", TWINS_CI: "1" },
  });
  const child: Child = { proc, pid: must(proc.pid), label, logs: [], ipc: [] };
  let buf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("{")) { try { child.logs.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a log line */ } }
    }
  });
  proc.on("message", (m) => child.ipc.push(m as Record<string, unknown>));
  return child;
}
const waitIpc = (c: Child, type: string, ms = 20_000) =>
  waitFor(async () => c.ipc.find((m) => m["type"] === type), ms, `${c.label} IPC '${type}'`);

describe.skipIf(!enabled)("worker process crash and recovery (real SIGKILL, guarded twins_ci)", () => {
  const children: Child[] = [];
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    const problems: string[] = [];
    for (const c of children) {
      if (c.proc.exitCode === null && c.proc.signalCode === null) {
        try {
          c.proc.send({ type: "shutdown" });
          await Promise.race([new Promise((r) => c.proc.once("exit", r)), new Promise((r) => setTimeout(r, 10_000))]);
          if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL"); // only our own child handle
        } catch (e) { problems.push(`child ${c.label}: ${String(e)}`); }
      }
    }
    for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { problems.push(String(e)); } }
    if (problems.length) throw new Error(`teardown problems: ${problems.join("; ")}`);
  });

  it("SIGKILL after the message commit, before the signal insert -> replacement worker recovers the same job without duplicates", async () => {
    const queueName = `r0b_test_crash_${randomUUID().replace(/-/g, "")}`;
    const records: LogRecord[] = []; // API-side logs (parent process)
    const logger = createStructuredLogger((r) => records.push(r));
    const dbHandle = createBoundedDb({ url: DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
    const producerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    const eventsRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(queueName, { connection: producerRedis });
    const events = new QueueEvents(queueName, { connection: eventsRedis });
    const stalledEvents: Array<{ jobId: string }> = [];
    events.on("stalled", (a) => stalledEvents.push({ jobId: a.jobId }));
    const app = await buildApp({ apiKey: TEST_API_KEY, telegramWebhookSecret: TEST_WEBHOOK_SECRET, telegramQueue: queue, db: dbHandle.db, structuredLogger: logger });
    cleanup.push(async () => { await app.close(); await events.close(); await queue.obliterate({ force: true }); await queue.close(); await producerRedis.quit(); await eventsRedis.quit(); await dbHandle.close(); });
    await queue.waitUntilReady(); await events.waitUntilReady();

    const evidence: Record<string, unknown> = { queueName, targets: { db: "twins_ci", redis: "127.0.0.1:16379" } };
    let jobIdForEvidence: string | undefined;
    // Diagnostics are captured BEFORE any queue cleanup (afterAll), on success and on failure.
    const captureDiagnostics = async () => {
      try {
        const j = jobIdForEvidence ? await queue.getJob(jobIdForEvidence) : undefined;
        evidence["job"] = j
          ? { id: j.id, state: await j.getState(), attemptsStarted: j.attemptsStarted, attemptsMade: j.attemptsMade, stalledCounter: j.stalledCounter, failedReason: j.failedReason, finishedOn: j.finishedOn, processedOn: j.processedOn }
          : null;
      } catch (e) { evidence["jobCaptureError"] = String(e); }
      evidence["stalledEvents"] = stalledEvents;
      evidence["apiLogs"] = records;
      evidence["children"] = children.map((c) => ({ label: c.label, pid: c.pid, exitCode: c.proc.exitCode, signalCode: c.proc.signalCode, ipc: c.ipc, logs: c.logs }));
      const file = process.env.TWINS_CRASH_EVIDENCE_FILE;
      if (file) writeFileSync(file, JSON.stringify(evidence, null, 2));
      else console.log(JSON.stringify(evidence));
    };
    try {
      // 1. crash-mode worker process
      const crashing = spawnChild("worker-1 (crash mode)", "crash", queueName);
      children.push(crashing);
      await waitIpc(crashing, "ready");

      // 2. real webhook -> real queue
      const chatId = uniqueChatId(); const messageId = Math.floor(Math.random() * 1e9);
      const res = await app.inject({ method: "POST", url: "/webhooks/telegram", headers: { ...webhookHeaders, "x-correlation-id": "crash-test-corr-0001" }, payload: telegramWebhookPayload(Math.floor(Math.random() * 1e9), messageId, `crash_${messageId}`, chatId) });
      expect(res.statusCode).toBe(202);
      const jobId = `tg-tg_chat_${chatId}-${messageId}`;
        jobIdForEvidence = jobId;

      // 3. checkpoint: committed message, signal not yet inserted
      const checkpoint = await waitIpc(crashing, "checkpoint");
      expect(checkpoint["name"]).toBe("message_committed_before_signal_insert");
      expect(checkpoint["pid"]).toBe(crashing.pid);
      const [msgBefore] = await dbHandle.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.externalMessageId, String(messageId)));
      expect(msgBefore).toBeDefined(); // committed (visible from another connection)
      const sigsBefore = await dbHandle.db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, must(msgBefore).id));
      expect(sigsBefore).toHaveLength(0);
      expect(await must(await queue.getJob(jobId)).getState()).toBe("active");

      // 4. ownership proof, then terminate ONLY this child, abruptly
      expect(crashing.proc.pid).toBe(crashing.pid);
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(crashing.pid)], { encoding: "utf8" });
      expect(cmd).toContain("workerChild.ts");
      expect(cmd).toContain(queueName);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => crashing.proc.once("exit", (code, signal) => resolve({ code, signal })));
      const killedAt = Date.now();
      crashing.proc.kill("SIGKILL");
      const exit = await exited;
      expect(exit.signal).toBe("SIGKILL"); // the child really died from the planned signal
      expect(exit.code).toBeNull();
      expect(() => process.kill(crashing.pid, 0)).toThrow(); // pid gone
      expect(crashing.logs.some((l) => l["event"] === "worker.job.completed" || l["event"] === "worker.job.failed")).toBe(false); // it never got to finish or fail

      // state right after the crash is unchanged (nothing committed by the dead process)
      expect(await dbHandle.db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, must(msgBefore).id))).toHaveLength(0);

      // 5. replacement worker process
      const recovering = spawnChild("worker-2 (replacement)", "recover", queueName);
      children.push(recovering);
      await waitIpc(recovering, "ready");
      await waitFor(async () => ((await must(await queue.getJob(jobId)).getState()) === "completed" ? true : undefined), RECOVERY_DEADLINE_MS, `recovery of ${jobId}`);
      const recoveryMs = Date.now() - killedAt;

      // 6. persisted records: no duplicates, canonical message reused
      const messages = await dbHandle.db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.externalMessageId, String(messageId)));
      expect(messages).toHaveLength(1);
      expect(must(messages[0]).id).toBe(must(msgBefore).id);
      const signals = await dbHandle.db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, must(msgBefore).id));
      expect(signals).toHaveLength(1);
      const validations = await dbHandle.db.select().from(schema.signalValidations).where(eq(schema.signalValidations.signalId, must(signals[0]).id));
      expect(validations).toHaveLength(1);
      expect(must(validations[0]).idempotencyKey).toBe(`telegram-ingest:${must(signals[0]).id}`);

      // 7. BullMQ evidence (events/counters, not a separate job state)
      const job = must(await queue.getJob(jobId));
      expect(job.attemptsStarted).toBe(2); // the crashed start + the recovery start
      expect(job.stalledCounter).toBe(1);
      expect(stalledEvents.some((e) => e.jobId === jobId)).toBe(true);

      // 8. logs link to the same job and correlation context
      const accepted = must(records.find((r) => r.event === "webhook.intake.accepted"));
      expect(accepted["correlationId"]).toBe("crash-test-corr-0001");
      const w1 = crashing.logs.filter((l) => l["jobId"] === jobId);
      const w2 = recovering.logs.filter((l) => l["jobId"] === jobId);
      expect(w1.find((l) => l["event"] === "worker.job.started")).toMatchObject({ correlationId: "crash-test-corr-0001", attempt: 1, childPid: crashing.pid });
      expect(w1.find((l) => l["event"] === "worker.message.ingested")).toMatchObject({ inserted: 1 });
      expect(w2.find((l) => l["event"] === "worker.job.started")).toMatchObject({ correlationId: "crash-test-corr-0001", attempt: 2, childPid: recovering.pid });
      expect(w2.find((l) => l["event"] === "worker.message.ingested")).toMatchObject({ inserted: 0, duplicates: 1 }); // committed message reused
      expect(w2.find((l) => l["event"] === "worker.job.completed")).toMatchObject({ outcome: "validation_created", signalId: must(signals[0]).id, validationId: must(validations[0]).id });
      evidence["recoveryMsAfterKill"] = recoveryMs;
      evidence["records"] = { messageId: must(msgBefore).id, signalId: must(signals[0]).id, validationId: must(validations[0]).id, messages: messages.length, signals: signals.length, validations: validations.length };
    } finally {
      await captureDiagnostics();
    }
  }, 120_000);
});
