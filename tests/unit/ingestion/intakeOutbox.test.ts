import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDeletionOutboxInput,
  buildMessageOutboxInput,
  computeRetryDelayMs,
  DEFAULT_RETRY_POLICY,
  OUTBOX_JOB_ID,
  safeErrorCode,
} from "../../../packages/ingestion/src/index";

const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("retry policy", () => {
  it("doubles from the base, is capped, and jitter keeps each delay within [50%, 100%] of the exponential value", () => {
    const p = { baseMs: 1000, maxMs: 60_000 };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => computeRetryDelayMs(a, () => 1, p))).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    expect([1, 2, 3].map((a) => computeRetryDelayMs(a, () => 0, p))).toEqual([500, 1000, 2000]);
    for (let i = 0; i < 200; i++) {
      const d = computeRetryDelayMs(4, Math.random, p);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
  it("tolerates out-of-range randomness and attempt 0 (never negative, never beyond the cap)", () => {
    expect(computeRetryDelayMs(0, () => -5, { baseMs: 1000, maxMs: 5000 })).toBe(500);
    expect(computeRetryDelayMs(50, () => 9, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });
  it("the production default is 5 s doubling to a 15 minute cap", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ baseMs: 5000, maxMs: 900_000 });
  });
});

describe("error recording never keeps message text", () => {
  it("stores a code or class name only", () => {
    expect(safeErrorCode(Object.assign(new Error("password=hunter2 row (BUY X)"), { code: "INGESTION_FAILED" }))).toBe("INGESTION_FAILED");
    expect(safeErrorCode(new TypeError("password=hunter2"))).toBe("TypeError");
    expect(safeErrorCode(Object.assign(new Error("x"), { code: "has spaces and secret=1" }))).toBe("Error"); // an unsafe code is not trusted
    expect(safeErrorCode("a string with secret=1")).toBe("NonError");
    expect(safeErrorCode(null).length).toBeLessThanOrEqual(60);
  });
});

describe("outbox identity", () => {
  const normalized = { channelIdentifier: "tg_chat_-100", externalMessageId: "42" };
  it("a message, an edit and a deletion have distinct identities; the Redis job id is attempt-scoped", () => {
    const base = { intakeSource: "user_capture" as const, payload: {}, receivedAt: new Date(0) };
    const message = buildMessageOutboxInput({ ...base, normalized });
    const edit = buildMessageOutboxInput({ ...base, normalized: { ...normalized, externalMessageId: "42_rev_x", editDate: new Date(5) } });
    expect(message).toMatchObject({ messageType: "message", sourceMessageId: "42", channelId: "tg_chat_-100" });
    expect(edit).toMatchObject({ messageType: "edit", sourceMessageId: "42_rev_x" });
    expect(OUTBOX_JOB_ID("abc", 0)).not.toBe(OUTBOX_JOB_ID("abc", 1));
    expect(OUTBOX_JOB_ID("abc", 1)).toBe("outbox-abc-1");
  });
  it("a deletion's identity depends only on the SET of deleted ids", () => {
    const base = { intakeSource: "user_capture" as const, channelIdentifier: "tg_chat_-100", payload: {}, receivedAt: new Date(0) };
    const a = buildDeletionOutboxInput({ ...base, messageIds: ["30", "10", "20", "10"] });
    const b = buildDeletionOutboxInput({ ...base, messageIds: ["10", "20", "30"] });
    const c = buildDeletionOutboxInput({ ...base, messageIds: ["10", "20"] });
    expect(a.sourceMessageId).toBe(b.sourceMessageId);
    expect(a.sourceMessageId).not.toBe(c.sourceMessageId);
    expect(a.sourceMessageId).toMatch(/^del-[0-9a-f]{12}$/);
    expect(a.messageType).toBe("deletion");
  });
});

describe("architecture: the API cannot acknowledge an intake entry that is not durable", () => {
  const api = strip(read("apps/api/src/index.ts"));
  const capture = strip(read("apps/api/src/internalIngest.ts"));
  const service = strip(read("apps/api/src/intakeService.ts"));
  it("neither intake route enqueues a message payload into Redis any more: the only queue.add of intake work is the outbox id job", () => {
    const adds = api.match(/telegramQueue\.add\(/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(api).toMatch(/telegramQueue\.add\(\s*OUTBOX_QUEUE_JOB_NAME,\s*\{ jobType: OUTBOX_QUEUE_JOB_NAME, outboxId \}/);
    expect(capture).not.toMatch(/addJob|\.add\(/);
    expect(capture).toMatch(/deps\.intake\.submit\(/);
    expect(api).toMatch(/intakeService\.submit\(/);
  });
  it("the service persists BEFORE it enqueues, and a persistence failure is never an acknowledgement", () => {
    const record = service.indexOf("deps.outbox.record(");
    const enqueue = service.indexOf("deps.enqueue(");
    expect(record).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(record);
    expect(service).toMatch(/catch \(error\) \{[\s\S]*?throw new IntakeStoreUnavailableError\(\)/);
  });
  it("the worker handler checks the intake controls BEFORE it claims, and the reconciler checks them before it touches any row", () => {
    const worker = strip(read("services/worker/src/outbox.ts"));
    expect(worker.indexOf("assertIntakeEnabled(")).toBeGreaterThan(-1);
    expect(worker.indexOf("assertIntakeEnabled(")).toBeLessThan(worker.indexOf("claimOutboxRow("));
    const reconcile = worker.slice(worker.indexOf("export async function reconcileOutbox"));
    expect(reconcile.indexOf('evaluateSafety("intake"')).toBeGreaterThan(-1);
    expect(reconcile.indexOf('evaluateSafety("intake"')).toBeLessThan(reconcile.indexOf("recoverExpiredLeases("));
    expect(reconcile.indexOf('evaluateSafety("intake"')).toBeLessThan(reconcile.indexOf("findRedeliverableOutboxRows("));
  });
  it("outbox logs carry ids and codes, never payload fields", () => {
    for (const f of ["apps/api/src/intakeService.ts", "services/worker/src/outbox.ts"]) {
      const text = strip(read(f));
      const logLines = text.split("\n").filter((line) => /\blog(ger)?\??\.(info|warn|error|child)\(/.test(line));
      expect(logLines.length, f).toBeGreaterThan(0);
      for (const line of logLines) expect(line, f).not.toMatch(/rawPayload|rawText|normalizedMessage|\.payload\b|entry\b[^.]*\bpayload/);
    }
  });
});

describe("migration 0012", () => {
  const sql = read("packages/database/drizzle/0012_telegram_intake_outbox.sql");
  it("creates the table with the five statuses, the identity unique index and ENABLE ALWAYS guards", () => {
    for (const status of ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "DEAD_LETTER"]) expect(sql).toContain(`'${status}'`);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "telegram_intake_outbox_identity_unique" ON "telegram_intake_outbox" USING btree \("channel_id","source_message_id","message_type"\)/);
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER "telegram_intake_outbox_guard", ENABLE ALWAYS TRIGGER "telegram_intake_outbox_no_truncate"/);
    expect(sql).toMatch(/terminal status/);
    expect(sql).toMatch(/rows are never deleted/);
  });
  it("is registered in the journal as the 13th migration (0013 follows it)", () => {
    const journal = JSON.parse(read("packages/database/drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    expect(journal.entries).toHaveLength(14);
    expect(journal.entries[12]?.tag).toBe("0012_telegram_intake_outbox");
  });
});
