import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { createTelegramIntakePolicy } from "../../../adapters/telegram/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { InvalidJobInputError } from "../../../services/worker/src/jobErrors";
import { parseCapture, processTelegramEventsJob, type TelegramEventsJobPayload } from "../../../services/worker/src/telegramEvents";
import { processSignalQueueJob } from "../../../services/worker/src/index"; // the REAL entry point (no allow-all wrapper)
import { createRecordingDb } from "../../support/recordingDb";

const CHAT_ID = -1001000000001; // synthetic
const OTHER = -1002000000002;
const policy = createTelegramIntakePolicy({ allowedChatIds: String(CHAT_ID) });
const BATCH = "0b9f2c3e-7d41-4a8e-9a55-6f1d2c3b4a5e";
const capture = (extra: Record<string, unknown> = {}) => ({ captureMethod: "api_live", observedAt: "2026-10-22T12:00:00.000Z", ...extra });
const eventsJob = (over: Partial<TelegramEventsJobPayload["events"]> = {}): TelegramEventsJobPayload => ({
  jobType: "telegram_events",
  providerName: "telegram-user-capture",
  events: { kind: "delete", channelIdentifier: `tg_chat_${CHAT_ID}`, chatId: String(CHAT_ID), messageIds: ["10", "11"], capture: capture() as never, ...over },
});
const logs = () => { const records: LogRecord[] = []; return { records, logger: createStructuredLogger((r) => records.push(r)) }; };
const sourceRow = { id: "src-1", chatId: String(CHAT_ID), displayName: null };
const dbWithSource = (extra: Parameters<typeof createRecordingDb>[0] = {}) =>
  createRecordingDb({ select: (table, n) => (table === "telegram_sources" ? [sourceRow] : (extra.select?.(table, n) ?? [])), ...(extra.insert ? { insert: extra.insert } : {}) });

describe("parseCapture (strict)", () => {
  it("accepts live and history provenance", () => {
    expect(parseCapture(capture())).toEqual({ captureMethod: "api_live", observedAt: new Date("2026-10-22T12:00:00.000Z") });
    const history = parseCapture(capture({ captureMethod: "api_history", importedAt: "2026-10-22T12:00:01.000Z", importBatchId: BATCH.toUpperCase(), clientObservedAt: "2026-10-22T12:00:00Z" }));
    expect(history).toMatchObject({ captureMethod: "api_history", importBatchId: BATCH, clientObservedAt: "2026-10-22T12:00:00Z" });
    expect(history.importedAt).toEqual(new Date("2026-10-22T12:00:01.000Z"));
  });
  it("rejects every malformed form as permanent invalid input", () => {
    const bad: unknown[] = [
      null, "x", [], 5,
      capture({ captureMethod: "bot_webhook" }), capture({ captureMethod: "other" }), capture({ captureMethod: undefined }),
      capture({ observedAt: "yesterday" }), capture({ observedAt: undefined }), capture({ observedAt: 12345 }),
      capture({ importedAt: "2026-10-22T12:00:01.000Z" }),                 // importedAt on a live capture
      capture({ captureMethod: "api_history" }),                            // history without importedAt
      capture({ importBatchId: "not-a-uuid" }), capture({ importBatchId: 7 }),
      capture({ clientObservedAt: "x".repeat(41) }), capture({ clientObservedAt: 5 }),
      capture({ extra: "field" }),
    ];
    for (const value of bad) expect(() => parseCapture(value), JSON.stringify(value)).toThrow(InvalidJobInputError);
  });
});

