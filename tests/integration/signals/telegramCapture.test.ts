/**
 * User API capture (migration 0007) against the REAL worker path and a MIGRATED guarded integration database.
 * WRITTEN in T2a-1, RUN in T2a-2 only (it needs the 0007 schema). Uses explicit REAL policies, never the allow-all wrapper.
 * Rows created here use unique random chat ids and are retained by design. Probes of constraints and of the append-only
 * trigger run inside transactions that are ALWAYS rolled back, so even a missing trigger could not remove retained events.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireTestDatabaseUrl } from "../targetConfig";
import { createDb, schema } from "../../../packages/database/src/index";
import { processTelegramEventsQueueJob, processTelegramJob } from "../../../services/worker/src/index";
import { createTelegramIntakePolicy, normalizeUserCaptureMessage, textSha256Hex, type UserCaptureMessage } from "../../../adapters/telegram/src/index";
import { createStructuredLogger } from "../../../packages/shared/src/index";
import { marketDataProviders, YAHOO_PROVIDER_NAME, type MarketDataProvider } from "../../../adapters/market/src/index";

let marketCalls = 0;
const spyMarket: MarketDataProvider = {
  providerName: YAHOO_PROVIDER_NAME,
  async getHistoricalBars() { marketCalls += 1; return []; },
  async getLatestQuote() { marketCalls += 1; return null; },
  async getHealth() { return { providerName: YAHOO_PROVIDER_NAME, providerType: "market", status: "healthy", checkedAt: new Date() }; },
};
marketDataProviders.register(YAHOO_PROVIDER_NAME, spyMarket);

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => { await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end(); });

const freshChat = () => -(1_000_000_000_000 + Math.floor(Math.random() * 900_000_000_000));
const freshId = () => Math.floor(Math.random() * 1e9) + 1;
const logger = () => createStructuredLogger(() => undefined);
const OPTIONS_TEXT = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

type Method = "api_live" | "api_history";
const policyFor = (chat: number, optionsOnly = false) => createTelegramIntakePolicy({ allowedChatIds: String(chat), optionsOnly: optionsOnly ? "true" : "false" });

/** A message job exactly as the internal endpoint builds it, after the BullMQ JSON round trip. */
function messageJob(chat: number, message: UserCaptureMessage, method: Method = "api_live", observedAt = new Date()) {
  const normalized = normalizeUserCaptureMessage({ id: chat, type: "channel" }, message);
  if (!normalized) throw new Error("fixture must have text");
  const captureMeta = { captureMethod: method, observedAt: observedAt.toISOString(), ...(method === "api_history" ? { importedAt: observedAt.toISOString(), importBatchId: randomUUID() } : {}) };
  return {
    id: `cap-${randomUUID()}`,
    data: JSON.parse(JSON.stringify({
      jobType: "telegram_messages",
      providerName: "telegram-user-capture",
      telegram: { params: { channelIdentifier: normalized.channelIdentifier }, normalizedMessage: normalized, exchange: "NSE", instrumentType: "equity", capture: captureMeta },
    })),
  } as never;
}
function deleteJob(chat: number, ids: number[], method: Method = "api_live") {
  return {
    id: `del-${randomUUID()}`,
    data: { jobType: "telegram_events", providerName: "telegram-user-capture", events: { kind: "delete", channelIdentifier: `tg_chat_${chat}`, chatId: String(chat), messageIds: ids.map(String), capture: { captureMethod: method, observedAt: new Date().toISOString() } } },
  } as never;
}
const runMessage = (job: never, policy: ReturnType<typeof createTelegramIntakePolicy>) => processTelegramJob(job, "cap-test", db, { logger: logger(), intakePolicy: policy });
const runEvents = (job: never, policy: ReturnType<typeof createTelegramIntakePolicy>) => processTelegramEventsQueueJob(job, "cap-test", db, { logger: logger(), intakePolicy: policy });

async function sourceOf(chat: number) {
  const [source] = await db.select().from(schema.telegramSources).where(eq(schema.telegramSources.channelIdentifier, `tg_chat_${chat}`));
  return source;
}
async function messagesOf(chat: number) {
  const source = await sourceOf(chat);
  return source ? db.select().from(schema.telegramMessages).where(eq(schema.telegramMessages.telegramSourceId, source.id)).orderBy(asc(schema.telegramMessages.externalMessageId)) : [];
}
async function eventsOf(chat: number) {
  const source = await sourceOf(chat);
  return source ? db.select().from(schema.telegramMessageEvents).where(eq(schema.telegramMessageEvents.telegramSourceId, source.id)).orderBy(asc(schema.telegramMessageEvents.idempotencyKey)) : [];
}
/** Hash of every column of the given rows: any change to an existing raw message changes it. */
const fingerprint = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

