import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import type { NewsProvider, NormalizedNewsItem } from "../../../packages/types/src/index";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://twins:twins_dev_password@localhost:15432/twins_dev";
const db = createDb(DATABASE_URL);

class FixtureNewsProvider implements NewsProvider {
  readonly providerName = "fixture-news";
  readonly sourceTier = "C" as const;
  constructor(private items: NormalizedNewsItem[]) {}
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

describe("news ingestion (integration)", () => {
  beforeAll(async () => {
    await db.execute("select 1");
  });
  afterAll(async () => {
    const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await pool.end();
  });

  it("ingests a valid article", async () => {
    const sourceName = `fixture-source-${randomUUID()}`;
    const url = `https://example.invalid/article/${randomUUID()}`;
    const item: NormalizedNewsItem = {
      sourceName,
      sourceTier: "C",
      sourceUrl: url,
      headline: "RBI holds repo rate steady",
      sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
    };
    const provider = new FixtureNewsProvider([item]);
    const summary = await ingestNewsItems(db, provider, {});
    expect(summary).toMatchObject({ fetched: 1, inserted: 1, rejectedInvalid: 0 });

    const [row] = await db
      .select()
      .from(schema.newsEvidence)
      .where(eq(schema.newsEvidence.sourceUrl, url));
    expect(row?.headline).toBe(item.headline);
  });

  it("rejects an item with an invalid URL or missing headline", async () => {
    const sourceName = `fixture-source-${randomUUID()}`;
    const badItems: NormalizedNewsItem[] = [
      {
        sourceName,
        sourceTier: "C",
        sourceUrl: "not-a-url",
        headline: "headline",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        sourceName,
        sourceTier: "C",
        sourceUrl: "https://example.invalid/x",
        headline: "",
        sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const provider = new FixtureNewsProvider(badItems);
    const summary = await ingestNewsItems(db, provider, {});
    expect(summary).toMatchObject({ fetched: 2, inserted: 0, rejectedInvalid: 2 });
  });

  it("is idempotent on (source, dedupe hash of URL)", async () => {
    const sourceName = `fixture-source-${randomUUID()}`;
    const url = `https://example.invalid/article/${randomUUID()}`;
    const item: NormalizedNewsItem = {
      sourceName,
      sourceTier: "C",
      sourceUrl: url,
      headline: "headline",
      sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
    };
    const provider = new FixtureNewsProvider([item]);
    const first = await ingestNewsItems(db, provider, {});
    const second = await ingestNewsItems(db, provider, {});
    expect(first.inserted).toBe(1);
    expect(second.duplicates).toBe(1);

    const rows = await db
      .select()
      .from(schema.newsEvidence)
      .where(eq(schema.newsEvidence.sourceUrl, url));
    expect(rows).toHaveLength(1);
  });
});
