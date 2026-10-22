import { describe, expect, it } from "vitest";
import { buildEventKey, recordCaptureEvent, recordDeletionEvents } from "../../../packages/ingestion/src/captureEvents";
import { createRecordingDb } from "../../support/recordingDb";

const SRC = "11111111-1111-4111-8111-111111111111";
const OBSERVED = new Date("2026-10-22T12:00:00.000Z");
const HASH = "a".repeat(64);

describe("buildEventKey", () => {
  it("is `<source>:<message>:<type>:<edit unix or 0>:<hash12 or 0>`", () => {
    expect(buildEventKey({ telegramSourceId: SRC, externalMessageId: "42", eventType: "seen" })).toBe(`${SRC}:42:seen:0:0`);
    expect(buildEventKey({ telegramSourceId: SRC, externalMessageId: "42", eventType: "edited_observed", sourceEditDate: new Date(1_700_000_100_000), contentSha256: HASH })).toBe(`${SRC}:42:edited_observed:1700000100:${"a".repeat(12)}`);
    expect(buildEventKey({ telegramSourceId: SRC, externalMessageId: "42", eventType: "deleted_observed" })).toBe(`${SRC}:42:deleted_observed:0:0`);
  });
  it("distinguishes types, messages, sources, edit dates and contents", () => {
    const base = { telegramSourceId: SRC, externalMessageId: "42", eventType: "edited_observed" as const, sourceEditDate: new Date(1000), contentSha256: HASH };
    const keys = new Set([
      buildEventKey(base),
      buildEventKey({ ...base, eventType: "seen" }),
      buildEventKey({ ...base, externalMessageId: "43" }),
      buildEventKey({ ...base, telegramSourceId: "22222222-2222-4222-8222-222222222222" }),
      buildEventKey({ ...base, sourceEditDate: new Date(2000) }),
      buildEventKey({ ...base, contentSha256: "b".repeat(64) }),
    ]);
    expect(keys.size).toBe(6);
  });
  it("ignores observed_at: re-observing the same fact yields the same key (idempotency)", () => {
    const a = buildEventKey({ telegramSourceId: SRC, externalMessageId: "42", eventType: "seen" });
    expect(a).toBe(buildEventKey({ telegramSourceId: SRC, externalMessageId: "42", eventType: "seen" }));
  });
});

