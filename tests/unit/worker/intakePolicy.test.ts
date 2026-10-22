import { describe, expect, it } from "vitest";
import { processTelegramJob, processTelegramQueueJob } from "../../../services/worker/src/index"; // REAL entry points, no allow-all wrapper
import { createTelegramIntakePolicy, normalizeRawUpdate } from "../../../adapters/telegram/src/index";
import { analyzeTelegramText } from "../../../packages/signals/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";

const APPROVED = -1001234567890;
const OTHER = -1009999999999;
const OPTIONS_TEXT = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
const EQUITY_TEXT = "BUY RELIANCE @ 2800 SL 2750 TGT 2900";
const EQUITY_AMBIGUOUS = "BUY RELIANCE @ 100 SELL TCS @ 200";
const NO_DIRECTIVE = "good morning everyone, markets look quiet";
const OPTIONS_UNSUPPORTED = "BUY FINNIFTY 24000 CE 27 OCT 2026 ABOVE 100 SL 80 TGT 120";
const OPTIONS_AMBIGUOUS = "BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SELL BANKNIFTY 52000 PE 27 OCT 2026 ABOVE 100";

/** A database stand-in that records EVERY access and refuses it: any effect on the database is a visible failure. */
function untouchableDb() {
  const touches: string[] = [];
  const db = new Proxy({}, { get: (_t, prop) => { touches.push(String(prop)); throw new Error("DB_TOUCHED"); } });
  return { db: db as never, touches };
}
const KINDS = ["message", "channel_post", "edited_message", "edited_channel_post"] as const;
type Kind = (typeof KINDS)[number];

function updateOf(kind: Kind, chatId: number, text: string, messageId = 500) {
  const edited = kind.startsWith("edited_");
  return { update_id: messageId, [kind]: { message_id: messageId, date: 1_700_000_000, ...(edited ? { edit_date: 1_700_000_100 } : {}), chat: { id: chatId, type: "channel", username: "u" }, text } };
}
/** A queue job exactly as BullMQ would hand it over (JSON round trip: Dates become ISO strings). */
function jobOf(kind: Kind, chatId: number, text: string, mutate?: (m: Record<string, unknown>) => void) {
  const normalized = normalizeRawUpdate(updateOf(kind, chatId, text));
  if (!normalized) throw new Error("fixture must normalize");
  const message = JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>;
  mutate?.(message);
  return { id: `job-${kind}-${chatId}`, attemptsMade: 0, opts: { attempts: 3 }, data: { jobType: "telegram_messages", providerName: "telegram-bot-webhook", telegram: { params: { channelIdentifier: String(message["channelIdentifier"]) }, normalizedMessage: message, exchange: "NSE", instrumentType: "equity" } } } as never;
}
const capture = () => { const records: LogRecord[] = []; return { records, logger: createStructuredLogger((r) => records.push(r)) }; };
const approvedOnly = (optionsOnly = false) => createTelegramIntakePolicy({ allowedChatIds: String(APPROVED), optionsOnly: optionsOnly ? "true" : "false" });

