import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBot } from "../../../services/approval-bot/src/bot";
import { createLogger } from "../../../services/approval-bot/src/log";
import { configureRuntimeState, inMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { buildCallbackData } from "../../../services/approval-bot/src/callback";
import { APPROVER, FakeBotApi, MemoryBotDb, STRANGER, TestClock, silentLogger, testConfig } from "../../support/approvalBotFakes";

const CARD = "11111111-2222-4333-8444-555555555555";
const DECISION = "99999999-2222-4333-8444-555555555555";
const TEXT = "TWINS RISK-REVIEWED PROPOSAL\nsynthetic card text for the test\nThis is a risk-reviewed proposal, not investment advice.";

function setup() {
  configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 });
  const clock = new TestClock();
  const db = new MemoryBotDb(clock);
  const api = new FakeBotApi();
  const out = silentLogger();
  const bot = new ApprovalBot({ cfg: testConfig(), api, db, log: createLogger(out.write, () => clock.ms), now: clock.now, sleep: async (ms) => clock.advance(ms / 1000) });
  const addCard = (over: { id?: string; decisionId?: string; ttl?: number } = {}) => db.riskCards.set(over.id ?? CARD, { id: over.id ?? CARD, decisionId: over.decisionId ?? DECISION, nonce: "ab".repeat(16), cardText: TEXT, cardContentSha256: "0".repeat(64), state: "pending", telegramMessageId: null, expiresAt: new Date(clock.ms + (over.ttl ?? 900) * 1000) });
  return { clock, db, api, out, bot, addCard };
}
afterEach(() => configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }));
async function sent() {
  const s = setup();
  await s.bot.startup(async () => true, true);
  s.clock.advance(10);
  s.addCard();
  await s.bot.runCycle(0);
  return { ...s, msg: s.api.sent[0]! };
}
const approve = (s: { msg: { buttons: { callback_data: string }[] | undefined } }) => s.msg.buttons![0]!.callback_data;
const reject = (s: { msg: { buttons: { callback_data: string }[] | undefined } }) => s.msg.buttons![1]!.callback_data;

