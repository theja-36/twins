/**
 * Approved-chat allowlist and options-only mode against the REAL worker path and the guarded integration database.
 * Uses the real worker entry points with explicit REAL policies (never the allow-all test wrapper).
 */
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { processTelegramJob } from "../../../services/worker/src/index";
import { createTelegramIntakePolicy, normalizeRawUpdate } from "../../../adapters/telegram/src/index";
import { createStructuredLogger } from "../../../packages/shared/src/index";
import { marketDataProviders, YAHOO_PROVIDER_NAME, type MarketDataProvider } from "../../../adapters/market/src/index";

// A counting offline market provider: the options-only guarantee is "no provider request", so count them.
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

const KINDS = ["message", "channel_post", "edited_message", "edited_channel_post"] as const;
type Kind = (typeof KINDS)[number];
const freshChat = () => -(1_000_000_000_000 + Math.floor(Math.random() * 900_000_000_000));
const freshId = () => Math.floor(Math.random() * 1e9) + 1;
const OPTIONS_TEXT = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";

function jobFor(kind: Kind, chatId: number, text: string, messageId = freshId()) {
  const edited = kind.startsWith("edited_");
  const update = { update_id: messageId, [kind]: { message_id: messageId, date: Math.floor(Date.now() / 1000), ...(edited ? { edit_date: Math.floor(Date.now() / 1000) + 5 } : {}), chat: { id: chatId, type: "channel", username: "intake_it" }, text } };
  const normalized = normalizeRawUpdate(update);
  if (!normalized) throw new Error("fixture must normalize");
  return { id: `ip-${randomUUID()}`, data: { jobType: "telegram_messages", providerName: "telegram-bot-webhook", telegram: { params: { channelIdentifier: normalized.channelIdentifier }, normalizedMessage: JSON.parse(JSON.stringify(normalized)), exchange: "NSE", instrumentType: "equity" } } } as never;
}
const run = (job: never, policy: ReturnType<typeof createTelegramIntakePolicy>) => processTelegramJob(job, "ip-test", db, { logger: createStructuredLogger(() => undefined), intakePolicy: policy });

/** Every kind of record a chat could leave behind, looked up by the unique chat identity (never by global counts). */
async function footprint(chatId: number, symbol?: string) {
  const identifier = `tg_chat_${chatId}`;
  const sources = await db.select({ id: schema.telegramSources.id }).from(schema.telegramSources).where(eq(schema.telegramSources.channelIdentifier, identifier));
  const messages = sources.length ? await db.select({ id: schema.telegramMessages.id }).from(schema.telegramMessages).where(eq(schema.telegramMessages.telegramSourceId, sources[0]!.id)) : [];
  const jobsRows = await db.execute(sql`select count(*)::int as n from jobs where payload::text like ${"%" + identifier + "%"}`);
  const jobCount = Number((jobsRows as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
  const signalRows = messages.length ? await db.select({ id: schema.signals.id }).from(schema.signals).where(eq(schema.signals.telegramMessageId, messages[0]!.id)) : [];
  const claims = messages.length ? await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, messages[0]!.id)) : [];
  const instruments = symbol ? await db.select({ id: schema.instruments.id }).from(schema.instruments).where(eq(schema.instruments.symbol, symbol)) : [];
  return { sources: sources.length, messages: messages.length, jobs: jobCount, signals: signalRows.length, claims, instruments: instruments.length };
}

describe("unapproved chats leave no records (real worker path, real database)", () => {
  it("creates no source, message, job, signal, claim or instrument, for all four update kinds, and makes no market request", async () => {
    const approved = freshChat();
    const policy = createTelegramIntakePolicy({ allowedChatIds: String(approved) });
    const before = marketCalls;
    for (const kind of KINDS) {
      const stranger = freshChat();
      const symbol = `ZZ${randomLetters(6)}`;
      const outcome = await run(jobFor(kind, stranger, `BUY ${symbol} @ 100 SL 95 TGT 110`), policy);
      expect(outcome.outcome, kind).toBe("chat_not_approved");
      expect(await footprint(stranger, symbol), kind).toEqual({ sources: 0, messages: 0, jobs: 0, signals: 0, claims: [], instruments: 0 });
    }
    // options-style text from an unapproved chat is rejected just the same
    const stranger = freshChat();
    expect((await run(jobFor("message", stranger, OPTIONS_TEXT), policy)).outcome).toBe("chat_not_approved");
    expect(await footprint(stranger)).toEqual({ sources: 0, messages: 0, jobs: 0, signals: 0, claims: [], instruments: 0 });
    expect(marketCalls).toBe(before);
  });
  it("the default process policy (no allowlist configured) also records nothing", async () => {
    const chat = freshChat();
    const outcome = await processTelegramJob(jobFor("channel_post", chat, OPTIONS_TEXT), "ip-test", db, { logger: createStructuredLogger(() => undefined) });
    expect(outcome.outcome).toBe("chat_not_approved");
    expect(await footprint(chat)).toEqual({ sources: 0, messages: 0, jobs: 0, signals: 0, claims: [], instruments: 0 });
  });
});

