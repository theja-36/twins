/**
 * Options intake and parser-version semantics against the guarded integration target (synthetic data only).
 */
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import {
  TELEGRAM_PARSER_VERSION,
  TELEGRAM_PARSER_VERSION_V1,
  createSignalFromTelegramMessage,
  reparseTelegramMessage,
} from "../../../packages/signals/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { processTelegramJob } from "../../support/workerWithTestPolicy";

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

const opts = { exchange: "NSE", instrumentType: "equity" };
async function storeMessage(rawText: string) {
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier: `chan-${randomUUID()}` }).returning();
  if (!source) throw new Error("source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({ telegramSourceId: source.id, externalMessageId: "1", messageTimestamp: new Date(), rawText })
    .returning();
  if (!message) throw new Error("message");
  return message.id;
}
async function countInstruments(symbol: string) {
  return (await db.select({ id: schema.instruments.id }).from(schema.instruments).where(eq(schema.instruments.symbol, symbol))).length;
}
async function signalsFor(messageId: string) {
  return db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, messageId));
}

describe("options intake", () => {
  it("an options message creates no signal and no instrument, and reports the unverified claim", async () => {
    const before = await countInstruments("NIFTY");
    const id = await storeMessage("BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 210 premium");
    const out = await createSignalFromTelegramMessage(db, id, opts);
    expect(out).toMatchObject({ created: false, unsupported: true });
    expect(out.optionsClaim).toMatchObject({ underlying: "NIFTY", strike: 24500, optionType: "CE", action: "buy" });
    expect(await signalsFor(id)).toHaveLength(0);
    expect(await countInstruments("NIFTY")).toBe(before);
  });

  it("an explicit reparse under the previous parser (v1) is still blocked from creating an index 'equity'", async () => {
    const before = await countInstruments("BANKNIFTY");
    const id = await storeMessage("BUY BANKNIFTY 52000 PE @ 300 SL 250 TGT 350");
    const out = await reparseTelegramMessage(db, id, { ...opts, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    expect(out).toMatchObject({ created: false, unsupported: true });
    expect(await signalsFor(id)).toHaveLength(0);
    expect(await countInstruments("BANKNIFTY")).toBe(before);
  });

  it("the worker path stores the raw message, ends with an explicit outcome and reason codes, and creates nothing else", async () => {
    const before = await countInstruments("NIFTY");
    const channel = `chan-${randomUUID()}`;
    const records: LogRecord[] = [];
    const job = {
      id: `opt-${randomUUID()}`,
      data: {
        jobType: "telegram_messages",
        providerName: "telegram-bot-webhook",
        telegram: {
          params: { channelIdentifier: channel },
          normalizedMessage: {
            channelIdentifier: channel,
            externalMessageId: "9001",
            messageTimestamp: new Date().toISOString(),
            rawText: "BUY NIFTY 24500 CE @ 120 SL 90 TGT 150",
            rawPayload: {},
          },
          exchange: "NSE",
          instrumentType: "equity",
        },
      },
    } as never;
    const outcome = await processTelegramJob(job, "opt-test", db, { logger: createStructuredLogger((r) => records.push(r)) });
    expect(outcome.outcome).toBe("options_claim_not_ingested");
    expect(outcome.reasonCodes).toEqual(expect.arrayContaining(["contract.master_unconfigured", "expiry.missing", "level_basis.unspecified", "option_premium_data.unavailable"]));
    const [source] = await db.select().from(schema.telegramSources).where(eq(schema.telegramSources.channelIdentifier, channel));
    const stored = source ? await db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.telegramSourceId, source.id)) : [];
    expect(stored).toHaveLength(1); // the raw message is preserved
    expect(stored[0]?.rawText).toContain("NIFTY 24500 CE");
    expect(await signalsFor(stored[0]?.id ?? "")).toHaveLength(0);
    expect(await countInstruments("NIFTY")).toBe(before);
    const warn = records.find((r) => r.event === "worker.options.claim_not_ingested");
    expect(warn).toBeDefined();
    expect(JSON.stringify(records)).not.toContain("BUY NIFTY"); // the raw text is not copied into logs
  });
});

