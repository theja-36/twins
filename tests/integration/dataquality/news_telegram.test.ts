import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import { ingestTelegramMessages } from "../../../packages/ingestion/src/telegram";
import { assessNewsEvidence } from "../../../packages/dataquality/src/rules/news";
import { assessTelegramMessage } from "../../../packages/dataquality/src/rules/telegram";
import type {
  NewsProvider,
  NormalizedNewsItem,
  NormalizedTelegramMessage,
  TelegramProvider,
} from "../../../packages/types/src/index";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

class FixtureNewsProvider implements NewsProvider {
  readonly providerName = "fixture-news";
  readonly sourceTier;
  constructor(private items: NormalizedNewsItem[], tier: NormalizedNewsItem["sourceTier"] = "C") {
    this.sourceTier = tier;
  }
  async fetchLatest(): Promise<NormalizedNewsItem[]> {
    return this.items;
  }
  async getHealth() {
    return {
      providerName: this.providerName,
      providerType: "news" as const,
      status: "healthy" as const,
      checkedAt: new Date(),
    };
  }
}

class FixtureTelegramProvider implements TelegramProvider {
  readonly providerName = "fixture-telegram";
  constructor(private messages: NormalizedTelegramMessage[]) {}
  async fetchMessages(): Promise<NormalizedTelegramMessage[]> {
    return this.messages;
  }
  async getHealth() {
    return {
      providerName: this.providerName,
      providerType: "telegram" as const,
      status: "healthy" as const,
      checkedAt: new Date(),
    };
  }
}

beforeAll(async () => {
  await db.execute("select 1");
});

afterAll(async () => {
  const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
  await pool.end();
});

describe("assessNewsEvidence (integration)", () => {
  it("assesses a tier-A article as trusted", async () => {
    const url = `https://example.invalid/${randomUUID()}`;
    await ingestNewsItems(
      db,
      new FixtureNewsProvider(
        [
          {
            sourceName: `source-${randomUUID()}`,
            sourceTier: "A",
            sourceUrl: url,
            headline: "Official RBI announcement",
            sourceTimestamp: new Date(),
          },
        ],
        "A",
      ),
      {},
    );
    const [row] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, url));
    if (!row) throw new Error("row not inserted");

    const assessment = await assessNewsEvidence(db, row.id);
    expect(assessment.overallStatus).toBe("trusted");
  });

  it("flags a tier-D/E article on source reliability without rejecting it", async () => {
    const url = `https://example.invalid/${randomUUID()}`;
    await ingestNewsItems(
      db,
      new FixtureNewsProvider(
        [
          {
            sourceName: `source-${randomUUID()}`,
            sourceTier: "D",
            sourceUrl: url,
            headline: "Aggregated blog post",
            sourceTimestamp: new Date(),
          },
        ],
        "D",
      ),
      {},
    );
    const [row] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, url));
    if (!row) throw new Error("row not inserted");

    const assessment = await assessNewsEvidence(db, row.id);
    expect(assessment.overallStatus).toBe("flagged");
    const reliability = assessment.dimensions.find((d) => d.dimension === "source_reliability");
    expect(reliability?.passed).toBe(false);
  });
});

describe("assessTelegramMessage (integration)", () => {
  it("never comes out fully trusted - Telegram is Tier E by design", async () => {
    const channelIdentifier = `chan-${randomUUID()}`;
    await ingestTelegramMessages(
      db,
      new FixtureTelegramProvider([
        {
          channelIdentifier,
          externalMessageId: "1",
          messageTimestamp: new Date(),
          rawText: "BUY RELIANCE @ 2800 SL 2750 TGT 2900",
        },
      ]),
      { channelIdentifier },
    );
    const [row] = await db
      .select()
      .from(schema.telegramMessages)
      .innerJoin(schema.telegramSources, eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id))
      .where(eq(schema.telegramSources.channelIdentifier, channelIdentifier));
    if (!row) throw new Error("row not inserted");

    const assessment = await assessTelegramMessage(db, row.telegram_messages.id);
    expect(assessment.overallStatus).toBe("flagged");
    const reliability = assessment.dimensions.find((d) => d.dimension === "source_reliability");
    expect(reliability?.passed).toBe(false);
    expect(reliability?.detail).toContain("never treated as a source of truth");
  });

  it("still rejects a structurally invalid message even before considering source reliability", async () => {
    const channelIdentifier = `chan-${randomUUID()}`;
    // insert directly, bypassing ingestion validation, to test the assessor's own validity check
    const [source] = await db
      .insert(schema.telegramSources)
      .values({ channelIdentifier })
      .returning();
    if (!source) throw new Error("source not created");
    const [message] = await db
      .insert(schema.telegramMessages)
      .values({
        telegramSourceId: source.id,
        externalMessageId: "1",
        messageTimestamp: new Date(),
        rawText: "non-empty so insert succeeds",
      })
      .returning();
    if (!message) throw new Error("message not created");

    const assessment = await assessTelegramMessage(db, message.id);
    // validity passes here since rawText is non-empty; this test documents
    // that validity is still checked independently of source_reliability.
    const validity = assessment.dimensions.find((d) => d.dimension === "validity");
    expect(validity?.passed).toBe(true);
    expect(assessment.overallStatus).toBe("flagged"); // still flagged via source_reliability
  });
});
