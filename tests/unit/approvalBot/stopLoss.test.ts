import { describe, expect, it } from "vitest";
import { ApprovalBot } from "../../../services/approval-bot/src/bot";
import { buildCallbackData } from "../../../services/approval-bot/src/callback";
import { createLogger } from "../../../services/approval-bot/src/log";
import { FakeBotApi, MemoryBotDb, TestClock, claimJson, makeClaim, silentLogger, testConfig } from "../../support/approvalBotFakes";

async function withClaim(claimOver: Record<string, unknown>) {
  const clock = new TestClock();
  const db = new MemoryBotDb(clock);
  const api = new FakeBotApi();
  const out = silentLogger();
  const cfg = testConfig();
  const bot = new ApprovalBot({ cfg, api, db, log: createLogger(out.write, () => clock.ms), now: clock.now, sleep: async (ms) => clock.advance(ms / 1000) });
  await bot.startup(async () => true, true);
  clock.advance(10);
  db.claims.push(makeClaim(clock, { claim: claimJson(claimOver) }));
  await bot.runCycle(0);
  const card = [...db.cards.values()][0];
  const sent = api.sent[0];
  if (!card || !sent) throw new Error("no card was sent");
  return { bot, db, api, cfg, card, sent };
}

const INVALID: Array<[string, Record<string, unknown>, string]> = [
  ["missing", { stopLoss: null }, "MISSING_STOP_LOSS"],
  ["zero", { stopLoss: 0 }, "INVALID_STOP_LOSS"],
  ["negative", { stopLoss: -5 }, "INVALID_STOP_LOSS"],
  ["non-numeric", { stopLoss: "abc" }, "INVALID_STOP_LOSS"],
  ["equal to the entry", { stopLoss: 120 }, "STOP_LOSS_EQUALS_ENTRY"],
  ["wrong side for a BUY", { stopLoss: 140 }, "STOP_LOSS_DIRECTION_INVALID"],
  ["too far", { stopLoss: 20 }, "STOP_LOSS_TOO_FAR"],
  ["basis not stated", { levelBasis: "unspecified" }, "STOP_LOSS_BASIS_UNSPECIFIED"],
  ["no entry price", { entry: { type: "unspecified" } }, "STOP_LOSS_REFERENCE_MISSING"],
];

describe("approval bot: a claim without a VALID stop-loss can never be approved (Stage 1 / Task 4)", () => {
  it("control: a valid stop-loss shows VALID on the card, offers Approve and Reject, and an approve is recorded", async () => {
    const s = await withClaim({});
    expect(s.sent.text).toContain("Stop-loss: VALID (90 vs entry 120, 25% risk, premium basis)");
    expect(s.sent.buttons).toHaveLength(2);
    s.api.inbox.push(s.api.tap(10, s.sent.buttons?.[0]?.callback_data ?? ""));
    const r = await s.bot.runCycle(0);
    expect(r.decisions[0]).toMatchObject({ kind: "decision", action: "approve" });
    expect(s.db.reviews).toHaveLength(1);
  });

  it.each(INVALID)("%s: the card says so, offers ONLY Reject, and a forged Approve callback is refused (nothing recorded)", async (_n, over, code) => {
    const s = await withClaim(over);
    expect(s.sent.text).toContain(`Stop-loss: NOT VALID (${code}) - approval is DISABLED`);
    expect(s.sent.buttons).toHaveLength(1);
    expect(s.sent.buttons?.[0]?.text).toBe("Reject");
    // a forged approve: correctly signed for this card, as if the button had existed
    const forged = buildCallbackData(s.cfg.hmacKey, s.card.id, s.card.nonce, "a");
    s.api.inbox.push(s.api.tap(20, forged));
    const r = await s.bot.runCycle(0);
    expect(r.decisions[0]).toMatchObject({ kind: "rejected", reason: "stop_loss_not_valid" });
    expect(s.db.reviews).toHaveLength(0);
    expect(s.db.cards.get(s.card.id)?.state).toBe("sent"); // still awaiting a decision
    expect(s.api.answers.at(-1)?.text).toContain("no valid stop-loss");
    expect(s.db.eventTypes().some((t) => t.startsWith("approval_refused:stop_loss_not_valid"))).toBe(true);
    // rejecting remains possible
    s.api.inbox.push(s.api.tap(21, s.sent.buttons?.[0]?.callback_data ?? ""));
    await s.bot.runCycle(0);
    expect(s.db.reviews[0]).toMatchObject({ decision: "reject" });
  });

  it("a claim stored before the rule existed (no stop_loss reasons in it) is judged by the shared rule from its stored fields", async () => {
    const s = await withClaim({ stopLoss: null });
    expect(s.sent.text).toContain("MISSING_STOP_LOSS");
  });
});
