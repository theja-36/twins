import { describe, expect, it } from "vitest";
import { ApprovalBot, FatalBotError, EXIT_EGRESS, EXIT_PRIVILEGES, EXIT_TELEGRAM, EXIT_TOO_MANY_ERRORS } from "../../../services/approval-bot/src/bot";
import { createLogger } from "../../../services/approval-bot/src/log";
import { APPROVER, CHANNEL, FakeBotApi, MemoryBotDb, OTHER_CHANNEL, STRANGER, TestClock, TelegramApiError, makeClaim, silentLogger, testConfig } from "../../support/approvalBotFakes";

function setup(env: Record<string, string> = {}) {
  const clock = new TestClock();
  const db = new MemoryBotDb(clock);
  const api = new FakeBotApi();
  const out = silentLogger();
  const log = createLogger(out.write, () => clock.ms);
  const cfg = testConfig(env);
  const bot = new ApprovalBot({ cfg, api, db, log, now: clock.now, sleep: async (ms) => clock.advance(ms / 1000) });
  return { clock, db, api, out, bot, cfg };
}
const ok = async () => true;
async function activated(env: Record<string, string> = {}) {
  const s = setup(env);
  await s.bot.startup(ok, true);
  s.clock.advance(10); // claims created after this instant are "new"
  return s;
}
async function oneCard(env: Record<string, string> = {}) {
  const s = await activated(env);
  const claim = makeClaim(s.clock);
  s.db.claims.push(claim);
  await s.bot.runCycle(0);
  return { ...s, claim, card: [...s.db.cards.values()][0]!, msg: s.api.sent[0]! };
}
const approve = (s: { msg: { buttons: { callback_data: string }[] | undefined } }) => s.msg.buttons![0]!.callback_data;
const reject = (s: { msg: { buttons: { callback_data: string }[] | undefined } }) => s.msg.buttons![1]!.callback_data;

describe("startup", () => {
  it("checks egress first, then privileges, then identity; a failure stops before the next step", async () => {
    const s = setup();
    let calls = 0;
    s.db.checkPrivileges = async () => (calls++, []);
    await expect(s.bot.startup(async () => false, true)).rejects.toMatchObject({ reason: "egress_unrestricted", exitCode: EXIT_EGRESS });
    expect(calls).toBe(0);
    expect(s.db.state).toBeNull();
    const p = setup();
    p.db.privilegeProblems = ["can_write:options_claims"];
    let meCalls = 0;
    p.api.getMe = async () => (meCalls++, { id: 1, username: "x" });
    await expect(p.bot.startup(ok, true)).rejects.toMatchObject({ reason: "privileges", exitCode: EXIT_PRIVILEGES });
    expect(meCalls).toBe(0); // the bot never contacts Telegram with a role that could write claims or read channel text
    expect(p.db.state).toBeNull();
    expect(p.out.lines.join("")).toContain("can_write:options_claims");
  });
  it("a rejected token is fatal; activation creates the state row only when asked to", async () => {
    const s = setup();
    s.api.meError = new TelegramApiError("getMe", 401);
    await expect(s.bot.startup(ok, true)).rejects.toMatchObject({ reason: "telegram_unauthorized", exitCode: EXIT_TELEGRAM });
    const t = setup();
    await t.bot.startup(ok, false); // handshake: no activation
    expect(t.db.state).toBeNull();
    await t.bot.startup(ok, true);
    expect(t.db.state).toMatchObject({ paused: false, updateOffset: 0 });
    const first = t.db.state!.activatedAt;
    t.clock.advance(100);
    await t.bot.startup(ok, true);
    expect(t.db.state!.activatedAt).toBe(first); // a restart does not move the activation time
  });
});

