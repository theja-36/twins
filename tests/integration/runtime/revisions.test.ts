/**
 * R0B edit-revision identity, ambiguity and legacy-validation behaviour (PostgreSQL).
 * Requires migration 0004 (origin_message_id/edit_date, parser_version, idempotency_key).
 * Approval/execution are NOT implemented; nothing here claims approval invalidation.
 * Tested instead: the structural boundary (distinct raw row / signal / validations per
 * revision) and the derived revision-currentness boundary future approval must consult.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createBoundedDb, schema, type BoundedDbHandle, type Db } from "../../../packages/database/src/index";
import { processTelegramJob, processTelegramQueueJob } from "../../../services/worker/src/index";
import { UnrecoverableError } from "bullmq";
import { getRevisionStates, resolveTelegramSource } from "../../../packages/ingestion/src/index";
import { analyzeTelegramText, reparseTelegramMessage, TELEGRAM_PARSER_VERSION } from "../../../packages/signals/src/index";
import { normalizeRawUpdate } from "../../../adapters/telegram/src/index";
import { validateSignal } from "../../../packages/decision-intelligence/src/index";
import { marketDataProviders, YAHOO_PROVIDER_NAME } from "../../../adapters/market/src/index";
import { DATABASE_URL, must, syntheticMarketProvider, uniqueChatId } from "./harness";

let handle: BoundedDbHandle;
beforeAll(async () => {
  handle = createBoundedDb({ url: DATABASE_URL, max: 10, idleTimeoutMillis: 10000 });
  await handle.db.execute("SELECT 1");
  marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);
});
afterAll(async () => {
  if (handle) await handle.close();
});

const rand = () => Math.floor(Math.random() * 1_000_000_000);

/** Queue-shaped job built from a REAL Telegram update via the real adapter, JSON round-tripped like BullMQ. */
function jobFromUpdate(update: unknown) {
  const normalized = must(normalizeRawUpdate(update));
  const data = JSON.parse(
    JSON.stringify({
      jobType: "telegram_messages",
      providerName: "telegram-bot-webhook",
      telegram: {
        params: { channelIdentifier: normalized.channelIdentifier },
        normalizedMessage: normalized,
        exchange: "NSE",
        instrumentType: "equity",
      },
    }),
  );
  return { id: `rev-${rand()}`, data } as never;
}

const chat = (user: string, chatId: number) => ({ id: chatId, type: "channel", username: user });
const original = (user: string, chatId: number, messageId: number, text: string, updateId = rand()) => ({
  update_id: updateId,
  channel_post: { message_id: messageId, date: 1_700_000_000, chat: chat(user, chatId), text },
});
const edited = (user: string, chatId: number, messageId: number, editDate: number, text: string, updateId = rand()) => ({
  update_id: updateId,
  edited_channel_post: { message_id: messageId, date: 1_700_000_000, edit_date: editDate, chat: chat(user, chatId), text },
});
const BUY = (px: number) => `BUY RELIANCE @ ${px} SL ${px - 50} TGT ${px + 100}`;

async function chain(db: Db, chatId: number) {
  const identifier = `tg_chat_${chatId}`;
  const joined = await db
    .select()
    .from(schema.telegramMessages)
    .innerJoin(schema.telegramSources, eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id))
    .where(eq(schema.telegramSources.channelIdentifier, identifier));
  const messages = joined.map((m) => m.telegram_messages);
  const ids = messages.map((m) => m.id);
  const signals = ids.length ? await db.select().from(schema.signals).where(inArray(schema.signals.telegramMessageId, ids)) : [];
  const validations = signals.length
    ? await db.select().from(schema.signalValidations).where(inArray(schema.signalValidations.signalId, signals.map((s) => s.id)))
    : [];
  return { messages, signals, validations, sourceId: joined[0]?.telegram_sources.id };
}