class Rollback extends Error {}
/** Runs `statement` in a transaction that is ALWAYS rolled back; returns the SQLSTATE of the error it raised, if any. */
async function sqlstateOf(statement: (tx: typeof db) => Promise<unknown>): Promise<string | undefined> {
  let code: string | undefined;
  try {
    await db.transaction(async (tx) => {
      try { await statement(tx as unknown as typeof db); } catch (error) {
        const e = error as { code?: string; cause?: { code?: string } };
        code = e.cause?.code ?? e.code;
      }
      throw new Rollback();
    });
  } catch (error) { if (!(error instanceof Rollback)) throw error; }
  return code;
}

describe("live capture of messages", () => {
  it("stores the message with its provenance and writes one content-free `seen` event", async () => {
    const chat = freshChat();
    const id = freshId();
    const text = `  verbatim ${OPTIONS_TEXT}\r\n `;
    const before = Date.now();
    await runMessage(messageJob(chat, { id, date: NOW_SECONDS() - 30, text }), policyFor(chat));
    const [row] = await messagesOf(chat);
    expect(row).toMatchObject({ externalMessageId: String(id), originMessageId: String(id), rawText: text, captureMethod: "api_live", importedAt: null, firstSeenEdited: false });
    expect(row?.observedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const events = await eventsOf(chat);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "seen", captureMethod: "api_live", externalMessageId: String(id), telegramMessageId: row?.id, contentSha256: textSha256Hex(text), sourceEditDate: null });
    expect(JSON.stringify(events[0])).not.toContain("verbatim"); // hash only, never the text
  });
  it("is idempotent: the same job twice, and live then history of the same message, give ONE row and ONE seen event", async () => {
    const chat = freshChat();
    const id = freshId();
    const message = { id, date: NOW_SECONDS() - 30, text: "same message" };
    const live = messageJob(chat, message);
    await runMessage(live, policyFor(chat));
    await runMessage(live, policyFor(chat));
    await runMessage(messageJob(chat, message, "api_history"), policyFor(chat));
    const rows = await messagesOf(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ captureMethod: "api_live", importedAt: null }); // first observation wins; later copies change nothing
    expect(await eventsOf(chat)).toHaveLength(1);
  });
  it("an edit creates a revision and leaves the original row byte-identical; replaying the edit adds nothing", async () => {
    const chat = freshChat();
    const id = freshId();
    const date = NOW_SECONDS() - 600;
    await runMessage(messageJob(chat, { id, date, text: "original text" }), policyFor(chat));
    const [original] = await messagesOf(chat);
    const originalPrint = fingerprint([original]);
    const edit = messageJob(chat, { id, date, editDate: date + 120, text: "edited text" });
    await runMessage(edit, policyFor(chat));
    await runMessage(edit, policyFor(chat));
    const rows = await messagesOf(chat);
    expect(rows).toHaveLength(2);
    const afterOriginal = rows.find((r) => r.id === original?.id);
    expect(fingerprint([afterOriginal])).toBe(originalPrint); // the raw original is untouched
    expect(afterOriginal?.rawText).toBe("original text");
    const revision = rows.find((r) => r.id !== original?.id);
    expect(revision).toMatchObject({ originMessageId: String(id), rawText: "edited text", firstSeenEdited: false, captureMethod: "api_live" });
    expect(revision?.externalMessageId).toMatch(new RegExp(`^${id}_edit_${date + 120}_[0-9a-f]{12}$`));
    const events = await eventsOf(chat);
    expect(events.map((e) => e.eventType).sort()).toEqual(["edited_observed", "seen"]);
    expect(events.find((e) => e.eventType === "edited_observed")).toMatchObject({ contentSha256: textSha256Hex("edited text"), telegramMessageId: revision?.id });
  });
  it("a message first seen already edited (history) is stored under the revision identity, flagged, and never as the original", async () => {
    const chat = freshChat();
    const id = freshId();
    const date = NOW_SECONDS() - 3600;
    await runMessage(messageJob(chat, { id, date, editDate: date + 60, text: "already edited when first seen" }, "api_history"), policyFor(chat));
    const rows = await messagesOf(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstSeenEdited: true, captureMethod: "api_history", originMessageId: String(id) });
    expect(rows[0]?.importedAt).toBeInstanceOf(Date);
    expect(rows[0]?.observedAt).toBeInstanceOf(Date);
    expect(rows[0]?.externalMessageId).not.toBe(String(id));
    expect((await eventsOf(chat)).map((e) => e.eventType)).toEqual(["edited_observed"]);
  });
});