describe("selecting and sending cards", () => {
  it("sends a card with two buttons for a NEW parsed claim and records it; never before activation", async () => {
    const s = setup();
    const old = makeClaim(s.clock); // exists before the bot is activated (like the 32 pilot claims)
    s.db.claims.push(old);
    s.clock.advance(5);
    await s.bot.startup(ok, true);
    s.clock.advance(5);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(0); // no backfill
    const fresh = makeClaim(s.clock);
    s.db.claims.push(fresh);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(1);
    const m = s.api.sent[0]!;
    expect(m.chatId).toBe(APPROVER);
    expect(m.buttons!.map((b) => b.text)).toEqual(["Approve (record only)", "Reject"]);
    expect(m.text).toContain("UNVERIFIED");
    const card = [...s.db.cards.values()][0]!;
    expect(card).toMatchObject({ kind: "claim", state: "sent", telegramMessageId: m.messageId, claimId: fresh.claimId });
    expect(card.cardTextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.db.eventTypes()).toContain("card_sent");
  });
  it("only parsed claims from the configured channel, once each", async () => {
    const s = await activated();
    s.db.claims.push(makeClaim(s.clock, { channel: OTHER_CHANNEL }), makeClaim(s.clock, { resultKind: "ambiguous" }), makeClaim(s.clock, { resultKind: "unsupported" }));
    const good = makeClaim(s.clock);
    s.db.claims.push(good);
    await s.bot.runCycle(0);
    await s.bot.runCycle(0);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(1);
    expect([...s.db.cards.values()].map((c) => c.claimId)).toEqual([good.claimId]);
  });
  it("respects the per-cycle, hourly and daily caps (a burst becomes a backlog, not a flood)", async () => {
    const s = await activated({ TWINS_BOT_MAX_PER_CYCLE: "2", TWINS_BOT_MAX_PER_HOUR: "3", TWINS_BOT_MAX_PER_DAY: "100" });
    for (let i = 0; i < 6; i++) s.db.claims.push(makeClaim(s.clock, { externalMessageId: String(100 + i), createdAt: new Date(s.clock.ms + i) }));
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(2);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(3); // hourly cap of 3 reached
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(3);
    s.clock.advance(3601);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(5);
    const d = await activated({ TWINS_BOT_MAX_PER_CYCLE: "5", TWINS_BOT_MAX_PER_HOUR: "100", TWINS_BOT_MAX_PER_DAY: "2" });
    for (let i = 0; i < 4; i++) d.db.claims.push(makeClaim(d.clock, { createdAt: new Date(d.clock.ms + i) }));
    await d.bot.runCycle(0);
    await d.bot.runCycle(0);
    expect(d.api.sent).toHaveLength(2); // daily cap
  });
  it("a Telegram failure leaves the card pending and it is retried; a rate limit pauses all sending for retry_after", async () => {
    const s = await activated();
    s.db.claims.push(makeClaim(s.clock));
    s.api.sendError = new TelegramApiError("sendMessage", 429, 90);
    await s.bot.runCycle(0);
    expect([...s.db.cards.values()][0]).toMatchObject({ state: "pending", telegramMessageId: null });
    expect(s.db.events.find((e) => e.type === "telegram_error")!.detail).toEqual({ method: "sendMessage", code: 429 });
    s.api.sendError = null;
    s.clock.advance(60);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(0); // still inside retry_after
    s.clock.advance(40);
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(1); // the pending card is delivered, no second card is created
    expect(s.db.cards.size).toBe(1);
    expect([...s.db.cards.values()][0]!.state).toBe("sent");
  });
  it("a pending card that never could be sent expires with the others; unauthorized is fatal", async () => {
    const s = await activated();
    s.db.claims.push(makeClaim(s.clock));
    s.api.sendError = new TelegramApiError("sendMessage", 500);
    await s.bot.runCycle(0);
    s.clock.advance(14401);
    await s.bot.runCycle(0);
    expect([...s.db.cards.values()][0]!.state).toBe("expired");
    s.api.sendError = new TelegramApiError("sendMessage", 401);
    s.db.claims.push(makeClaim(s.clock));
    await expect(s.bot.runCycle(0)).rejects.toMatchObject({ reason: "telegram_unauthorized" });
  });
  it("does not send while paused", async () => {
    const s = await activated();
    s.db.state!.paused = true;
    s.db.claims.push(makeClaim(s.clock));
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(0);
  });
});

