/**
 * R0B idempotency under real concurrency (PostgreSQL). Queue-level jobId
 * dedupe is deliberately bypassed: several worker executions are driven
 * directly so they reach the database at the same time.
 *
 * Determinism: a barrier gate holds every caller just before its INSERT into
 * a chosen table until all callers have arrived, so the check-then-insert
 * window is overlapped by construction rather than by sleeps.
 *
 * NOTE: these tests require migration 0004 (signals.parser_version unique key,
 * signal_validations.idempotency_key). Before it is applied, the concurrency
 * tests are EXPECTED TO FAIL - that failure is the demonstration of the race.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, inArray } from "drizzle-orm";
import { createBoundedDb, schema, type BoundedDbHandle, type Db } from "../../../packages/database/src/index";
import { processTelegramJob } from "../../../services/worker/src/index";
import { reparseTelegramMessage } from "../../../packages/signals/src/index";
import { validateSignal } from "../../../packages/decision-intelligence/src/index";
import { marketDataProviders, YAHOO_PROVIDER_NAME } from "../../../adapters/market/src/index";
import { DATABASE_URL, syntheticMarketProvider, must } from "./harness";
import { analyzeTelegramText, TELEGRAM_PARSER_VERSION } from "../../../packages/signals/src/index";

let handle: BoundedDbHandle;
beforeAll(async () => {
  handle = createBoundedDb({ url: DATABASE_URL, max: 20, idleTimeoutMillis: 10000 });
  await handle.db.execute("SELECT 1");
  marketDataProviders.register(YAHOO_PROVIDER_NAME, syntheticMarketProvider);
});
afterAll(async () => {
  if (handle) await handle.close();
});

const rand = () => Math.floor(Math.random() * 1_000_000_000);

/** Barrier: resolves once `parties` callers have called arrive(). */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await open;
    },
    get arrivals() {
      return arrived;
    },
  };
}

type Gate = { table: string; wait: () => Promise<void> };

/** Wraps a builder so awaiting it first waits on the gate (i.e. just before the SQL is sent). */
function wrapBuilder<T extends object>(builder: T, wait: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        const then = Reflect.get(target, "then", receiver) as (a: unknown, b: unknown) => unknown;
        return (res: unknown, rej: unknown) => wait().then(() => then.call(target, res, rej));
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(target, args);
        return r && typeof r === "object" ? wrapBuilder(r as object, wait) : r;
      };
    },
  });
}

