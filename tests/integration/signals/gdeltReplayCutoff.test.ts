import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GdeltNewsAdapter } from "../../../adapters/news/src/gdelt";
import { createDb, schema } from "../../../packages/database/src/index";
import { validateSignal } from "../../../packages/decision-intelligence/src/engine";
import { createEntityWithCanonicalAlias, linkInstrumentToCompany, resolveNewsEntityMentions } from "../../../packages/entities/src/index";
import { findInstrumentByExchangeSymbol } from "../../../packages/entities/src/instrumentMapping";
import { ingestNewsItems } from "../../../packages/ingestion/src/news";
import { assembleSignalIntelligence } from "../../../packages/signals/src/engine";
import { createSignalFromTelegramMessage } from "../../../packages/signals/src/ingestSignal";
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

async function makeSignal(symbol: string, signalTime: Date): Promise<{ signalId: string; instrumentId: string }> {
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier: `chan-${randomUUID()}` }).returning();
  const [message] = await db.insert(schema.telegramMessages).values({ telegramSourceId: source!.id, externalMessageId: "1", messageTimestamp: signalTime, rawText: `BUY ${symbol} @ 100 SL 95 TGT 110` }).returning();
  const { signalId } = await createSignalFromTelegramMessage(db, message!.id, { exchange: "NSE", instrumentType: "equity" });
  if (!signalId) throw new Error("signal not created");
  const instrument = await findInstrumentByExchangeSymbol(db, "NSE", symbol);
  if (!instrument) throw new Error("instrument not created");
  return { signalId, instrumentId: instrument.id };
}

const newsLinks = async (signalId: string) =>
  (await db.select().from(schema.signalEvidence).where(eq(schema.signalEvidence.signalId, signalId))).filter((r) => r.newsEvidenceId !== null);

describe("GDELT item discovered before the cutoff but received after it (replay safety)", () => {
  it("is excluded from decision evidence at an earlier effective as-of, and still visible standalone", async () => {
    const company = `Replayco ${randomLetters(8)}`;
    const tag = randomUUID();
    // seendate (discovery/source time) is 2026-06-01T10:00Z; the cutoff is the next day; the row is RECEIVED now (real clock), after the cutoff.
    const adapter = new GdeltNewsAdapter({
      query: "test-query",
      transport: async () => ({ status: 200, bodyText: JSON.stringify({ articles: [{ url: `https://example.invalid/${tag}`, title: `TESTFIXTURE ${company} update`, seendate: "20260601T100000Z" }] }) }),
    });
    expect(await ingestNewsItems(db, adapter, {})).toMatchObject({ inserted: 1 });
    const [row] = await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.sourceUrl, `https://example.invalid/${tag}`));
    const cutoff = new Date("2026-06-02T00:00:00Z");
    expect(row!.sourceTimestamp.getTime()).toBeLessThan(cutoff.getTime());
    expect(row!.receivedAt.getTime()).toBeGreaterThan(cutoff.getTime());
    await resolveNewsEntityMentions(db, (await db.select().from(schema.newsEvidence).where(eq(schema.newsEvidence.id, row!.id)))[0]!.id);

    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: company });
    // Re-resolve now that the company exists (mentions are resolved against existing aliases).
    const replay = await makeSignal(`RP-${randomLetters(6)}`, new Date("2026-06-02T00:00:00Z"));
    const standalone = await makeSignal(`RP-${randomLetters(6)}`, new Date("2026-06-02T00:00:00Z"));
    await linkInstrumentToCompany(db, replay.instrumentId, companyId);
    await linkInstrumentToCompany(db, standalone.instrumentId, companyId);
    await resolveNewsEntityMentions(db, row!.id);

    // Decision path with an explicit effective as-of: the later-received article must not become evidence.
    await validateSignal(db, replay.signalId, { asOf: cutoff });
    expect(await newsLinks(replay.signalId)).toHaveLength(0);
    const report = await assembleSignalIntelligence(db, replay.signalId, { asOf: cutoff });
    expect(report.core.newsContext).toHaveLength(0);

    // Documented standalone behaviour is unchanged: with no as-of there is no bound at all.
    const open = await assembleSignalIntelligence(db, standalone.signalId);
    expect(open.core.newsContext.map((n) => n.id)).toContain(row!.id);

    // The article's own timestamp stays discovery/source time, never a verified publication time.
    expect(row!.rawPayload).toMatchObject({ timestampField: "seendate", publishedAtVerified: false });
  });
});
