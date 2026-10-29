import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../support/apiWithTestPolicy";
import { memoryOutbox } from "../../support/memoryOutbox";

/** A clearly test-owned fake queue. There is no NODE_ENV-based stub in the API: tests that do not enqueue still inject this. */
const testOwnedFakeQueue = () => ({ add: vi.fn().mockResolvedValue({ id: "test-owned-fake-job" }) });

describe("API Webhook Authentication & Security (R0A / SEC-01, SEC-02, SEC-03)", () => {
  const validApiKey = "test-api-key-12345";
  const validWebhookSecret = "telegram-secret-token-abcdef";

  it("fails startup when TWINS_API_KEY is missing", async () => {
    const originalKey = process.env["TWINS_API_KEY"];
    delete process.env["TWINS_API_KEY"];
    try {
      await expect(
        buildApp({
          apiKey: "",
          telegramWebhookSecret: validWebhookSecret,
        }),
      ).rejects.toThrow(/TWINS_API_KEY.*required/i);
    } finally {
      if (originalKey) process.env["TWINS_API_KEY"] = originalKey;
    }
  });

  it("fails startup when TELEGRAM_WEBHOOK_SECRET is missing (fail-closed, SEC-01)", async () => {
    const originalSecret = process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    try {
      await expect(
        buildApp({
          apiKey: validApiKey,
          telegramWebhookSecret: "",
        }),
      ).rejects.toThrow(/TELEGRAM_WEBHOOK_SECRET.*required/i);
    } finally {
      if (originalSecret) process.env["TELEGRAM_WEBHOOK_SECRET"] = originalSecret;
    }
  });

  it("rejects webhook request with missing secret header (403 Forbidden) and does NOT enqueue", async () => {
    const mockQueueAdd = vi.fn();
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: { add: mockQueueAdd },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: 12345, type: "channel" },
          text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rejects webhook request with incorrect secret header (403 Forbidden) and does NOT enqueue", async () => {
    const mockQueueAdd = vi.fn();
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: { add: mockQueueAdd },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret-token",
      },
      payload: {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: 12345, type: "channel" },
          text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("accepts webhook request with valid secret header (202 Accepted) and enqueues job", async () => {
    const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: { add: mockQueueAdd },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": validWebhookSecret,
      },
      payload: {
        update_id: 101,
        message: {
          message_id: 42,
          date: 1700000000,
          chat: { id: -1001234567890, type: "channel", username: "trading_signals" },
          text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [jobType, payload, options] = mockQueueAdd.mock.calls[0] as [string, { outboxId: string }, { jobId: string }];
    expect(jobType).toBe("telegram_outbox"); // Redis carries only the durable outbox row id
    expect(options.jobId).toBe(`outbox-${payload.outboxId}-0`);
  });

  it("handles non-text updates cleanly with 200 ignored without enqueuing", async () => {
    const mockQueueAdd = vi.fn();
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: { add: mockQueueAdd },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": validWebhookSecret,
      },
      payload: {
        update_id: 102,
        message: {
          message_id: 43,
          date: 1700000000,
          chat: { id: -1001234567890, type: "channel" },
          // sticker update, no text
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ignored", reason: "no text content" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("still acknowledges (202) when the Redis enqueue fails AFTER the durable write; the row is recoverable by the reconciler", async () => {
    const failingQueueAdd = vi.fn().mockRejectedValue(new Error("Redis connection dropped"));
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: { add: failingQueueAdd },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": validWebhookSecret,
      },
      payload: {
        update_id: 103,
        message: {
          message_id: 44,
          date: 1700000000,
          chat: { id: -1001234567890, type: "channel" },
          text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(failingQueueAdd).toHaveBeenCalledOnce();
  });

  it("protects /signals/:id/validation requiring valid Bearer token", async () => {
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: testOwnedFakeQueue(),
    });

    // Missing auth header
    const noAuth = await app.inject({
      method: "GET",
      url: "/signals/00000000-0000-0000-0000-000000000000/validation",
    });
    expect(noAuth.statusCode).toBe(401);

    // Wrong token
    const wrongAuth = await app.inject({
      method: "GET",
      url: "/signals/00000000-0000-0000-0000-000000000000/validation",
      headers: {
        authorization: "Bearer wrong-token",
      },
    });
    expect(wrongAuth.statusCode).toBe(401);
  });

  it("allows unauthenticated GET /health", async () => {
    const app = await buildApp({
      apiKey: validApiKey,
      telegramWebhookSecret: validWebhookSecret,
      intakeOutbox: memoryOutbox(), telegramQueue: testOwnedFakeQueue(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "api",
      liveTradingEnabled: false,
    });
  });
});
