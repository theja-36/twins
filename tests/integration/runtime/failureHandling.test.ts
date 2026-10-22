/**
 * R0B failure-handling and duplicate-delivery integration tests.
 * Real Redis (test-owned queue) + real PostgreSQL. Failure injection is a
 * controlled in-process seam; it is NOT evidence of a real Redis/PostgreSQL
 * outage or worker crash.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { schema, type Db } from "../../../packages/database/src/index";
import {
  createHarness,
  telegramWebhookPayload,
  uniqueChatId,
  waitFor,
  webhookHeaders,
  type Harness, must } from "./harness";
import { processTelegramQueueJob } from "../../../services/worker/src/index";

const harnesses: Harness[] = [];
async function harness(opts: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(opts);
  harnesses.push(h);
  return h;
}

afterAll(async () => {
  const errs: string[] = [];
  for (const h of harnesses) {
    try {
      await h.close();
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errs.length) throw new Error(errs.join(" | "));
});

async function countsFor(db: Db, channel: string) {
  const msgs = await db
    .select({ id: schema.telegramMessages.id })
    .from(schema.telegramMessages)
    .innerJoin(
      schema.telegramSources,
      eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id),
    )
    .where(eq(schema.telegramSources.channelIdentifier, channel));
  const messages = msgs;
  const ids = messages.map((m) => m.id);
  const signals = ids.length
    ? await db.select({ id: schema.signals.id }).from(schema.signals).where(inArray(schema.signals.telegramMessageId, ids))
    : [];
  const validations = signals.length
    ? await db
        .select({ id: schema.signalValidations.id })
        .from(schema.signalValidations)
        .where(inArray(schema.signalValidations.signalId, signals.map((s) => s.id)))
    : [];
  return { messages: messages.length, signals: signals.length, validations: validations.length };
}

const rand = () => Math.floor(Math.random() * 1_000_000_000);

describe("R0B failure handling (real Redis + PostgreSQL)", () => {
  it("permanent invalid input (malformed timestamp) fails once without retry or DB writes", async () => {
    const h = await harness();
    const messageId = rand();
    const channel = `@r0b_perm_${rand()}`;
    const job = await h.queue.add(
      "telegram_messages",
      {
        jobType: "telegram_messages",
        providerName: "telegram-bot-webhook",
        telegram: {
          params: { channelIdentifier: channel },
          normalizedMessage: {
            channelIdentifier: channel,
            externalMessageId: String(messageId),
            messageTimestamp: "not-a-date",
            rawText: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
            rawPayload: {},
          },
          exchange: "NSE",
          instrumentType: "equity",
        },
      } as never,
      { jobId: `perm-${messageId}`, attempts: 3, backoff: { type: "fixed", delay: 100 } },
    );

    const failed = await waitFor(
      async () => ((await job.getState()) === "failed" ? await h.queue.getJob(must(job.id)) : undefined),
      15_000,
      "job to reach failed state",
    );
    // Allow any (erroneous) retry the chance to show up before asserting once-only.
    await new Promise((r) => setTimeout(r, 500));

    expect(h.invocations.get(String(job.id))).toBe(1);
    expect(failed?.failedReason).toContain("Invalid messageTimestamp");
    expect(failed?.failedReason).toContain("permanent invalid input");
    expect(failed?.failedReason).toContain(`jobId=${job.id}`);
    expect(failed?.failedReason).not.toContain("BUY RELIANCE"); // no payload leakage
    expect(await must(await h.queue.getJob(must(job.id))).getState()).toBe("failed");
    expect(await countsFor(h.db, channel)).toEqual({ messages: 0, signals: 0, validations: 0 });
  }, 30_000);

  it("injected transient failure is retried by BullMQ and the final result is not duplicated", async () => {
    let remainingFailures = 1;
    const h = await harness({
      // Seam: first insert into telegram_messages throws once (injected, in-process).
      workerDb: (db) =>
        new Proxy(db, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop === "insert" && typeof value === "function") {
              return (table: Parameters<Db["insert"]>[0]) => {
                if (remainingFailures > 0 && getTableName(table) === "telegram_messages") {
                  remainingFailures -= 1;
                  throw new Error("injected transient failure (test seam)");
                }
                return (value as (t: unknown) => unknown).call(target, table);
              };
            }
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }) as Db,
    });
    const messageId = rand();
    const channelUser = `r0b_transient_${rand()}`;
    const chatId = uniqueChatId();
    const channel = `tg_chat_${chatId}`;

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: webhookHeaders,
      payload: telegramWebhookPayload(rand(), messageId, channelUser, chatId),
    });
    expect(res.statusCode).toBe(202);

    const jobId = `tg-${channel}-${messageId}`;
    await waitFor(
      async () => ((await (await h.queue.getJob(jobId))?.getState()) === "completed" ? true : undefined),
      20_000,
      "job to complete after retry",
    );

    expect(remainingFailures).toBe(0);
    expect(h.invocations.get(jobId)).toBe(2); // one injected failure + one successful retry
    expect(await countsFor(h.db, channel)).toEqual({ messages: 1, signals: 1, validations: 1 });
  }, 40_000);

  it("duplicate delivery of the same Telegram update yields no duplicate business effect", async () => {
    const h = await harness();
    const messageId = rand();
    const updateId = rand();
    const channelUser = `r0b_dup_${rand()}`;
    const chatId = uniqueChatId();
    const channel = `tg_chat_${chatId}`;
    const payload = telegramWebhookPayload(updateId, messageId, channelUser, chatId);
    const jobId = `tg-${channel}-${messageId}`;

    const first = await h.app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload });
    expect(first.statusCode).toBe(202);
    await waitFor(
      async () => ((await (await h.queue.getJob(jobId))?.getState()) === "completed" ? true : undefined),
      20_000,
      "first delivery to complete",
    );
    expect(await countsFor(h.db, channel)).toEqual({ messages: 1, signals: 1, validations: 1 });

    // Layer 1: webhook redelivery. The queue jobId dedupes while the job is retained.
    const second = await h.app.inject({ method: "POST", url: "/webhooks/telegram", headers: webhookHeaders, payload });
    expect(second.statusCode).toBe(202);
    const counts = await h.queue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
    expect(counts).toMatchObject({ waiting: 0, active: 0, delayed: 0, completed: 1, failed: 0 });
    expect(h.invocations.get(jobId)).toBe(1);

    // Layer 2: queue-level dedupe lost (e.g. job retention expired) -> the worker
    // is handed the same logical message again. DB idempotency must hold.
    const original = await h.queue.getJob(jobId);
    await processTelegramQueueJob(must(original), "r0b-redelivery", h.db);
    expect(await countsFor(h.db, channel)).toEqual({ messages: 1, signals: 1, validations: 1 });
  }, 40_000);
});