describe("recordCaptureEvent", () => {
  it("issues ON CONFLICT DO NOTHING (never DO UPDATE) so a repeated observation is idempotent and cannot alter an event", async () => {
    const { db, calls } = createRecordingDb();
    await recordCaptureEvent(db, { telegramSourceId: SRC, externalMessageId: "42", eventType: "seen", captureMethod: "api_live", observedAt: OBSERVED, contentSha256: HASH });
    expect(calls[0]?.onConflict).toBe("nothing");
  });
  it("inserts content-free metadata only, and reports whether the event was new", async () => {
    const { db, calls } = createRecordingDb();
    const isNew = await recordCaptureEvent(db, {
      telegramSourceId: SRC, telegramMessageId: "m-1", externalMessageId: "42", eventType: "seen", captureMethod: "api_live", observedAt: OBSERVED,
      contentSha256: HASH, meta: { importBatchId: "x".repeat(200), clientObservedAt: "y".repeat(200), firstSeenEdited: true },
    });
    expect(isNew).toBe(true);
    const values = calls[0]?.values as Record<string, unknown>;
    expect(calls[0]).toMatchObject({ op: "insert", table: "telegram_message_events" });
    expect(values).toMatchObject({ eventType: "seen", captureMethod: "api_live", contentSha256: HASH, idempotencyKey: `${SRC}:42:seen:0:${"a".repeat(12)}`, telegramMessageId: "m-1" });
    const meta = values["rawMeta"] as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["clientObservedAt", "firstSeenEdited", "importBatchId"]);
    expect((meta["importBatchId"] as string).length).toBeLessThanOrEqual(64);
    expect((meta["clientObservedAt"] as string).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(values)).not.toMatch(/rawText|text":/);
  });
  it("a repeated event is not new (the unique key conflicts) and writes nothing else", async () => {
    const { db, calls } = createRecordingDb({ insert: () => [] });
    const isNew = await recordCaptureEvent(db, { telegramSourceId: SRC, externalMessageId: "42", eventType: "seen", captureMethod: "api_live", observedAt: OBSERVED });
    expect(isNew).toBe(false);
    expect(calls.map((c) => c.op)).toEqual(["insert"]);
  });
  it("accepts only a lowercase 64-hex content hash (the text can never be passed through)", async () => {
    const { db, calls } = createRecordingDb();
    for (const bad of ["BUY NIFTY", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      await expect(recordCaptureEvent(db, { telegramSourceId: SRC, externalMessageId: "1", eventType: "seen", captureMethod: "api_live", observedAt: OBSERVED, contentSha256: bad })).rejects.toThrow(/64 lowercase hex/);
    }
    expect(calls).toEqual([]);
  });
  it("a missing message reference is stored as NULL", async () => {
    const { db, calls } = createRecordingDb();
    await recordCaptureEvent(db, { telegramSourceId: SRC, externalMessageId: "42", eventType: "deleted_observed", captureMethod: "api_live", observedAt: OBSERVED });
    expect((calls[0]?.values as { telegramMessageId: unknown }).telegramMessageId).toBeNull();
  });
});

describe("recordDeletionEvents", () => {
  it("records one event per distinct id, linking stored originals, with NULL for unknown ids", async () => {
    const { db, calls } = createRecordingDb({ select: (table) => (table === "telegram_messages" ? [{ id: "row-a", externalMessageId: "10" }] : []) });
    const summary = await recordDeletionEvents(db, { telegramSourceId: SRC, messageIds: ["10", "11", "10"], captureMethod: "api_live", observedAt: OBSERVED, meta: { importBatchId: "b" } });
    expect(summary).toEqual({ recorded: 2, duplicates: 0, unknownMessages: 1 });
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.values as { externalMessageId: string }).externalMessageId)).toEqual(["10", "11"]);
    expect(inserts.map((c) => (c.values as { telegramMessageId: string | null }).telegramMessageId)).toEqual(["row-a", null]);
    expect(inserts.every((c) => (c.values as { eventType: string }).eventType === "deleted_observed")).toBe(true);
  });
  it("a deletion NEVER writes, updates or deletes a message: only a read of telegram_messages and inserts into the events table", async () => {
    const { db, calls } = createRecordingDb({ select: () => [{ id: "row-a", externalMessageId: "10" }] });
    await recordDeletionEvents(db, { telegramSourceId: SRC, messageIds: ["10"], captureMethod: "api_history", observedAt: OBSERVED });
    for (const call of calls) {
      if (call.table === "telegram_messages") expect(call.op).toBe("select");
      else expect(call).toMatchObject({ op: "insert", table: "telegram_message_events" });
    }
    expect(calls.some((c) => c.op === "update" || c.op === "delete")).toBe(false);
  });
  it("is idempotent: events that already exist are counted as duplicates", async () => {
    const { db } = createRecordingDb({ insert: () => [] });
    expect(await recordDeletionEvents(db, { telegramSourceId: SRC, messageIds: ["10", "11"], captureMethod: "api_live", observedAt: OBSERVED })).toEqual({ recorded: 0, duplicates: 2, unknownMessages: 2 });
  });
  it("an empty id list does nothing at all", async () => {
    const { db, calls } = createRecordingDb();
    expect(await recordDeletionEvents(db, { telegramSourceId: SRC, messageIds: [], captureMethod: "api_live", observedAt: OBSERVED })).toEqual({ recorded: 0, duplicates: 0, unknownMessages: 0 });
    expect(calls).toEqual([]);
  });
});
