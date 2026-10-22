import { describe, expect, it } from "vitest";
import type { NormalizedTelegramMessage, TelegramProvider } from "../../../packages/types/src/index";
import { ingestTelegramMessages } from "../../../packages/ingestion/src/telegram";
import { normalizeUserCaptureMessage, revisionExternalId } from "../../../adapters/telegram/src/index";
import { createRecordingDb } from "../../support/recordingDb";

const CHAT_ID = -1001000000001; // synthetic
const chat = { id: CHAT_ID, type: "channel" as const, title: "Test Channel" };
const OBSERVED = new Date("2026-10-22T12:00:00.000Z");
const IMPORTED = new Date("2026-10-22T12:00:00.500Z");

const providerOf = (...messages: NormalizedTelegramMessage[]): TelegramProvider => ({
  providerName: "test",
  async fetchMessages() { return messages; },
  async getHealth() { return { providerName: "test", providerType: "telegram", status: "healthy", checkedAt: new Date() }; },
});
const original = () => normalizeUserCaptureMessage(chat, { id: 837678, date: 1_700_000_000, text: "BUY NIFTY 24500 CE" }) as NormalizedTelegramMessage;
const edited = () => normalizeUserCaptureMessage(chat, { id: 837678, date: 1_700_000_000, editDate: 1_700_000_100, text: "BUY NIFTY 24600 CE" }) as NormalizedTelegramMessage;
/** Source lookup answers with an existing source (display name matches, so no update is attempted). */
const withSource = (extra: Parameters<typeof createRecordingDb>[0] = {}) =>
  createRecordingDb({ select: (table, n) => (table === "telegram_sources" ? [{ id: "src-1", chatId: String(CHAT_ID), displayName: "Test Channel" }] : (extra.select?.(table, n) ?? [])), ...(extra.insert ? { insert: extra.insert } : {}) });
const params = { channelIdentifier: `tg_chat_${CHAT_ID}` };
const messageInserts = (calls: ReturnType<typeof createRecordingDb>["calls"]) => calls.filter((c) => c.op === "insert" && c.table === "telegram_messages");