describe("deletions are events, never deletions", () => {
  it("records deleted_observed for stored and unknown ids, leaves every stored message byte-identical, and is idempotent", async () => {
    const chat = freshChat();
    const id = freshId();
    const date = NOW_SECONDS() - 600;
    await runMessage(messageJob(chat, { id, date, text: "will be deleted upstream" }), policyFor(chat));
    await runMessage(messageJob(chat, { id, date, editDate: date + 30, text: "edited before deletion" }), policyFor(chat));
    const before = fingerprint(await messagesOf(chat));
    const unknownId = id + 1;
    const job = deleteJob(chat, [id, unknownId]);
    await runEvents(job, policyFor(chat));
    await runEvents(job, policyFor(chat));
    expect(fingerprint(await messagesOf(chat))).toBe(before); // nothing removed, nothing altered
    const deletions = (await eventsOf(chat)).filter((e) => e.eventType === "deleted_observed");
    expect(deletions).toHaveLength(2);
    const known = deletions.find((e) => e.externalMessageId === String(id));
    const unknown = deletions.find((e) => e.externalMessageId === String(unknownId));
    expect(known?.telegramMessageId).not.toBeNull();
    expect(unknown?.telegramMessageId).toBeNull();
    expect(await messagesOf(chat)).toHaveLength(2);
  });
});

describe("gates", () => {
  it("an unapproved chat leaves no source, message or event, for message jobs and event jobs", async () => {
    const approved = freshChat();
    const stranger = freshChat();
    await runMessage(messageJob(stranger, { id: freshId(), date: NOW_SECONDS() - 30, text: OPTIONS_TEXT }), policyFor(approved));
    await runEvents(deleteJob(stranger, [freshId()]), policyFor(approved));
    expect(await sourceOf(stranger)).toBeUndefined();
    expect(await messagesOf(stranger)).toEqual([]);
    expect(await eventsOf(stranger)).toEqual([]);
  });
  it("options-only blocks equity text before anything is stored; an options message becomes a never-approvable UNVERIFIED claim with provenance", async () => {
    const chat = freshChat();
    const policy = policyFor(chat, true);
    const calls = marketCalls;
    const symbol = `ZZ${randomLetters()}`;
    await runMessage(messageJob(chat, { id: freshId(), date: NOW_SECONDS() - 30, text: `BUY ${symbol} @ 100 SL 95 TGT 110` }), policy);
    expect(await messagesOf(chat)).toEqual([]);
    expect(await eventsOf(chat)).toEqual([]);
    const outcome = await runMessage(messageJob(chat, { id: freshId(), date: NOW_SECONDS() - 20, text: OPTIONS_TEXT }), policy);
    expect(outcome).toMatchObject({ outcome: "options_claim_not_ingested" });
    const [row] = await messagesOf(chat);
    expect(row).toMatchObject({ captureMethod: "api_live" });
    const claims = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, row?.id ?? ""));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.approvalPossible).toBe(false);
    expect((await db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, row?.id ?? "")))).toEqual([]);
    expect(marketCalls).toBe(calls);
  });
});

function randomLetters(): string {
  return Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
}

