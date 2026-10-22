/**
 * TWINS End-to-End Runtime Pipeline Integration Test (Gate R0B).
 *
 * Exercises the complete real-service execution path:
 *   HTTP POST /webhooks/telegram (Fastify API)
 *     -> BullMQ Queue (Redis)
 *     -> Worker Consumer (BullMQ Worker)
 *     -> PostgreSQL Persistence (telegram_messages, signals, signal_validations)
 *
 * Requirements (spec section 27/46/47):
 * - Requires real PostgreSQL at DATABASE_URL and real Redis at REDIS_URL.
 * - LIVE_TRADING remains false.
 * - External market data context uses synthetic fixtures / controlled providers
 *   so tests do not depend on external live Yahoo Finance API network calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../../../packages/database/src/index";
import {
  createHarness,
  telegramWebhookPayload,
  uniqueChatId,
  waitFor,
  webhookHeaders,
  type Harness, must } from "./harness";

describe("Runtime Pipeline Integration: API -> Redis -> Worker -> PostgreSQL (R0B)", () => {
  let h: Harness;

  beforeAll(async () => {
    // Unique test-owned queue; worker ready before any webhook is sent.
    h = await createHarness({});
  });

  afterAll(async () => {
    // Attempts every owned resource, then asserts no residual keys under the test queue prefix.
    if (h) await h.close();
  });

  it("processes synthetic Telegram webhook through Redis queue into PostgreSQL validation rows", async () => {
    const updateId = Math.floor(Math.random() * 1_000_000_000);
    const messageId = Math.floor(Math.random() * 1_000_000_000);
    const channelUser = `r0b_test_channel_${updateId}`;
    const chatId = uniqueChatId();
    const dbHandle = { db: h.db };
    const apiApp = h.app;

    const response = await apiApp.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: webhookHeaders,
      payload: telegramWebhookPayload(updateId, messageId, channelUser, chatId),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });

    const jobId = `tg-tg_chat_${chatId}-${messageId}`;
    await waitFor(
      async () => ((await (await h.queue.getJob(jobId))?.getState()) === "completed" ? true : undefined),
      20_000,
      "job completion",
    );
    expect(h.invocations.get(jobId)).toBe(1);

    // C. Verify PostgreSQL source-of-record persistence
    const [persistedMsg] = await dbHandle.db
      .select()
      .from(schema.telegramMessages)
      .where(eq(schema.telegramMessages.externalMessageId, String(messageId)));

    expect(persistedMsg).toBeDefined();
    expect(persistedMsg?.rawText).toContain("BUY RELIANCE");

    // D. Verify structured signal extraction
    const [persistedSignal] = await dbHandle.db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.telegramMessageId, must(persistedMsg).id));

    expect(persistedSignal).toBeDefined();
    expect(persistedSignal?.direction).toBe("buy");
    expect(Number(persistedSignal?.entryPrice)).toBe(2800);

    // E. Verify immutable signal validation persisted
    const [persistedValidation] = await dbHandle.db
      .select()
      .from(schema.signalValidations)
      .where(eq(schema.signalValidations.signalId, must(persistedSignal).id));

    expect(persistedValidation).toBeDefined();
    // F. Expected decision for THIS fixture. This test checks the webhook -> queue ->
    // worker -> persistence path and that the synthetic market data was used. It does NOT
    // assert the exact complete set of thesis factors: some factors depend on ambient
    // database state (e.g. `bear.no_corroborating_context` appears only when no macro/news
    // evidence exists anywhere), which differs between a shared dev DB and a fresh one.
    // Required: an unverified source and no entity mapping, with no bull-side support, so the
    // deterministic engine must abstain. Forbidden: any market-data bear factor.
    expect(persistedValidation?.outcome).toBe("INSUFFICIENT_EVIDENCE");
    const bear = persistedValidation?.bearThesis as { factors: Array<{ ruleId: string }> };
    const bull = persistedValidation?.bullThesis as { factors: unknown[] };
    const bearRules = bear.factors.map((f) => f.ruleId).sort();
    expect(bearRules).toContain("bear.untrusted_source");
    expect(bearRules).toContain("bear.unresolved_entity");
    expect(bearRules).not.toContain("bear.no_market_data");
    expect(bearRules).not.toContain("bear.stale_market_data");
    expect(bull.factors).toEqual([]);
    expect(persistedValidation?.sourceReliability).toBe("UNKNOWN");

    // G. The synthetic market observation was actually persisted for this instrument.
    const obs = await dbHandle.db
      .select()
      .from(schema.marketObservations)
      .where(eq(schema.marketObservations.instrumentId, must(persistedSignal).instrumentId));
    expect(obs.some((o) => o.source === "r0b-synthetic" && Number(o.close) === 2810)).toBe(true);
  });
});