describe("ingestTelegramMessages provenance", () => {
  it("raw messages are inserted with ON CONFLICT DO NOTHING (idempotent; a stored message is never overwritten) on every path", async () => {
    for (const provenance of [undefined, { captureMethod: "api_live" as const, observedAt: OBSERVED }]) {
      const { db, calls } = withSource();
      await ingestTelegramMessages(db, providerOf(original(), edited()), params, provenance);
      const inserts = messageInserts(calls);
      expect(inserts.length).toBe(2);
      for (const insert of inserts) expect(insert.onConflict).toBe("nothing");
      expect(calls.some((c) => c.op === "update" && c.table === "telegram_messages")).toBe(false);
    }
  });
  it("api_live: records the capture method and observed_at; imported_at stays NULL; first_seen_edited false", async () => {
    const { db, calls } = withSource();
    const summary = await ingestTelegramMessages(db, providerOf(original()), params, { captureMethod: "api_live", observedAt: OBSERVED });
    expect(summary).toMatchObject({ fetched: 1, inserted: 1, duplicates: 0 });
    const [insert] = messageInserts(calls);
    expect(insert?.values).toMatchObject({ captureMethod: "api_live", observedAt: OBSERVED, importedAt: null, firstSeenEdited: false, externalMessageId: "837678", originMessageId: "837678", editDate: null });
  });
  it("api_history: imported_at is set together with observed_at", async () => {
    const { db, calls } = withSource();
    await ingestTelegramMessages(db, providerOf(original()), params, { captureMethod: "api_history", observedAt: OBSERVED, importedAt: IMPORTED });
    expect(messageInserts(calls)[0]?.values).toMatchObject({ captureMethod: "api_history", observedAt: OBSERVED, importedAt: IMPORTED });
  });
  it("the original Bot API path is unchanged: with no provenance (or bot_webhook) no capture column is written (database defaults apply)", async () => {
    for (const provenance of [undefined, { captureMethod: "bot_webhook" as const }]) {
      const { db, calls } = withSource();
      await ingestTelegramMessages(db, providerOf(original()), params, provenance);
      const values = messageInserts(calls)[0]?.values as Record<string, unknown>;
      for (const key of ["captureMethod", "observedAt", "importedAt", "firstSeenEdited"]) expect(key in values, key).toBe(false);
      expect(calls.some((c) => c.op === "select" && c.table === "telegram_messages")).toBe(false); // no extra lookup either
    }
  });
  it("rejects incomplete or contradictory provenance before writing anything", async () => {
    const bad = [
      { captureMethod: "api_live" as const },
      { captureMethod: "api_history" as const, observedAt: OBSERVED },
      { captureMethod: "api_live" as const, observedAt: OBSERVED, importedAt: IMPORTED },
    ];
    for (const provenance of bad) {
      const { db, calls } = withSource();
      await expect(ingestTelegramMessages(db, providerOf(original()), params, provenance)).rejects.toThrow(/observedAt|importedAt/);
      expect(calls.filter((c) => c.op !== "select")).toEqual([]);
    }
  });
  it("first_seen_edited: TRUE when an edited message is the first observation of that message", async () => {
    const { db, calls } = withSource({ select: (table) => (table === "telegram_messages" ? [] : []) });
    await ingestTelegramMessages(db, providerOf(edited()), params, { captureMethod: "api_history", observedAt: OBSERVED, importedAt: IMPORTED });
    const [insert] = messageInserts(calls);
    expect(insert?.values).toMatchObject({ firstSeenEdited: true, externalMessageId: revisionExternalId("837678", 1_700_000_100, "BUY NIFTY 24600 CE"), originMessageId: "837678" });
    expect((insert?.values as { externalMessageId: string }).externalMessageId).not.toBe("837678"); // never stored as the original
  });
  it("first_seen_edited: FALSE when an earlier row of the same message (original or revision) exists", async () => {
    const { db, calls } = withSource({ select: (table) => (table === "telegram_messages" ? [{ id: "earlier" }] : []) });
    await ingestTelegramMessages(db, providerOf(edited()), params, { captureMethod: "api_live", observedAt: OBSERVED });
    expect(messageInserts(calls)[0]?.values).toMatchObject({ firstSeenEdited: false });
  });
  it("an original never triggers the first-seen lookup", async () => {
    const { db, calls } = withSource();
    await ingestTelegramMessages(db, providerOf(original()), params, { captureMethod: "api_live", observedAt: OBSERVED });
    expect(calls.some((c) => c.op === "select" && c.table === "telegram_messages")).toBe(false);
  });
  it("a repeated message is a duplicate (the conflict returns no row) and nothing is updated or deleted", async () => {
    const { db, calls } = withSource({ insert: (table) => (table === "telegram_messages" ? [] : [{ id: "x" }]) });
    const summary = await ingestTelegramMessages(db, providerOf(original()), params, { captureMethod: "api_live", observedAt: OBSERVED });
    expect(summary).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(calls.filter((c) => c.op === "update" || c.op === "delete")).toEqual([]);
  });
  it("raw text and payload are inserted exactly as received and no statement ever updates or deletes a message row", async () => {
    const { db, calls } = withSource();
    const message = original();
    await ingestTelegramMessages(db, providerOf(message), params, { captureMethod: "api_live", observedAt: OBSERVED });
    const values = messageInserts(calls)[0]?.values as { rawText: string; rawPayload: unknown };
    expect(values.rawText).toBe("BUY NIFTY 24500 CE");
    expect(values.rawPayload).toBe(message.rawPayload);
    expect(calls.filter((c) => c.table === "telegram_messages" && c.op !== "insert" && c.op !== "select")).toEqual([]);
  });
});