describe("decisions", () => {
  it("approve records one review with evidence, edits the card, answers the tap - and leaves the claim untouched", async () => {
    const s = await oneCard();
    const before = JSON.stringify(s.db.claims);
    s.api.inbox.push(s.api.tap(10, approve(s)));
    const r = await s.bot.runCycle(0);
    expect(r.decisions[0]).toMatchObject({ kind: "decision", cardKind: "claim", action: "approve" });
    expect(s.db.reviews).toHaveLength(1);
    expect(s.db.reviews[0]).toMatchObject({ cardId: s.card.id, claimId: s.claim.claimId, decision: "approve", approver: APPROVER, messageId: s.msg.messageId, updateId: 10 });
    expect(s.db.reviews[0]!.evidence).toMatchObject({ claim_id: s.claim.claimId, parser_version: "telegram-regex-v2" });
    expect(s.db.cards.get(s.card.id)!.state).toBe("decided");
    expect(s.api.edits[0]!.text).toContain(">> APPROVED (recorded only - no order) at");
    expect(s.api.edits[0]!.text).toContain("BUY (presumed long entry) NIFTY 24500 CE"); // the card text stays, with the outcome appended
    expect(s.api.answers[0]!.text).toBe("Approval recorded (no order is placed).");
    expect(JSON.stringify(s.db.claims)).toBe(before); // the claims are never modified: approval_possible stays false
    expect(s.db.eventTypes()).toContain("decision");
  });
  it("reject is recorded the same way", async () => {
    const s = await oneCard();
    s.api.inbox.push(s.api.tap(11, reject(s)));
    await s.bot.runCycle(0);
    expect(s.db.reviews[0]).toMatchObject({ decision: "reject" });
    expect(s.api.edits[0]!.text).toContain(">> REJECTED (recorded)");
  });
  it("is single use: a second tap, a replayed update or the opposite button record nothing more", async () => {
    const s = await oneCard();
    s.api.inbox.push(s.api.tap(10, approve(s)));
    await s.bot.runCycle(0);
    s.api.inbox.push(s.api.tap(10, approve(s)), s.api.tap(12, approve(s)), s.api.tap(13, reject(s)));
    const r = await s.bot.runCycle(0);
    expect(s.db.reviews).toHaveLength(1);
    expect(r.decisions.map((d) => d.kind)).toEqual(["stale", "stale"]); // update 10 was already consumed (offset), 12 and 13 are stale
    expect(s.api.answers.filter((a) => a.text === "This card is no longer active.")).toHaveLength(2);
    expect(s.db.cards.get(s.card.id)!.state).toBe("decided");
  });
  it("a tap after the card expired records nothing and is reported as stale; the card message is edited to 'expired'", async () => {
    const s = await oneCard();
    s.clock.advance(4 * 3600 + 1);
    s.api.inbox.push(s.api.tap(10, approve(s)));
    const r = await s.bot.runCycle(0);
    expect(s.db.reviews).toHaveLength(0);
    expect(r.expired).toBe(1);
    expect(s.db.cards.get(s.card.id)!.state).toBe("expired");
    expect(s.api.edits[0]!.text).toBe("TWINS card " + s.card.id.replace(/-/g, "").slice(0, 4).toUpperCase() + " expired - no decision was recorded.");
    expect(r.decisions[0]).toMatchObject({ kind: "stale" });
    expect(s.db.eventTypes()).toContain("card_expired");
  });
  it("the card TTL is the configured 4 hours; a tap just before expiry still works", async () => {
    const s = await oneCard();
    s.clock.advance(4 * 3600 - 5);
    s.api.inbox.push(s.api.tap(10, reject(s)));
    await s.bot.runCycle(0);
    expect(s.db.reviews).toHaveLength(1);
  });
  it("persists the update offset after each update", async () => {
    const s = await oneCard();
    s.api.inbox.push(s.api.tap(41, approve(s)));
    await s.bot.runCycle(0);
    expect(s.db.state!.updateOffset).toBe(42);
    await s.bot.runCycle(0);
    expect(s.api.offsets[s.api.offsets.length - 1]).toBe(42);
  });
});