describe("processTelegramEventsJob", () => {
  it("rejects an unapproved chat BEFORE any database access", async () => {
    for (const chat of [{ chatId: String(OTHER), channelIdentifier: `tg_chat_${OTHER}` }, { chatId: "abc", channelIdentifier: "@legacy" }, { chatId: String(CHAT_ID), channelIdentifier: `tg_chat_${OTHER}` }]) {
      const { db, calls } = createRecordingDb();
      const { records, logger } = logs();
      const outcome = await processTelegramEventsJob(eventsJob(chat), db, { logger, intakePolicy: policy });
      expect(outcome.outcome).toBe("chat_not_approved");
      expect(calls).toEqual([]);
      expect(records.some((r) => r.event === "worker.intake.chat_rejected")).toBe(true);
    }
  });
  it("the default (nothing approved) policy rejects everything", async () => {
    const { db, calls } = createRecordingDb();
    const outcome = await processTelegramEventsJob(eventsJob(), db, { logger: logs().logger, intakePolicy: createTelegramIntakePolicy({}) });
    expect(outcome.outcome).toBe("chat_not_approved");
    expect(calls).toEqual([]);
  });
  it("rejects malformed jobs as permanent invalid input without touching the database", async () => {
    const malformed: Array<Partial<TelegramEventsJobPayload["events"]>> = [
      { messageIds: [] }, { messageIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) }, { messageIds: ["0"] }, { messageIds: ["-5"] }, { messageIds: ["1.5"] },
      { messageIds: ["abc"] }, { messageIds: [5 as never] }, { messageIds: "10" as never }, { kind: "edit" as never }, { channelIdentifier: 5 as never }, { chatId: 5 as never },
    ];
    for (const over of malformed) {
      const { db, calls } = createRecordingDb();
      await expect(processTelegramEventsJob(eventsJob(over), db, { logger: logs().logger, intakePolicy: policy }), JSON.stringify(over)).rejects.toThrow(InvalidJobInputError);
      expect(calls).toEqual([]);
    }
    const { db } = createRecordingDb();
    await expect(processTelegramEventsJob(eventsJob({ capture: capture({ captureMethod: "api_history" }) as never }), db, { logger: logs().logger, intakePolicy: policy })).rejects.toThrow(InvalidJobInputError);
    await expect(processTelegramEventsJob({} as never, db, { logger: logs().logger, intakePolicy: policy })).rejects.toThrow(InvalidJobInputError);
  });
  it("records one deleted_observed event per id and removes NOTHING: no statement touches telegram_messages except a read", async () => {
    const { db, calls, callsOn } = dbWithSource({ select: (table) => (table === "telegram_messages" ? [{ id: "row-10", externalMessageId: "10" }] : []) });
    const outcome = await processTelegramEventsJob(eventsJob({ capture: capture({ importBatchId: BATCH, clientObservedAt: "2026-10-22T11:59:59Z" }) as never }), db, { logger: logs().logger, intakePolicy: policy });
    expect(outcome).toEqual({ outcome: "events_recorded", recorded: 2, duplicates: 0, unknownMessages: 1 });
    expect(callsOn("telegram_messages").every((c) => c.op === "select")).toBe(true);
    expect(calls.some((c) => c.op === "update" || c.op === "delete")).toBe(false);
    const events = callsOn("telegram_message_events");
    expect(events).toHaveLength(2);
    expect(events.map((c) => (c.values as { telegramMessageId: unknown }).telegramMessageId)).toEqual(["row-10", null]);
    expect(events[0]?.values).toMatchObject({ eventType: "deleted_observed", captureMethod: "api_live", telegramSourceId: "src-1", rawMeta: { importBatchId: BATCH, clientObservedAt: "2026-10-22T11:59:59Z" } });
    expect((events[0]?.values as { observedAt: Date }).observedAt).toEqual(new Date("2026-10-22T12:00:00.000Z"));
  });
  it("is idempotent: replaying the job inserts nothing new", async () => {
    const { db } = dbWithSource({ insert: (table) => (table === "telegram_message_events" ? [] : [{ id: "x" }]) });
    const outcome = await processTelegramEventsJob(eventsJob(), db, { logger: logs().logger, intakePolicy: policy });
    expect(outcome).toMatchObject({ outcome: "events_recorded", recorded: 0, duplicates: 2 });
  });
  it("logs counts and codes only (no message ids list, no text)", async () => {
    const { db } = dbWithSource();
    const { records, logger } = logs();
    await processTelegramEventsJob(eventsJob(), db, { logger, intakePolicy: policy });
    const dump = JSON.stringify(records);
    expect(records.some((r) => r.event === "worker.events.deletions_recorded")).toBe(true);
    expect(dump).not.toContain('"10"');
  });
});

describe("signal queue dispatcher", () => {
  const fakeJob = (data: unknown) => ({ id: "j1", data, opts: { attempts: 3 }, attemptsMade: 0 }) as never;
  it("routes only jobType telegram_events to the events handler; everything else takes the unchanged message path", async () => {
    const { logger } = logs();
    const options = { logger, intakePolicy: policy };
    // events path: malformed ids -> the events handler's own error, mapped to an UnrecoverableError
    await expect(processSignalQueueJob(fakeJob(eventsJob({ messageIds: ["abc"] })), "c", createRecordingDb().db, options)).rejects.toThrow(/message ids/);
    await expect(processSignalQueueJob(fakeJob(eventsJob({ messageIds: ["abc"] })), "c", createRecordingDb().db, options)).rejects.toBeInstanceOf(UnrecoverableError);
    // message path (explicit jobType and legacy payload without jobType): approved chat, malformed timestamp -> the message handler's error
    const message = (jobType?: string) => ({
      ...(jobType ? { jobType } : {}),
      providerName: "telegram-bot-webhook",
      telegram: { params: { channelIdentifier: `tg_chat_${CHAT_ID}` }, exchange: "NSE", instrumentType: "equity",
        normalizedMessage: { channelIdentifier: `tg_chat_${CHAT_ID}`, chatId: String(CHAT_ID), externalMessageId: "5", messageTimestamp: "not-a-date", rawText: "x" } },
    });
    for (const jobType of ["telegram_messages", undefined, "something_else"]) {
      await expect(processSignalQueueJob(fakeJob(message(jobType)), "c", createRecordingDb().db, options), String(jobType)).rejects.toThrow(/messageTimestamp/);
    }
  });
  it("an events job for an unapproved chat completes without any database access and without retries", async () => {
    const { db, calls } = createRecordingDb();
    const { records, logger } = logs();
    await expect(processSignalQueueJob(fakeJob(eventsJob({ chatId: String(OTHER), channelIdentifier: `tg_chat_${OTHER}` })), "c", db, { logger, intakePolicy: policy })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(records.find((r) => r.event === "worker.job.completed")?.["outcome"]).toBe("chat_not_approved");
    expect(records.some((r) => r.event === "worker.job.failed")).toBe(false);
  });
});