describe("worker gate 1: approved chat (jobs reaching the worker directly)", () => {
  it("rejects an unapproved chat for every update kind with NO database access at all", async () => {
    for (const kind of KINDS) {
      const { db, touches } = untouchableDb();
      const { records, logger } = capture();
      const outcome = await processTelegramJob(jobOf(kind, OTHER, OPTIONS_TEXT), "c", db, { logger, intakePolicy: approvedOnly() });
      expect(outcome, kind).toEqual({ outcome: "chat_not_approved", reasonCodes: ["chat.not_approved"] });
      expect(touches, kind).toEqual([]);
      expect(records.some((r) => r.event === "worker.intake.chat_rejected" && r["reason"] === "chat_not_approved" && r["chatId"] === String(OTHER)), kind).toBe(true);
    }
  });
  it("the queue boundary completes the job (no retry, no throw) and still touches nothing", async () => {
    const { db, touches } = untouchableDb();
    const { records, logger } = capture();
    await expect(processTelegramQueueJob(jobOf("message", OTHER, EQUITY_TEXT), "c", db, { logger, intakePolicy: approvedOnly() })).resolves.toBeUndefined();
    expect(touches).toEqual([]);
    expect(records.find((r) => r.event === "worker.job.completed")?.["outcome"]).toBe("chat_not_approved");
    expect(records.some((r) => r.event === "worker.job.failed")).toBe(false);
  });
  it("legacy names, contradictory identities and missing ids are never approved", async () => {
    const cases: Array<[string, (m: Record<string, unknown>) => void, string]> = [
      ["legacy username identifier, no chatId", (m) => { delete m["chatId"]; m["channelIdentifier"] = "@legacy_channel"; }, "chat.id_unusable"],
      ["chatId disagrees with the identifier", (m) => { m["chatId"] = String(OTHER); }, "chat.id_unusable"],
      ["non-numeric chatId", (m) => { m["chatId"] = "abc"; }, "chat.id_unusable"],
      ["no identity at all", (m) => { delete m["chatId"]; delete m["channelIdentifier"]; }, "chat.id_unusable"],
    ];
    for (const [name, mutate, code] of cases) {
      const { db, touches } = untouchableDb();
      const outcome = await processTelegramJob(jobOf("message", APPROVED, OPTIONS_TEXT, mutate), "c", db, { logger: capture().logger, intakePolicy: approvedOnly() });
      expect(outcome, name).toEqual({ outcome: "chat_not_approved", reasonCodes: [code] });
      expect(touches, name).toEqual([]);
    }
  });
  it("a malformed job (no normalized message) is rejected without effects, not crashed on", async () => {
    const { db, touches } = untouchableDb();
    const outcome = await processTelegramJob({ id: "x", data: { jobType: "telegram_messages", telegram: {} } } as never, "c", db, { logger: capture().logger, intakePolicy: approvedOnly() });
    expect(outcome.outcome).toBe("chat_not_approved");
    expect(touches).toEqual([]);
  });
  it("with NO injected policy the process default is deny-all (variable unset in tests): even a well-formed job is rejected", async () => {
    const { db, touches } = untouchableDb();
    const outcome = await processTelegramJob(jobOf("channel_post", APPROVED, OPTIONS_TEXT), "c", db, { logger: capture().logger });
    expect(outcome.outcome).toBe("chat_not_approved");
    expect(touches).toEqual([]);
  });
  it("an approved chat passes gate 1 for every update kind (the first database access happens)", async () => {
    for (const kind of KINDS) {
      const { db, touches } = untouchableDb();
      await processTelegramJob(jobOf(kind, APPROVED, OPTIONS_TEXT), "c", db, { logger: capture().logger, intakePolicy: approvedOnly() }).catch(() => undefined);
      expect(touches.length, kind).toBeGreaterThan(0);
    }
  });
  it("rejection logs hold minimal metadata: no text, no payload, no secrets", async () => {
    const { db } = untouchableDb();
    const { records, logger } = capture();
    await processTelegramJob(jobOf("message", OTHER, "PRIVATE-TEXT-98765 buy now"), "c", db, { logger, intakePolicy: approvedOnly() });
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("PRIVATE-TEXT-98765");
    expect(dump).not.toContain("rawPayload");
  });
});