describe("who and what is accepted", () => {
  const setupWithCard = oneCard;
  const nothingRecorded = (s: Awaited<ReturnType<typeof oneCard>>) => {
    expect(s.db.reviews).toHaveLength(0);
    expect(s.db.cards.get(s.card.id)!.state).toBe("sent");
    expect(s.api.edits).toHaveLength(0);
  };
  it("ignores taps from anyone but the approver, in any chat but the approver's private chat", async () => {
    const s = await setupWithCard();
    const data = approve(s);
    const cases: Array<[string, ReturnType<typeof s.api.tap>]> = [
      ["stranger", s.api.tap(20, data, { from: STRANGER })],
      ["stranger in the approver chat", s.api.tap(21, data, { from: STRANGER, chat: APPROVER })],
      ["approver in a group", s.api.tap(22, data, { chat: -100555, chatType: "supergroup" })],
      ["approver in another private chat", s.api.tap(23, data, { chat: STRANGER })],
      ["approver but chat type group", s.api.tap(24, data, { chatType: "group" })],
      ["a bot sender", s.api.tap(25, data, { fromIsBot: true })],
    ];
    for (const [, update] of cases) s.api.inbox.push(update);
    const r = await s.bot.runCycle(0);
    expect(r.decisions.every((d) => d.kind === "rejected")).toBe(true);
    nothingRecorded(s);
    s.api.inbox.push({ update_id: 26, callback_query: { id: "x", data } }); // no from, no message
    await s.bot.runCycle(0);
    nothingRecorded(s);
  });
  it("rejects tampered, swapped, foreign and malformed button data", async () => {
    const s = await setupWithCard();
    const good = approve(s);
    const other = await setupWithCard();
    const otherData = approve(other);
    const flipped = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    const swapped = good.replace(".a.", ".r."); // approve MAC presented as reject
    for (const [i, data] of [flipped, swapped, otherData, "garbage", "v1.xxxxxxxxxxxxxxxxxxxxxx.a.yyyyyyyyyyyyyyyy", good + "0", ""].entries()) {
      s.api.inbox.push(s.api.tap(30 + i, data));
    }
    const r = await s.bot.runCycle(0);
    expect(r.decisions.every((d) => d.kind === "rejected")).toBe(true);
    expect(r.decisions.map((d) => (d.kind === "rejected" ? d.reason : ""))).toEqual(["bad_hmac", "bad_hmac", "unknown_card", "bad_data", "unknown_card", "bad_data", "bad_data"]);
    nothingRecorded(s);
  });
  it("rejects a tap that comes from a different message than the card's", async () => {
    const s = await setupWithCard();
    s.api.inbox.push(s.api.tap(40, approve(s), { messageId: s.msg.messageId + 1 }));
    const r = await s.bot.runCycle(0);
    expect(r.decisions[0]).toMatchObject({ kind: "rejected", reason: "wrong_message" });
    nothingRecorded(s);
  });
  it("security events are rate limited so strangers cannot fill the audit table", async () => {
    const s = await setupWithCard();
    for (let i = 0; i < 50; i++) s.api.inbox.push(s.api.tap(100 + i, approve(s), { from: STRANGER }));
    await s.bot.runCycle(0);
    expect(s.db.events.filter((e) => e.type === "callback_rejected:not_approver")).toHaveLength(1);
    s.clock.advance(61);
    s.api.inbox.push(s.api.tap(200, approve(s), { from: STRANGER }));
    await s.bot.runCycle(0);
    const rows = s.db.events.filter((e) => e.type === "callback_rejected:not_approver");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.detail).toEqual({ suppressed_before: 49 });
  });
});

describe("approver commands", () => {
  it("/status, /pause and /resume work for the approver only", async () => {
    const s = await oneCard();
    s.api.inbox.push(s.api.text(50, "/status"));
    await s.bot.runCycle(0);
    expect(s.api.sent[1]!.text).toContain("TWINS approval bot: online. It records your decision only and places no order.");
    expect(s.api.sent[1]!.text).toContain("awaiting you: 1");
    s.api.inbox.push(s.api.text(51, "/pause"));
    await s.bot.runCycle(0);
    expect(s.db.state!.paused).toBe(true);
    s.db.claims.push(makeClaim(s.clock, { createdAt: new Date(s.clock.ms + 1) }));
    await s.bot.runCycle(0);
    expect(s.db.cards.size).toBe(1); // paused: no new card
    s.api.inbox.push(s.api.text(52, "/resume@twins_test_bot"));
    await s.bot.runCycle(0);
    expect(s.db.state!.paused).toBe(false);
    expect(s.db.eventTypes()).toEqual(expect.arrayContaining(["paused", "resumed"]));
    await s.bot.runCycle(0); // flush the card held back while paused
    const before = s.api.sent.length;
    s.api.inbox.push(s.api.text(53, "/pause", { from: STRANGER, chat: STRANGER }), s.api.text(54, "/pause", { chatType: "group" }), s.api.text(55, "hello there"), s.api.text(56, "/unknown"));
    const r = await s.bot.runCycle(0);
    expect(r.decisions.map((d) => d.kind)).toEqual(["rejected", "rejected", "ignored", "ignored"]);
    expect(s.db.state!.paused).toBe(false);
    expect(s.api.sent.length).toBe(before);
  });
});

