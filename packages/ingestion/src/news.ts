import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { NewsFetchParams, NewsProvider } from "@twins/types";
import type { Db } from "./db";
import { checkNewsItemQuality } from "./dataQuality";
import { computeNewsDedupeHash } from "./dedupe";

export interface IngestNewsSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  rejectedInvalid: number;
  [key: string]: unknown;
}

async function resolveNewsSource(
  db: Db,
  name: string,
  tier: "A" | "B" | "C" | "D" | "E",
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.newsSources.id })
    .from(schema.newsSources)
    .where(eq(schema.newsSources.name, name));
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(schema.newsSources)
    .values({ name, tier })
    .onConflictDoNothing({ target: schema.newsSources.name })
    .returning({ id: schema.newsSources.id });
  if (inserted) return inserted.id;

  const [afterRace] = await db
    .select({ id: schema.newsSources.id })
    .from(schema.newsSources)
    .where(eq(schema.newsSources.name, name));
  if (!afterRace) throw new Error(`failed to resolve news source ${name}`);
  return afterRace.id;
}

/**
 * News ingestion (spec section 16/17). No clustering, dedup-across-
 * sources, relevance scoring, or AI summarization happens here - this
 * only persists each raw article as OBSERVED evidence. Event clustering
 * belongs to Phase 7.
 */
export async function ingestNewsItems(
  db: Db,
  provider: NewsProvider,
  params: NewsFetchParams,
): Promise<IngestNewsSummary> {
  const items = await provider.fetchLatest(params);

  const summary: IngestNewsSummary = {
    fetched: items.length,
    inserted: 0,
    duplicates: 0,
    rejectedInvalid: 0,
  };

  for (const item of items) {
    const quality = checkNewsItemQuality({
      headline: item.headline,
      sourceUrl: item.sourceUrl,
      sourceTimestamp: item.sourceTimestamp,
    });
    if (!quality.valid) {
      summary.rejectedInvalid += 1;
      continue;
    }

    const newsSourceId = await resolveNewsSource(db, item.sourceName, item.sourceTier);
    const dedupeHash = computeNewsDedupeHash(item.sourceUrl);

    const [inserted] = await db
      .insert(schema.newsEvidence)
      .values({
        newsSourceId,
        sourceUrl: item.sourceUrl,
        headline: item.headline,
        bodyExcerpt: item.bodyExcerpt,
        sourceTimestamp: item.sourceTimestamp,
        receivedAt: new Date(),
        dedupeHash,
        rawPayload: item.rawPayload,
      })
      .onConflictDoNothing({
        target: [schema.newsEvidence.newsSourceId, schema.newsEvidence.dedupeHash],
      })
      .returning({ id: schema.newsEvidence.id });

    if (inserted) {
      summary.inserted += 1;
    } else {
      summary.duplicates += 1;
    }
  }

  return summary;
}