describe("worker gate 2: explicit options-only mode (fail closed, before any write)", () => {
  it("sample texts are what the tests claim (guards the fixtures against parser changes)", () => {
    expect(analyzeTelegramText(OPTIONS_TEXT).kind).toBe("options_claim");
    expect(analyzeTelegramText(OPTIONS_UNSUPPORTED).kind).toBe("options_unsupported");
    const amb = analyzeTelegramText(OPTIONS_AMBIGUOUS);
    expect(amb.kind === "ambiguous" && amb.optionsRelated === true).toBe(true);
    expect(analyzeTelegramText(EQUITY_TEXT).kind).toBe("signal");
    const eqAmb = analyzeTelegramText(EQUITY_AMBIGUOUS);
    expect(eqAmb.kind === "ambiguous" && eqAmb.optionsRelated !== true).toBe(true);
    expect(analyzeTelegramText(NO_DIRECTIVE).kind).toBe("none");
  });
  it("blocks equity-style, equity-ambiguous and directive-less messages from an APPROVED chat, for all four update kinds, with zero database access", async () => {
    for (const kind of KINDS) {
      for (const [name, text, analysisKind] of [["equity", EQUITY_TEXT, "signal"], ["equity ambiguous", EQUITY_AMBIGUOUS, "ambiguous"], ["no directive", NO_DIRECTIVE, "none"]] as const) {
        const { db, touches } = untouchableDb();
        const { records, logger } = capture();
        const outcome = await processTelegramJob(jobOf(kind, APPROVED, text), "c", db, { logger, intakePolicy: approvedOnly(true) });
        expect(outcome, `${kind}/${name}`).toEqual({ outcome: "non_options_blocked", reasonCodes: ["options_only.not_an_options_message"] });
        expect(touches, `${kind}/${name}`).toEqual([]);
        expect(records.find((r) => r.event === "worker.intake.non_options_blocked")?.["analysisKind"]).toBe(analysisKind);
        expect(JSON.stringify(records)).not.toContain(text);
      }
    }
  });
  it("an unreadable text (not a string) fails closed", async () => {
    const { db, touches } = untouchableDb();
    const { records, logger } = capture();
    const outcome = await processTelegramJob(jobOf("message", APPROVED, OPTIONS_TEXT, (m) => { m["rawText"] = 12345; }), "c", db, { logger, intakePolicy: approvedOnly(true) });
    expect(outcome.outcome).toBe("non_options_blocked");
    expect(touches).toEqual([]);
    expect(records.find((r) => r.event === "worker.intake.non_options_blocked")?.["analysisKind"]).toBe("unreadable");
  });
  it("lets options messages through (claim, unsupported underlying, options-related ambiguity): they go on to the options path", async () => {
    for (const kind of KINDS) {
      for (const text of [OPTIONS_TEXT, OPTIONS_UNSUPPORTED, OPTIONS_AMBIGUOUS]) {
        const { db, touches } = untouchableDb();
        await processTelegramJob(jobOf(kind, APPROVED, text), "c", db, { logger: capture().logger, intakePolicy: approvedOnly(true) }).catch(() => undefined);
        expect(touches.length, `${kind}: ${analyzeTelegramText(text).kind}`).toBeGreaterThan(0);
      }
    }
  });
  it("the mode is explicit: with it OFF an equity-style message from an approved chat proceeds (so ON is what blocks it)", async () => {
    const { db, touches } = untouchableDb();
    await processTelegramJob(jobOf("message", APPROVED, EQUITY_TEXT), "c", db, { logger: capture().logger, intakePolicy: approvedOnly(false) }).catch(() => undefined);
    expect(touches.length).toBeGreaterThan(0);
  });
  it("gate 1 still applies in options-only mode: an options message from an unapproved chat is rejected", async () => {
    const { db, touches } = untouchableDb();
    const outcome = await processTelegramJob(jobOf("message", OTHER, OPTIONS_TEXT), "c", db, { logger: capture().logger, intakePolicy: approvedOnly(true) });
    expect(outcome.outcome).toBe("chat_not_approved");
    expect(touches).toEqual([]);
  });
});

describe("static guarantees", () => {
  it("the gates sit before the first database/ingestion call and no equity/provider call is reachable from them", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("services/worker/src/index.ts", "utf8");
    const start = src.indexOf("export async function processTelegramJob");
    const body = src.slice(start);
    const gate1 = body.indexOf("policy.isChatApproved");
    const gate2 = body.indexOf("policy.optionsOnly");
    const firstWrite = body.indexOf("runIngestionJob(db");
    expect(gate1).toBeGreaterThan(0);
    expect(gate2).toBeGreaterThan(gate1);
    expect(firstWrite).toBeGreaterThan(gate2);
    expect(body.indexOf("marketDataProviders.get")).toBeGreaterThan(firstWrite);
    expect(src).toMatch(/loadTelegramIntakePolicy\(\)/);
  });
});