describe("database rules (each probe runs in a transaction that is rolled back)", () => {
  async function existingMessage() {
    const chat = freshChat();
    await runMessage(messageJob(chat, { id: freshId(), date: NOW_SECONDS() - 30, text: "seed for constraint probes" }), policyFor(chat));
    const [row] = await messagesOf(chat);
    const source = await sourceOf(chat);
    return { chat, row: row!, source: source! };
  }
  const eventValues = (sourceId: string, over: Record<string, unknown> = {}) => ({
    telegramSourceId: sourceId, externalMessageId: "1", eventType: "seen", captureMethod: "api_live", observedAt: new Date(), idempotencyKey: `probe:${randomUUID()}`, ...over,
  });

  it("telegram_messages CHECKs: history needs imported_at (and only history has it); api captures need observed_at; method is a closed set", async () => {
    const { source } = await existingMessage();
    const base = (over: Record<string, unknown>) => ({ telegramSourceId: source.id, externalMessageId: `probe-${randomUUID()}`, messageTimestamp: new Date(), rawText: "x", ...over });
    const probe = (over: Record<string, unknown>) => sqlstateOf((tx) => tx.insert(schema.telegramMessages).values(base(over) as never));
    expect(await probe({ captureMethod: "api_history", observedAt: new Date() })).toBe("23514");               // history without imported_at
    expect(await probe({ captureMethod: "api_live", observedAt: new Date(), importedAt: new Date() })).toBe("23514"); // imported_at on a live row
    expect(await probe({ captureMethod: "api_live" })).toBe("23514");                                          // api capture without observed_at
    expect(await probe({ captureMethod: "carrier_pigeon", observedAt: new Date() })).toBe("23514");
    expect(await probe({ captureMethod: "api_history", observedAt: new Date(), importedAt: new Date() })).toBeUndefined();
    expect(await probe({ captureMethod: "bot_webhook" })).toBeUndefined();                                      // legacy shape stays valid
    expect(await probe({})).toBeUndefined();
  });
  it("legacy rows were never backfilled: no bot_webhook row has observed_at or imported_at", async () => {
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from telegram_messages where capture_method = 'bot_webhook' and (observed_at is not null or imported_at is not null)`)).rows as Array<{ n: number }>;
    expect(n).toBe(0);
  });
  it("telegram_message_events CHECKs and the unique idempotency key", async () => {
    const { source } = await existingMessage();
    const insert = (over: Record<string, unknown>) => sqlstateOf((tx) => tx.insert(schema.telegramMessageEvents).values(eventValues(source.id, over) as never));
    expect(await insert({})).toBeUndefined();
    expect(await insert({ eventType: "message_text" })).toBe("23514");
    expect(await insert({ captureMethod: "bot_webhook" })).toBe("23514");
    expect(await insert({ contentSha256: "BUY NIFTY" })).toBe("23514");
    expect(await insert({ contentSha256: "A".repeat(64) })).toBe("23514");
    expect(await insert({ contentSha256: "a".repeat(64) })).toBeUndefined();
    expect(await insert({ rawMeta: { blob: "x".repeat(5000) } })).toBe("23514");
    const duplicate = await sqlstateOf(async (tx) => {
      const values = eventValues(source.id);
      await tx.insert(schema.telegramMessageEvents).values(values as never);
      await tx.insert(schema.telegramMessageEvents).values(values as never);
    });
    expect(duplicate).toBe("23505");
  });
  it("the events table is APPEND-ONLY: UPDATE, DELETE and TRUNCATE are rejected by the trigger (SQLSTATE 23001)", async () => {
    const { chat, source } = await existingMessage();
    const eventId = (await eventsOf(chat))[0]?.id;
    expect(eventId).toBeDefined();
    const countBefore = (await db.execute(sql`select count(*)::int as n from telegram_message_events`)).rows[0] as { n: number };
    expect(await sqlstateOf((tx) => tx.execute(sql`update telegram_message_events set observed_at = now() where id = ${eventId}`))).toBe("23001");
    expect(await sqlstateOf((tx) => tx.execute(sql`update telegram_message_events set capture_method = 'api_history' where telegram_source_id = ${source.id}`))).toBe("23001");
    expect(await sqlstateOf((tx) => tx.execute(sql`delete from telegram_message_events where id = ${eventId}`))).toBe("23001");
    expect(await sqlstateOf((tx) => tx.execute(sql`delete from telegram_message_events where telegram_source_id = ${source.id}`))).toBe("23001");
    expect(await sqlstateOf((tx) => tx.execute(sql`truncate table telegram_message_events`))).toBe("23001");
    const countAfter = (await db.execute(sql`select count(*)::int as n from telegram_message_events`)).rows[0] as { n: number };
    expect(countAfter.n).toBe(countBefore.n);
  });
  it("the events table has no column that could hold message text", async () => {
    const rows = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'telegram_message_events'`)).rows as Array<{ column_name: string }>;
    expect(rows.map((r) => r.column_name).sort()).toEqual(["capture_method", "content_sha256", "created_at", "event_type", "external_message_id", "id", "idempotency_key", "observed_at", "raw_meta", "source_edit_date", "telegram_message_id", "telegram_source_id"]);
  });
  it("a stored message cannot be removed while events reference it (ON DELETE RESTRICT)", async () => {
    const { chat, row } = await existingMessage();
    expect((await eventsOf(chat)).length).toBeGreaterThan(0);
    expect(await sqlstateOf((tx) => tx.delete(schema.telegramMessages).where(and(eq(schema.telegramMessages.id, row.id)))  )).toBe("23503");
  });
});
