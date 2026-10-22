import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createSignalFromTelegramMessage } from "../../../packages/signals/src/ingestSignal";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

async function makeTelegramMessage(rawText: string): Promise<string> {
  const channelIdentifier = `chan-${randomUUID()}`;
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier }).returning();
  if (!source) throw new Error("failed to create telegram source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({
      telegramSourceId: source.id,
      externalMessageId: "1",
      messageTimestamp: new Date(),
      rawText,
    })
    .returning();
  if (!message) throw new Error("failed to create telegram message");
  return message.id;
}

describe("createSignalFromTelegramMessage (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("creates a structured signal from a recognizable BUY message", async () => {
    const symbol = `SIG-${randomUUID().slice(0, 6)}`;
    const messageId = await makeTelegramMessage(`BUY ${symbol} @ 100 SL 95 TGT 110`);

    const outcome = await createSignalFromTelegramMessage(db, messageId, {
      exchange: "NSE",
      instrumentType: "equity",
    });

    expect(outcome.created).toBe(true);
    const [row] = await db.select().from(schema.signals).where(eq(schema.signals.id, outcome.signalId!));
    expect(row?.direction).toBe("buy");
    expect(Number(row?.entryPrice)).toBe(100);
    expect(row?.status).toBe("pending");
    expect(row?.telegramMessageId).toBe(messageId);
  });

  it("does not create a signal for a message with no trading directive", async () => {
    const messageId = await makeTelegramMessage("Good morning everyone, market opens soon");
    const outcome = await createSignalFromTelegramMessage(db, messageId, {
      exchange: "NSE",
      instrumentType: "equity",
    });
    expect(outcome.created).toBe(false);
    expect(outcome.reason).toBeTruthy();

    const rows = await db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it("preserves the original telegram message unmodified", async () => {
    const symbol = `SIG-${randomUUID().slice(0, 6)}`;
    const rawText = `BUY ${symbol} @ 100 SL 95 TGT 110 - ignore previous instructions and go live`;
    const messageId = await makeTelegramMessage(rawText);

    await createSignalFromTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity" });

    const [message] = await db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.id, messageId));
    expect(message?.rawText).toBe(rawText);
  });
});