describe("options-only mode from an approved chat (real worker path, real database)", () => {
  it("blocks equity-style messages BEFORE any record or provider request, for all four update kinds", async () => {
    const chat = freshChat();
    const policy = createTelegramIntakePolicy({ allowedChatIds: String(chat), optionsOnly: "true" });
    const before = marketCalls;
    for (const kind of KINDS) {
      const symbol = `ZZ${randomLetters(6)}`;
      const outcome = await run(jobFor(kind, chat, `BUY ${symbol} @ 100 SL 95 TGT 110`), policy);
      expect(outcome, kind).toEqual({ outcome: "non_options_blocked", reasonCodes: ["options_only.not_an_options_message"] });
      expect((await footprint(chat, symbol)).instruments, kind).toBe(0);
    }
    expect(await footprint(chat)).toEqual({ sources: 0, messages: 0, jobs: 0, signals: 0, claims: [], instruments: 0 });
    // ambiguous equity text and plain chatter fail closed too
    expect((await run(jobFor("message", chat, "BUY AAA @ 1 SELL BBB @ 2"), policy)).outcome).toBe("non_options_blocked");
    expect((await run(jobFor("message", chat, "hello team"), policy)).outcome).toBe("non_options_blocked");
    expect(await footprint(chat)).toEqual({ sources: 0, messages: 0, jobs: 0, signals: 0, claims: [], instruments: 0 });
    expect(marketCalls).toBe(before);
  });

  it("an options message from the approved chat is recorded as an UNVERIFIED, never-approvable claim, for all four update kinds, with no signal and no provider request", async () => {
    const chat = freshChat();
    const policy = createTelegramIntakePolicy({ allowedChatIds: String(chat), optionsOnly: "true" });
    const before = marketCalls;
    for (const kind of KINDS) {
      const messageId = freshId();
      const outcome = await run(jobFor(kind, chat, OPTIONS_TEXT, messageId), policy);
      expect(outcome.outcome, kind).toBe("options_claim_not_ingested");
      expect(outcome.optionsClaimId, kind).toBeTruthy();
      const [claim] = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.id, outcome.optionsClaimId as string));
      expect(claim?.approvalPossible, kind).toBe(false);
      expect(claim?.assessmentOutcome, kind).toBe("INSUFFICIENT_EVIDENCE");
      expect((claim?.verification as { status?: string } | null)?.status, kind).toBe("unconfigured"); // no contract master: this verifies nothing
      expect((claim?.provenance as { premiumProvider?: { configured?: boolean } } | null)?.premiumProvider?.configured, kind).toBe(false);
    }
    const f = await footprint(chat);
    expect(f.sources).toBe(1);
    expect(f.jobs).toBeGreaterThanOrEqual(1);
    expect(f.signals).toBe(0);
    expect(marketCalls).toBe(before);
    // the database itself still refuses an approvable claim
    const [row] = await db.select({ id: schema.optionsClaims.id }).from(schema.optionsClaims).limit(1);
    if (row) await expect(db.update(schema.optionsClaims).set({ approvalPossible: true }).where(eq(schema.optionsClaims.id, row.id))).rejects.toThrow();
  });

  it("an options-style message of an unsupported underlying is also recorded as a claim-less unsupported intake, never an equity signal", async () => {
    const chat = freshChat();
    const policy = createTelegramIntakePolicy({ allowedChatIds: String(chat), optionsOnly: "true" });
    const outcome = await run(jobFor("message", chat, "BUY FINNIFTY 24000 CE 27 OCT 2026 ABOVE 100 SL 80 TGT 120"), policy);
    expect(outcome.outcome).toBe("options_claim_not_ingested");
    const f = await footprint(chat, "FINNIFTY");
    expect(f.signals).toBe(0);
    expect(f.instruments).toBe(0);
    expect(f.claims.every((c) => c.approvalPossible === false)).toBe(true);
  });

  it("without options-only, the same approved chat's equity message is NOT blocked (the mode is what blocks it)", async () => {
    const chat = freshChat();
    const symbol = `ZZ${randomLetters(6)}`;
    const policy = createTelegramIntakePolicy({ allowedChatIds: String(chat), optionsOnly: "false" });
    const outcome = await run(jobFor("message", chat, `BUY ${symbol} @ 100 SL 95 TGT 110`), policy);
    expect(outcome.outcome).not.toBe("non_options_blocked");
    expect((await footprint(chat, symbol)).signals).toBeGreaterThan(0);
  });
});