describe("risk-approval cards through the bot (synthetic data, no Telegram network)", () => {
  it("sends the application-rendered text unchanged with Approve (record only) and Reject buttons, and marks the card sent", async () => {
    const s = await sent();
    expect(s.msg.text).toBe(TEXT);
    expect(s.msg.buttons!.map((b) => b.text)).toEqual(["Approve (record only)", "Reject"]);
    expect(s.db.riskCards.get(CARD)).toMatchObject({ state: "sent", telegramMessageId: s.msg.messageId });
    expect(s.db.eventTypes()).toContain("risk_card_sent");
    await s.bot.runCycle(0);
    expect(s.api.sent).toHaveLength(1); // not sent twice
  });
  it("APPROVE records one approval for the decision, confirms to the approver, and places no order", async () => {
    const s = await sent();
    const r = await s.bot.handleUpdate(s.api.tap(1, approve(s)));
    expect(r).toEqual({ kind: "decision", cardId: CARD, cardKind: "risk", action: "approve" });
    expect(s.db.riskApprovals).toEqual([{ cardId: CARD, decisionId: DECISION, action: "approve", approver: APPROVER, updateId: 1 }]);
    expect(s.api.answers[0]?.text).toMatch(/no order is placed/);
    expect(s.api.edits.at(-1)?.text).toContain(TEXT);
    expect(s.db.riskCards.get(CARD)?.state).toBe("decided");
  });
  it("REJECT is recorded", async () => {
    const s = await sent();
    expect(await s.bot.handleUpdate(s.api.tap(1, reject(s)))).toMatchObject({ kind: "decision", action: "reject" });
    expect(s.db.riskApprovals).toMatchObject([{ action: "reject" }]);
  });
  it("a second tap records nothing (single use) and a replay is stale", async () => {
    const s = await sent();
    await s.bot.handleUpdate(s.api.tap(1, approve(s)));
    expect(await s.bot.handleUpdate(s.api.tap(2, approve(s)))).toMatchObject({ kind: "stale" });
    expect(await s.bot.handleUpdate(s.api.tap(3, reject(s)))).toMatchObject({ kind: "stale" });
    expect(s.db.riskApprovals).toHaveLength(1);
  });
  it("when the decision changed (the database refuses) nothing is approved, the approver is told and the card is expired", async () => {
    const s = await sent();
    s.db.riskRefusal = "decision_superseded";
    expect(await s.bot.handleUpdate(s.api.tap(1, approve(s)))).toEqual({ kind: "stale", reason: "decision_superseded" });
    expect(s.db.riskApprovals).toEqual([]);
    expect(s.db.riskCards.get(CARD)?.state).toBe("expired");
    expect(s.api.answers[0]?.text).toMatch(/can no longer be approved/);
    expect(s.db.eventTypes()).toContain("risk_approval_refused:decision_superseded");
  });
  it("an expired card cannot be approved or rejected; expiry edits the message", async () => {
    const s = await sent();
    s.clock.advance(901);
    expect(await s.bot.handleUpdate(s.api.tap(1, approve(s)))).toMatchObject({ kind: "stale", reason: "expired" });
    expect(s.db.riskApprovals).toEqual([]);
    const r = await s.bot.runCycle(0);
    expect(r.expired).toBeGreaterThanOrEqual(0);
    expect(s.db.riskCards.get(CARD)?.state).toBe("expired");
    expect(s.db.eventTypes()).toContain("risk_card_expired");
  });
  it("an approval is refused while the kill switch is on (no database call); a rejection is still recorded", async () => {
    const s = await sent();
    const source = inMemoryStateSource();
    source.set({ KILL_SWITCH_ACTIVE: true });
    configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
    expect(await s.bot.handleUpdate(s.api.tap(1, approve(s)))).toEqual({ kind: "rejected", reason: "safety_halt" });
    expect(s.db.riskApprovals).toEqual([]);
    expect(s.db.riskCards.get(CARD)?.state).toBe("sent");
    expect(await s.bot.handleUpdate(s.api.tap(2, reject(s)))).toMatchObject({ kind: "decision", action: "reject" });
    expect(s.db.riskApprovals).toMatchObject([{ action: "reject" }]);
  });
  it("an unreadable runtime state also blocks an approval (fail closed)", async () => {
    const s = await sent();
    const source = inMemoryStateSource();
    source.failWith(new Error("down"));
    configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
    expect(await s.bot.handleUpdate(s.api.tap(1, approve(s)))).toEqual({ kind: "rejected", reason: "safety_halt" });
    expect(s.db.riskApprovals).toEqual([]);
  });
  it("no card is sent while the kill switch is on or the state is unreadable", async () => {
    const s = setup();
    await s.bot.startup(async () => true, true);
    s.clock.advance(10);
    s.addCard();
    const source = inMemoryStateSource();
    source.set({ KILL_SWITCH_ACTIVE: true });
    configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
    await s.bot.runCycle(0);
    expect(s.api.sent).toEqual([]);
    expect(s.db.riskCards.get(CARD)?.state).toBe("pending");
  });
  it("only the approver can act: a stranger, a forged HMAC or the wrong message record nothing", async () => {
    const s = await sent();
    expect(await s.bot.handleUpdate(s.api.tap(1, approve(s), { from: STRANGER }))).toMatchObject({ kind: "rejected", reason: "not_approver" });
    expect(await s.bot.handleUpdate(s.api.tap(2, buildCallbackData("ff".repeat(32), CARD, "ab".repeat(16), "a")))).toMatchObject({ kind: "rejected", reason: "bad_hmac" });
    expect(await s.bot.handleUpdate(s.api.tap(3, approve(s), { messageId: 4242 }))).toMatchObject({ kind: "rejected", reason: "wrong_message" });
    expect(buildCallbackData(testConfig().hmacKey, CARD, "ab".repeat(16), "a")).toBe(approve(s));
    expect(s.db.riskApprovals).toEqual([]);
    expect(s.db.riskCards.get(CARD)?.state).toBe("sent");
  });
  it("a database failure while recording propagates (nothing is reported as approved)", async () => {
    const s = await sent();
    s.db.failNext = new Error("connection lost");
    await expect(s.bot.handleUpdate(s.api.tap(1, approve(s)))).rejects.toThrow(/connection lost/);
    expect(s.db.riskApprovals).toEqual([]);
    expect(s.api.answers).toEqual([]);
  });
});