describe("unsupported options-shaped input and old records", () => {
  it("an unsupported-underlying options directive creates no signal and no instrument and says why", async () => {
    const before = await countInstruments("NIFTYBANK");
    const id = await storeMessage("BUY NIFTYBANK 52000 PE @ 300 SL 250 TGT 350");
    const out = await createSignalFromTelegramMessage(db, id, opts);
    expect(out).toMatchObject({ created: false, unsupported: true, unsupportedCodes: ["underlying.unsupported_options_shape"] });
    expect(out.reason).toMatch(/unsupported underlying "NIFTYBANK"/);
    expect(await signalsFor(id)).toHaveLength(0);
    expect(await countInstruments("NIFTYBANK")).toBe(before);
    const stored = await db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.id, id));
    expect(stored[0]?.rawText).toContain("NIFTYBANK"); // raw message preserved
  });

  it("an ordinary retry never reinterprets an old v1 record as an options signal; an explicit v2 reparse of options text creates nothing", async () => {
    const id = await storeMessage("BUY NIFTY 24500 CE 29 OCT 2026 @ 120 SL 90 TGT 150 premium");
    const [instrument] = await db.insert(schema.instruments).values({ symbol: `OLDREC-${randomLetters(6)}`, exchange: "NSE", instrumentType: "equity" }).returning();
    if (!instrument) throw new Error("instrument");
    const [old] = await db.insert(schema.signals).values({ sourceType: "telegram", telegramMessageId: id, parserVersion: TELEGRAM_PARSER_VERSION_V1, instrumentId: instrument.id, direction: "buy", signalTimestamp: new Date() }).returning();
    if (!old) throw new Error("signal");
    const retry = await createSignalFromTelegramMessage(db, id, opts);
    expect(retry).toMatchObject({ created: false, reused: true, signalId: old.id, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    expect(retry.optionsClaim).toBeUndefined(); // the old record is reused as-is, not re-read as an options signal
    const reparse = await reparseTelegramMessage(db, id, { ...opts, parserVersion: TELEGRAM_PARSER_VERSION });
    expect(reparse).toMatchObject({ created: false, unsupported: true });
    expect(await signalsFor(id)).toHaveLength(1);
    expect((await signalsFor(id))[0]?.instrumentId).toBe(instrument.id);
  });
});

describe("parser version semantics after the v2 bump", () => {
  it("a normal retry reuses the existing v1 signal; no extra signal is created because the current version changed", async () => {
    const id = await storeMessage(`BUY V1RETRY${randomLetters(5)} @ 100 SL 95 TGT 110`);
    const legacy = await reparseTelegramMessage(db, id, { ...opts, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    expect(legacy).toMatchObject({ created: true, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    const retry = await createSignalFromTelegramMessage(db, id, opts);
    expect(retry).toMatchObject({ created: false, reused: true, signalId: legacy.signalId, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    expect(await signalsFor(id)).toHaveLength(1);
  });

  it("a new equity message is parsed under the current version; an explicit reparse under it is a deliberate extra row", async () => {
    const id = await storeMessage(`BUY NEWV2${randomLetters(5)} @ 100 SL 95 TGT 110`);
    const first = await createSignalFromTelegramMessage(db, id, opts);
    expect(first).toMatchObject({ created: true, parserVersion: TELEGRAM_PARSER_VERSION });
    expect(TELEGRAM_PARSER_VERSION).toBe("telegram-regex-v2");
    const again = await createSignalFromTelegramMessage(db, id, opts);
    expect(again).toMatchObject({ created: false, reused: true, signalId: first.signalId });
    const v1 = await reparseTelegramMessage(db, id, { ...opts, parserVersion: TELEGRAM_PARSER_VERSION_V1 });
    expect(v1.created).toBe(true); // explicit, named reparse
    expect(await signalsFor(id)).toHaveLength(2);
  });
});