describe("the service loop", () => {
  it("keeps going after transient errors, honours rate limits and gives up after too many in a row", async () => {
    const s = await activated();
    let n = 0;
    s.api.getUpdatesError = new TelegramApiError("getUpdates", 429, 20);
    const t0 = s.clock.ms;
    await s.bot.run(() => n++ >= 2);
    expect(s.clock.ms - t0).toBeGreaterThanOrEqual(20_000); // waited retry_after
    const f = await activated();
    f.api.getUpdates = async () => {
      throw new TelegramApiError("getUpdates", 502);
    };
    await expect(f.bot.run(() => false)).rejects.toMatchObject({ reason: "too_many_errors", exitCode: EXIT_TOO_MANY_ERRORS });
    const g = await activated();
    g.db.failNext = new Error("database down");
    let m = 0;
    await g.bot.run(() => m++ >= 3); // one database failure is survived
    const u = await activated();
    u.api.getUpdatesError = new TelegramApiError("getUpdates", 401);
    await expect(u.bot.run(() => false)).rejects.toMatchObject({ reason: "telegram_unauthorized" });
  });
});

describe("handshake (test card)", () => {
  it("sends a labelled TEST card with no claim; a tap is recorded as a test decision only", async () => {
    const s = setup();
    await s.bot.startup(ok, false);
    const done = s.bot.handshake(600, () => false);
    await Promise.resolve();
    // the card is sent synchronously after createCard; give the async chain a turn
    for (let i = 0; i < 20 && s.api.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const msg = s.api.sent[0]!;
    expect(msg.text).toContain("HANDSHAKE TEST CARD");
    expect(msg.buttons!.map((b) => b.text)).toEqual(["Approve (test)", "Reject (test)"]);
    s.api.inbox.push(s.api.tap(5, msg.buttons![0]!.callback_data));
    const result = await done;
    expect(result).toMatchObject({ kind: "decision", cardKind: "test", action: "approve" });
    expect([...s.db.cards.values()][0]).toMatchObject({ kind: "test", claimId: null, state: "decided" });
    expect(s.db.reviews).toHaveLength(0); // a test creates no claim review
    expect(s.db.eventTypes()).toEqual(expect.arrayContaining(["handshake_card_sent", "test_decision"]));
    expect(s.api.edits[0]!.text).toContain(">> TEST APPROVED");
    expect(s.db.state).toBeNull(); // nothing activated, no offset persisted
  });
  it("times out cleanly when nobody taps", async () => {
    const s = setup();
    await s.bot.startup(ok, false);
    s.api.onPoll = (t) => s.clock.advance(t); // an empty long poll takes its full timeout
    const done = s.bot.handshake(300, () => false);
    const result = await done;
    expect(result).toEqual({ kind: "timeout" });
    expect([...s.db.cards.values()][0]!.state).toBe("expired");
  });
});

describe("logging", () => {
  it("never writes message text, claim contents, the token or the key", async () => {
    const s = await oneCard();
    s.api.inbox.push(s.api.tap(10, approve(s)), s.api.tap(11, "garbage"), s.api.tap(12, approve(s), { from: STRANGER }));
    await s.bot.runCycle(0);
    const all = s.out.lines.join("");
    expect(all.length).toBeGreaterThan(0);
    for (const line of s.out.lines) JSON.parse(line);
    for (const secret of ["AAFakeToken", "abababab", "NIFTY", "24500", "INSUFFICIENT"]) expect(all).not.toContain(secret);
    expect(() => createLogger(() => undefined).log("bot.test", { text: "x" } as never)).toThrow();
    expect(() => createLogger(() => undefined).log("bot.test", { reason: "has spaces and text" })).toThrow();
    expect(() => createLogger(() => undefined).log("Bad Event")).toThrow();
  });
  it("FatalBotError carries the reason and exit code", () => {
    expect(new FatalBotError("x", 79)).toMatchObject({ reason: "x", exitCode: 79 });
    expect(CHANNEL).toBe("tg_chat_-1001000000001");
  });
});
