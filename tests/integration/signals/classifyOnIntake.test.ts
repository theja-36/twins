/**
 * Classification at intake against REAL PostgreSQL, through the real worker path (processTelegramJob). The flag is OFF by default; when on, a newly recorded options claim gets one
 * append-only classification row (codes only, with provenance); a classification failure never loses or blocks the intake and is healed by a retry; nothing else changes.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema } from "../../../packages/database/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { CLASSIFIER_VERSION } from "../../../packages/signals/src/classification/index";
import { processTelegramJob } from "../../support/workerWithTestPolicy";
import { marketDataProviders, YAHOO_PROVIDER_NAME, type MarketDataProvider } from "../../../adapters/market/src/index";
import { failFirstInserts } from "../runtime/harness";
import { requireTestDatabaseUrl } from "../targetConfig";

const offlineMarket: MarketDataProvider = { providerName: YAHOO_PROVIDER_NAME, async getHistoricalBars() { return []; }, async getLatestQuote() { return null; }, async getHealth() { return { providerName: YAHOO_PROVIDER_NAME, providerType: "market", status: "healthy", checkedAt: new Date() }; } };
marketDataProviders.register(YAHOO_PROVIDER_NAME, offlineMarket);
const db = createDb(requireTestDatabaseUrl());
afterAll(async () => { await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end(); });

const TEXT = "SECRETWORD INTRADAY BREAKOUT BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
const job = (channel: string, externalId: string, rawText: string) => ({ id: `ci-${randomUUID()}`, data: { jobType: "telegram_messages", providerName: "telegram-bot-webhook", telegram: { params: { channelIdentifier: channel }, normalizedMessage: { channelIdentifier: channel, externalMessageId: externalId, messageTimestamp: new Date().toISOString(), rawText, rawPayload: {} }, exchange: "NSE", instrumentType: "equity" } } }) as never;
async function run(o: { channel: string; id: string; text?: string; classifyOnIntake?: boolean; worker?: typeof db }) {
  const records: LogRecord[] = [];
  const outcome = await processTelegramJob(job(o.channel, o.id, o.text ?? TEXT), "ci-test", o.worker ?? db, { logger: createStructuredLogger((r) => records.push(r)), ...(o.classifyOnIntake === undefined ? {} : { classifyOnIntake: o.classifyOnIntake }) });
  const [source] = await db.select().from(schema.telegramSources).where(eq(schema.telegramSources.channelIdentifier, o.channel));
  const [message] = source ? await db.select().from(schema.telegramMessages).where(and(eq(schema.telegramMessages.telegramSourceId, source.id), eq(schema.telegramMessages.externalMessageId, o.id))) : [];
  const claims = message ? await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, message.id)) : [];
  const classes = claims[0] ? await db.select().from(schema.signalClassifications).where(eq(schema.signalClassifications.claimId, claims[0].id)) : [];
  return { outcome, records, claims, classes };
}
const ids = () => ({ channel: `chan-${randomUUID()}`, id: String(Math.floor(Math.random() * 1e9)) });

describe("classification at intake", () => {
  it("is OFF by default: the claim is recorded exactly as before and nothing is classified", async () => {
    const r = await run({ ...ids() });
    expect(r.outcome).toMatchObject({ outcome: "options_claim_not_ingested" }); expect(r.claims).toHaveLength(1); expect(r.classes).toHaveLength(0);
    expect(r.records.some((x) => String(x.event ?? x.message ?? "").includes("worker.classification"))).toBe(false);
  });
  it("when ON, stores one classification per claim with provenance, codes only (no message text), and the intake outcome is unchanged", async () => {
    const off = await run({ ...ids(), classifyOnIntake: false }), on = await run({ ...ids(), classifyOnIntake: true });
    expect(on.outcome.outcome).toBe(off.outcome.outcome); expect(on.claims).toHaveLength(1); expect(on.claims[0]).toMatchObject({ resultKind: "claim", approvalPossible: false }); // same claim, still never approvable
    expect(on.classes).toHaveLength(1);
    expect(on.classes[0]).toMatchObject({ claimId: on.claims[0]?.id, classifierVersion: CLASSIFIER_VERSION, signalType: "OPTIONS_BUY", horizon: "INTRADAY", setup: "BREAKOUT" });
    expect(JSON.stringify(on.classes[0])).not.toContain("SECRETWORD");
  });
  it("is idempotent: a retry of the same message keeps a single classification", async () => {
    const x = ids(); await run({ ...x, classifyOnIntake: true }); const again = await run({ ...x, classifyOnIntake: true });
    expect(again.claims).toHaveLength(1); expect(again.classes).toHaveLength(1);
  });
  it("a classification failure never loses or blocks the intake: the claim is recorded, a warning names the error class only, and the retry heals it", async () => {
    const x = ids();
    const failing = await run({ ...x, classifyOnIntake: true, worker: failFirstInserts(db as never, "signal_classifications", 1) as never });
    expect(failing.outcome).toMatchObject({ outcome: "options_claim_not_ingested" }); expect(failing.claims).toHaveLength(1); expect(failing.classes).toHaveLength(0);
    const warn = failing.records.find((r) => JSON.stringify(r).includes("worker.classification.failed")); expect(warn).toBeDefined(); expect(JSON.stringify(warn)).not.toContain("SECRETWORD"); expect(JSON.stringify(warn)).not.toContain("injected transient failure");
    const healed = await run({ ...x, classifyOnIntake: true });
    expect(healed.claims).toHaveLength(1); expect(healed.classes).toHaveLength(1);
  });
  it("messages that are not complete claims are not classified and cause no error", async () => {
    const r = await run({ ...ids(), classifyOnIntake: true, text: "BUY SENSEX NIFTY CE" });
    expect(r.classes).toHaveLength(0); expect(r.records.some((x) => JSON.stringify(x).includes("worker.classification.failed"))).toBe(false);
  });
});