describe("R0B edit revisions (real adapter -> worker -> PostgreSQL)", () => {
  it("preserves original + every distinct edit, collapses a repeat delivery, keeps timing fields separate", async () => {
    const user = `r0b_rev_${rand()}`;
    const chatId = uniqueChatId();
    const mid = rand();
    await processTelegramJob(jobFromUpdate(original(user, chatId, mid, BUY(2800))), "c", handle.db);
    const upd1 = edited(user, chatId, mid, 1_700_001_000, BUY(2810), 7001);
    await processTelegramJob(jobFromUpdate(upd1), "c", handle.db);
    await processTelegramJob(jobFromUpdate(edited(user, chatId, mid, 1_700_002_000, BUY(2820))), "c", handle.db);
    expect((await chain(handle.db, chatId)).messages).toHaveLength(3);

    // Repeat delivery of the SAME update (same update_id) -> idempotent.
    await processTelegramJob(jobFromUpdate(upd1), "c", handle.db);
    const after = await chain(handle.db, chatId);
    expect(after.messages).toHaveLength(3);
    expect(after.signals).toHaveLength(3);
    expect(after.validations).toHaveLength(3);

    // Linkage + separate time fields: original date, edit_date (effective), received/ingested time.
    expect(after.messages.every((m) => m.originMessageId === String(mid))).toBe(true);
    const edits = after.messages.filter((m) => m.editDate !== null);
    expect(edits).toHaveLength(2);
    for (const m of after.messages) {
      expect(m.messageTimestamp.getTime()).toBe(1_700_000_000 * 1000); // original message date, preserved
      expect(m.receivedAt.getTime()).toBeGreaterThan(Date.now() - 120_000); // ingestion time is its own field
    }
    // update_id retained in the audit payload.
    const withUpdate = after.messages.find((m) => (m.rawPayload as { update_id?: number } | null)?.update_id === 7001);
    expect(withUpdate).toBeDefined();

    // Availability timestamp for no-look-ahead: edit signals use edit_date; the original its message date.
    for (const sig of after.signals) {
      const msg = must(after.messages.find((m) => m.id === sig.telegramMessageId));
      expect(sig.signalTimestamp.getTime()).toBe((msg.editDate ?? msg.messageTimestamp).getTime());
    }

    // Structural boundary: distinct signals, each with exactly its own keyed validation.
    expect(new Set(after.signals.map((x) => x.id)).size).toBe(3);
    for (const sig of after.signals) {
      const own = after.validations.filter((v) => v.signalId === sig.id);
      expect(own).toHaveLength(1);
      expect(must(own[0]).idempotencyKey).toBe(`telegram-ingest:${sig.id}`);
    }
  }, 60_000);

  it("currentness comes from edit_date, not processing order: edit-before-original, late older edit, same-second tie", async () => {
    const user = `r0b_order_${rand()}`;
    const chatId = uniqueChatId();
    const mid = rand();
    // Newer edit arrives first, then an OLDER edit, then the original.
    await processTelegramJob(jobFromUpdate(edited(user, chatId, mid, 1_700_002_000, BUY(2820))), "c", handle.db);
    let c = await chain(handle.db, chatId);
    let states = await getRevisionStates(handle.db, must(c.sourceId), String(mid));
    expect(states.map((x) => x.state)).toEqual(["current"]); // edit before original is current
    await processTelegramJob(jobFromUpdate(edited(user, chatId, mid, 1_700_001_000, BUY(2810))), "c", handle.db);
    await processTelegramJob(jobFromUpdate(original(user, chatId, mid, BUY(2800))), "c", handle.db);
    c = await chain(handle.db, chatId);
    states = await getRevisionStates(handle.db, must(c.sourceId), String(mid));
    const byEdit = (d: number | null) => must(c.messages.find((m) => (m.editDate?.getTime() ?? null) === (d === null ? null : d * 1000)));
    const st = (id: string) => must(states.find((x) => x.id === id)).state;
    expect(st(byEdit(1_700_002_000).id)).toBe("current");
    expect(st(byEdit(1_700_001_000).id)).toBe("superseded"); // older edit arrived later: still superseded
    expect(st(byEdit(null).id)).toBe("superseded"); // original arrived last: still superseded

    // Same-second, different content: order cannot be established -> ambiguous (non-actionable).
    const mid2 = rand();
    await processTelegramJob(jobFromUpdate(edited(user, chatId, mid2, 1_700_003_000, BUY(2830))), "c", handle.db);
    await processTelegramJob(jobFromUpdate(edited(user, chatId, mid2, 1_700_003_000, BUY(2840))), "c", handle.db);
    c = await chain(handle.db, chatId);
    const tied = await getRevisionStates(handle.db, must(c.sourceId), String(mid2));
    expect(tied).toHaveLength(2);
    expect(tied.every((x) => x.state === "ambiguous")).toBe(true);
  }, 60_000);

  it("a multi-directive message is stored raw but yields no signal (ambiguous, unsupported)", async () => {
    const chatId = uniqueChatId();
    await processTelegramJob(
      jobFromUpdate(original(`r0b_amb_${rand()}`, chatId, rand(), "BUY RELIANCE @ 2800 SL 2750 and SELL INFY @ 1500 SL 1520")),
      "c",
      handle.db,
    );
    const rows = await chain(handle.db, chatId);
    expect(rows.messages).toHaveLength(1);
    expect(rows.signals).toHaveLength(0);
    expect(rows.validations).toHaveLength(0);
  }, 30_000);

  it("validation provenance: keyless (legacy/manual) validation is preserved and not treated as proof; exactly one recomputed snapshot is appended", async () => {
    const user = `r0b_legacyval_${rand()}`;
    const chatId = uniqueChatId();
    const upd = original(user, chatId, rand(), BUY(2800));
    await processTelegramJob(jobFromUpdate(upd), "c", handle.db);
    let rows = await chain(handle.db, chatId);
    const signal = must(rows.signals[0]);
    const legacyValidation = must(rows.validations[0]);
    // Simulate the pre-migration state: the validation has no idempotency key.
    await handle.db.update(schema.signalValidations).set({ idempotencyKey: null }).where(eq(schema.signalValidations.id, legacyValidation.id));

    await processTelegramJob(jobFromUpdate(upd), "c", handle.db); // retry
    rows = await chain(handle.db, chatId);
    expect(rows.signals).toHaveLength(1);
    expect(rows.validations).toHaveLength(2); // legacy row preserved + one keyed ingestion validation
    expect(rows.validations.some((v) => v.id === legacyValidation.id && v.idempotencyKey === null)).toBe(true);
    // The new row is identifiable as a recomputed snapshot made at retry time, not historical evidence.
    const recomputed = rows.validations.filter((v) => v.idempotencyKey === `telegram-ingest-recompute:${signal.id}`);
    expect(recomputed).toHaveLength(1);
    expect(must(recomputed[0]).validatedAt.getTime()).toBeGreaterThan(signal.signalTimestamp.getTime());
    expect(must(recomputed[0]).validatedAt.getTime()).toBeGreaterThan(Date.now() - 120_000);
    // Existing keyless row is unchanged.
    const unchanged = must(rows.validations.find((v) => v.id === legacyValidation.id));
    expect(unchanged.idempotencyKey).toBeNull();
    expect(unchanged.validatedAt.getTime()).toBe(legacyValidation.validatedAt.getTime());
    expect(unchanged.rationale).toBe(legacyValidation.rationale);

    await processTelegramJob(jobFromUpdate(upd), "c", handle.db); // further retry: now demonstrably done
    expect((await chain(handle.db, chatId)).validations).toHaveLength(2);

    await validateSignal(handle.db, signal.id); // explicit keyless re-validation still appends history
    expect((await chain(handle.db, chatId)).validations).toHaveLength(3);
  }, 30_000);

  it("legacy-unversioned signal: retry resumes it; an explicit reparse is the only way to add a current-parser signal", async () => {
    const user = `r0b_legacyparse_${rand()}`;
    const chatId = uniqueChatId();
    const upd = original(user, chatId, rand(), BUY(2800));
    await processTelegramJob(jobFromUpdate(upd), "c", handle.db);
    let rows = await chain(handle.db, chatId);
    const legacySignal = must(rows.signals[0]);
    await handle.db.update(schema.signals).set({ parserVersion: "legacy-unversioned" }).where(eq(schema.signals.id, legacySignal.id));

    await processTelegramJob(jobFromUpdate(upd), "c", handle.db); // ordinary retry
    rows = await chain(handle.db, chatId);
    expect(rows.signals).toHaveLength(1); // NOT a new current-parser signal
    expect(must(rows.signals[0]).parserVersion).toBe("legacy-unversioned");

    const messageRowId = must(rows.messages[0]).id;
    const reparsed = await reparseTelegramMessage(handle.db, messageRowId, { exchange: "NSE", instrumentType: "equity", parserVersion: TELEGRAM_PARSER_VERSION });
    expect(reparsed.created).toBe(true);
    rows = await chain(handle.db, chatId);
    expect(rows.signals).toHaveLength(2);

    await processTelegramJob(jobFromUpdate(upd), "c", handle.db); // retry now resumes the current-version signal, no block
    expect((await chain(handle.db, chatId)).signals).toHaveLength(2);
  }, 60_000);

  it("several existing signals with no current-version canonical record block with a permanent reconciliation error and change nothing", async () => {
    const user = `r0b_reconcile_${rand()}`;
    const chatId = uniqueChatId();
    const upd = original(user, chatId, rand(), BUY(2800));
    await processTelegramJob(jobFromUpdate(upd), "c", handle.db);
    let rows = await chain(handle.db, chatId);
    await handle.db.update(schema.signals).set({ parserVersion: "legacy-unversioned" }).where(eq(schema.signals.id, must(rows.signals[0]).id));
    await reparseTelegramMessage(handle.db, must(rows.messages[0]).id, {
      exchange: "NSE", instrumentType: "equity", parserVersion: "test-parser-v2", parsers: { "test-parser-v2": analyzeTelegramText },
    });
    rows = await chain(handle.db, chatId);
    expect(rows.signals).toHaveLength(2);
    const before = { s: rows.signals.length, v: rows.validations.length };

    const err = await processTelegramQueueJob(jobFromUpdate(upd), "c", handle.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain("reconciliation required");
    rows = await chain(handle.db, chatId);
    expect({ s: rows.signals.length, v: rows.validations.length }).toEqual(before); // nothing chosen, created or deleted
  }, 60_000);

  it("channel identity is chat.id: a rename keeps one source (display metadata updates); a username-only legacy source is never merged by guess", async () => {
    const chatId = uniqueChatId();
    const oldName = `r0b_old_${rand()}`;
    const newName = `r0b_new_${rand()}`;
    await processTelegramJob(jobFromUpdate(original(oldName, chatId, rand(), BUY(2800))), "c", handle.db);
    await processTelegramJob(jobFromUpdate(original(newName, chatId, rand(), BUY(2801))), "c", handle.db);
    const rows = await chain(handle.db, chatId);
    expect(rows.messages).toHaveLength(2);
    const src = await handle.db.select().from(schema.telegramSources).where(eq(schema.telegramSources.chatId, String(chatId)));
    expect(src).toHaveLength(1);
    expect(must(src[0]).displayName).toBe(`@${newName}`);
    expect(must(src[0]).channelIdentifier).toBe(`tg_chat_${chatId}`);

    // A legacy username-only source (chat_id NULL) with the same handle is NOT adopted/merged.
    const legacyHandle = `@r0b_legacy_src_${rand()}`;
    const legacyId = await resolveTelegramSource(handle.db, { channelIdentifier: legacyHandle });
    const otherChat = uniqueChatId();
    await processTelegramJob(jobFromUpdate(original(legacyHandle.slice(1), otherChat, rand(), BUY(2802))), "c", handle.db);
    const newSource = await handle.db.select().from(schema.telegramSources).where(eq(schema.telegramSources.chatId, String(otherChat)));
    expect(newSource).toHaveLength(1);
    expect(must(newSource[0]).id).not.toBe(legacyId);
    const stillLegacy = await handle.db.select().from(schema.telegramSources).where(eq(schema.telegramSources.id, legacyId));
    expect(must(stillLegacy[0]).chatId).toBeNull();
  }, 60_000);
});