function gatedDb(db: Db, gates: Gate[], failOnce?: { table: string; message: string; left: number }): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "insert" && typeof v === "function") {
        return (table: Parameters<Db["insert"]>[0]) => {
          const name = getTableName(table);
          if (failOnce && failOnce.left > 0 && name === failOnce.table) {
            failOnce.left -= 1;
            throw new Error(failOnce.message);
          }
          const builder = (v as (t: unknown) => object).call(target, table);
          const gate = gates.find((g) => g.table === name);
          return gate ? wrapBuilder(builder, gate.wait) : builder;
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Db;
}

function job(channel: string, messageId: number, text = "BUY RELIANCE @ 2800 SL 2750 TGT 2900") {
  return {
    id: `direct-${channel}-${messageId}-${rand()}`,
    data: {
      jobType: "telegram_messages",
      providerName: "telegram-bot-webhook",
      telegram: {
        params: { channelIdentifier: channel },
        normalizedMessage: {
          channelIdentifier: channel,
          externalMessageId: String(messageId),
          messageTimestamp: new Date().toISOString(),
          rawText: text,
          rawPayload: {},
        },
        exchange: "NSE",
        instrumentType: "equity",
      },
    },
  } as never;
}

async function rowsFor(db: Db, channel: string) {
  const messages = await db
    .select({ id: schema.telegramMessages.id, ext: schema.telegramMessages.externalMessageId })
    .from(schema.telegramMessages)
    .innerJoin(schema.telegramSources, eq(schema.telegramMessages.telegramSourceId, schema.telegramSources.id))
    .where(eq(schema.telegramSources.channelIdentifier, channel));
  const ids = messages.map((m) => m.id);
  const signals = ids.length
    ? await db.select().from(schema.signals).where(inArray(schema.signals.telegramMessageId, ids))
    : [];
  const validations = signals.length
    ? await db
        .select()
        .from(schema.signalValidations)
        .where(inArray(schema.signalValidations.signalId, signals.map((s) => s.id)))
    : [];
  return { messages, signals, validations };
}

describe("R0B idempotency under real DB concurrency", () => {
  it("same logical message processed by N concurrent workers -> one canonical signal and validation", async () => {
    const N = 4;
    const channel = `@r0b_conc_same_${rand()}`;
    const messageId = rand();
    const gate = barrier(N);
    const db = gatedDb(handle.db, [
      { table: "signals", wait: gate.arrive },
    ]);
    // Same job payload N times, distinct BullMQ job ids (queue dedupe bypassed).
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => processTelegramJob(job(channel, messageId), "c", db)),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const rows = await rowsFor(handle.db, channel);
    expect(rows.messages).toHaveLength(1);
    expect(rows.signals).toHaveLength(1);
    expect(must(rows.signals[0]).telegramMessageId).toBe(must(rows.messages[0]).id);
    expect(rows.validations).toHaveLength(1);
    expect(must(rows.validations[0]).signalId).toBe(must(rows.signals[0]).id);
  }, 60_000);

  it("concurrent validations for the same ingestion key collapse to one row; keyless re-validation keeps history", async () => {
    const channel = `@r0b_conc_val_${rand()}`;
    await processTelegramJob(job(channel, rand()), "c", handle.db);
    const { signals } = await rowsFor(handle.db, channel);
    const signalId = must(signals[0]).id;
    const key = `test-key-${rand()}`;
    const N = 4;
    const gate = barrier(N);
    const db = gatedDb(handle.db, [{ table: "signal_validations", wait: gate.arrive }]);
    const outs = await Promise.all(
      Array.from({ length: N }, () => validateSignal(db, signalId, { idempotencyKey: key })),
    );
    const ids = new Set(outs.map((o) => o.validationId));
    expect(ids.size).toBe(1);
    const keyed = await handle.db
      .select()
      .from(schema.signalValidations)
      .where(eq(schema.signalValidations.idempotencyKey, key));
    expect(keyed).toHaveLength(1);
    expect(must(keyed[0]).id).toBe([...ids][0]);
    // Legitimate historical re-validation (no key) still appends.
    const before = (await rowsFor(handle.db, channel)).validations.length;
    await validateSignal(handle.db, signalId);
    await validateSignal(handle.db, signalId);
    expect((await rowsFor(handle.db, channel)).validations.length).toBe(before + 2);
  }, 60_000);

  it("same external message id in different channels stays separate (no cross-channel collapse)", async () => {
    const messageId = rand();
    const chA = `@r0b_conc_a_${rand()}`;
    const chB = `@r0b_conc_b_${rand()}`;
    const gate = barrier(2);
    const db = gatedDb(handle.db, [{ table: "signals", wait: gate.arrive }]);
    const res = await Promise.allSettled([
      processTelegramJob(job(chA, messageId), "c", db),
      processTelegramJob(job(chB, messageId), "c", db),
    ]);
    expect(res.filter((r) => r.status === "rejected")).toEqual([]);
    const a = await rowsFor(handle.db, chA);
    const b = await rowsFor(handle.db, chB);
    for (const r of [a, b]) {
      expect(r.messages).toHaveLength(1);
      expect(r.signals).toHaveLength(1);
      expect(r.validations).toHaveLength(1);
      expect(must(r.signals[0]).telegramMessageId).toBe(must(r.messages[0]).id);
    }
    expect(must(a.messages[0]).id).not.toBe(must(b.messages[0]).id);
    expect(must(a.signals[0]).id).not.toBe(must(b.signals[0]).id);
  }, 60_000);

  it("partial failure (signal created, validation failed) followed by concurrent retries resumes to one validation", async () => {
    const channel = `@r0b_conc_partial_${rand()}`;
    const messageId = rand();
    const failing = gatedDb(handle.db, [], { table: "signal_validations", message: "injected failure before validation insert", left: 1 });
    await expect(processTelegramJob(job(channel, messageId), "c", failing)).rejects.toThrow(/injected failure/);
    let rows = await rowsFor(handle.db, channel);
    expect(rows.signals).toHaveLength(1); // partial state: signal exists, no validation
    expect(rows.validations).toHaveLength(0);

    const N = 3;
    const gate = barrier(N);
    const db = gatedDb(handle.db, [{ table: "signal_validations", wait: gate.arrive }]);
    const res = await Promise.allSettled(
      Array.from({ length: N }, () => processTelegramJob(job(channel, messageId), "c", db)),
    );
    expect(res.filter((r) => r.status === "rejected")).toEqual([]);
    rows = await rowsFor(handle.db, channel);
    expect(rows.signals).toHaveLength(1);
    expect(rows.validations).toHaveLength(1);
    expect(must(rows.validations[0]).signalId).toBe(must(rows.signals[0]).id);
  }, 60_000);

  it("explicit reparse under another parser version is a legitimate second signal; concurrent same-version reparses collapse to one", async () => {
    const channel = `@r0b_conc_ver_${rand()}`;
    await processTelegramJob(job(channel, rand()), "c", handle.db);
    const { messages, signals } = await rowsFor(handle.db, channel);
    const messageId = must(messages[0]).id;
    expect(signals).toHaveLength(1);
    expect(must(signals[0]).parserVersion).toBe(TELEGRAM_PARSER_VERSION);

    // A stub second parser: the version label is only accepted for implemented parsers.
    const parsers = { "test-parser-v2": analyzeTelegramText };
    const N = 3;
    const gate = barrier(N);
    const db = gatedDb(handle.db, [{ table: "signals", wait: gate.arrive }]);
    const v2 = await Promise.all(
      Array.from({ length: N }, () =>
        reparseTelegramMessage(db, messageId, { exchange: "NSE", instrumentType: "equity", parserVersion: "test-parser-v2", parsers }),
      ),
    );
    expect(new Set(v2.map((o) => o.signalId)).size).toBe(1);
    expect(v2.filter((o) => o.created)).toHaveLength(1);
    const all = await handle.db.select().from(schema.signals).where(eq(schema.signals.telegramMessageId, messageId));
    expect(all).toHaveLength(2);
    expect(new Set(all.map((s) => s.parserVersion))).toEqual(new Set([TELEGRAM_PARSER_VERSION, "test-parser-v2"]));
    await expect(
      reparseTelegramMessage(handle.db, messageId, { exchange: "NSE", instrumentType: "equity", parserVersion: "no-such-parser" }),
    ).rejects.toThrow(/unknown parser version/);
  }, 60_000);
});
