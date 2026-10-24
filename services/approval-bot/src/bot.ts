import { randomBytes, randomUUID } from "node:crypto";
import { buildCallbackData, parseCallbackData, verifyCallback } from "./callback";
import { renderClaimCard, renderExpired, renderOutcome, renderTestCard, type CardContext, type ClaimRow } from "./card";
import type { BotConfig } from "./config";
import type { BotDb, CardRow } from "./db";
import type { BotLogger } from "./log";
import { TelegramApiError, type BotApiPort, type InlineButton, type TelegramUpdate } from "./telegramApi";

/** A condition that stops the service (after an alert): the caller holds 15 minutes, then exits, so a restart loop cannot hammer anything. */
export class FatalBotError extends Error {
  constructor(readonly reason: string, readonly exitCode: number) {
    super(reason);
    this.name = "FatalBotError";
  }
}

export const EXIT_PRIVILEGES = 76;
export const EXIT_EGRESS = 79;
export const EXIT_TELEGRAM = 77;
export const EXIT_TOO_MANY_ERRORS = 78;

export type UpdateResult =
  | { kind: "ignored" }
  | { kind: "rejected"; reason: string }
  | { kind: "stale"; reason: string }
  | { kind: "decision"; cardId: string; cardKind: "claim" | "test"; action: "approve" | "reject" }
  | { kind: "command"; command: string };

export interface BotDeps {
  cfg: BotConfig;
  api: BotApiPort;
  db: BotDb;
  log: BotLogger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

const REJECT_EVENT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 10;

const shortCard = (id: string): string => id.replace(/-/g, "").slice(0, 8);

export class ApprovalBot {
  private readonly lastRejectEvent = new Map<string, { at: number; suppressed: number }>();
  private sendBlockedUntil = 0;
  persistOffset = true;
  private memoryOffset = 0;

  constructor(private readonly d: BotDeps) {}

  /** Startup checks in a fixed order; any failure is fatal. Nothing is sent to the approver here. */
  async startup(egressCheck: () => Promise<boolean>, activate: boolean): Promise<void> {
    if (!(await egressCheck())) throw new FatalBotError("egress_unrestricted", EXIT_EGRESS);
    const problems = await this.d.db.checkPrivileges();
    if (problems.length > 0) {
      this.d.log.alert("privileges", { missing: problems[0]!.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60), count: problems.length });
      throw new FatalBotError("privileges", EXIT_PRIVILEGES);
    }
    try {
      const me = await this.d.api.getMe();
      this.d.log.log("bot.identified", { bot: /^[A-Za-z0-9_]{1,40}$/.test(me.username) ? me.username : "unknown" });
    } catch (error) {
      if (error instanceof TelegramApiError && (error.code === 401 || error.code === 404)) throw new FatalBotError("telegram_unauthorized", EXIT_TELEGRAM);
      throw error;
    }
    if (activate) await this.d.db.ensureState(this.d.now());
  }

  private async note(type: string, cardId: string | null, detail: Record<string, string | number | boolean> = {}): Promise<void> {
    await this.d.db.recordEvent(type, cardId, detail);
  }

  /** Security events are recorded at most once a minute per type (the rest is counted), so a flood of strangers cannot fill the audit table. */
  private async noteRejected(type: string, cardId: string | null = null): Promise<void> {
    const t = this.d.now().getTime();
    const prev = this.lastRejectEvent.get(type);
    if (prev && t - prev.at < REJECT_EVENT_INTERVAL_MS) {
      prev.suppressed += 1;
      return;
    }
    this.lastRejectEvent.set(type, { at: t, suppressed: 0 });
    await this.note(type, cardId, prev && prev.suppressed > 0 ? { suppressed_before: prev.suppressed } : {});
  }

  private buttons(card: CardRow, test: boolean): InlineButton[] {
    return [
      { text: test ? "Approve (test)" : "Approve (record only)", callback_data: buildCallbackData(this.d.cfg.hmacKey, card.id, card.nonce, "a") },
      { text: test ? "Reject (test)" : "Reject", callback_data: buildCallbackData(this.d.cfg.hmacKey, card.id, card.nonce, "r") },
    ];
  }

  private ctx(cardId: string): CardContext {
    return { label: this.d.cfg.channelLabel, now: this.d.now(), ttlSeconds: this.d.cfg.cardTtlSeconds, cardId };
  }

  /** Sends one card; on any Telegram problem the card stays 'pending' and is retried next cycle (until it expires). */
  private async deliver(card: CardRow, row: ClaimRow): Promise<boolean> {
    const rendered = renderClaimCard(row, this.ctx(card.id));
    try {
      const messageId = await this.d.api.sendMessage(this.d.cfg.approverId, rendered.text, this.buttons(card, false));
      await this.d.db.markSent(card.id, messageId, rendered.sha256);
      await this.note("card_sent", card.id);
      return true;
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.code === 429) this.sendBlockedUntil = this.d.now().getTime() + Math.min(error.retryAfter ?? 30, 3600) * 1000;
        if (error.code === 401) throw new FatalBotError("telegram_unauthorized", EXIT_TELEGRAM);
        await this.note("telegram_error", card.id, { method: "sendMessage", code: error.code });
        return false;
      }
      throw error;
    }
  }

  private async sendNew(state: { activatedAt: Date; paused: boolean }): Promise<number> {
    const now = this.d.now();
    if (state.paused || now.getTime() < this.sendBlockedUntil) return 0;
    const hour = await this.d.db.countSentSince(new Date(now.getTime() - 3600_000));
    const day = await this.d.db.countSentSince(new Date(now.getTime() - 86400_000));
    let budget = Math.min(this.d.cfg.maxPerCycle, this.d.cfg.maxPerHour - hour, this.d.cfg.maxPerDay - day);
    let sent = 0;
    // 1. cards created earlier whose message could not be sent
    for (const card of await this.d.db.listPendingCards(Math.max(budget, 0))) {
      if (budget <= 0 || this.d.now().getTime() < this.sendBlockedUntil) break;
      const row = await this.d.db.getClaimForCard(card.id);
      if (row && (await this.deliver(card, row))) {
        sent += 1;
        budget -= 1;
      }
    }
    // 2. new claims (created after activation, from the configured source channels only)
    if (budget > 0 && this.d.now().getTime() >= this.sendBlockedUntil) {
      for (const row of await this.d.db.selectNewClaims(state.activatedAt, this.d.cfg.sourceChannels, budget)) {
        if (budget <= 0 || this.d.now().getTime() < this.sendBlockedUntil) break;
        const card = await this.d.db.createCard({ id: randomUUID(), kind: "claim", claimId: row.claimId, nonce: randomBytes(16).toString("hex"), ttlSeconds: this.d.cfg.cardTtlSeconds });
        if (card && (await this.deliver(card, row))) {
          sent += 1;
          budget -= 1;
        }
      }
    }
    return sent;
  }

  private async expire(): Promise<number> {
    const expired = await this.d.db.expireDue();
    for (const card of expired) {
      await this.note("card_expired", card.id);
      if (card.telegramMessageId !== null) {
        try {
          await this.d.api.editMessageText(this.d.cfg.approverId, card.telegramMessageId, renderExpired(card.id));
        } catch {
          /* best effort: the card is expired in the database either way */
        }
      }
    }
    return expired.length;
  }

  async handleUpdate(update: TelegramUpdate): Promise<UpdateResult> {
    const cq = update.callback_query;
    if (cq) return this.handleCallback(update.update_id, cq);
    if (update.message) return this.handleMessage(update.message);
    return { kind: "ignored" };
  }

  private async handleCallback(updateId: number, cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<UpdateResult> {
    const { approverId } = this.d.cfg;
    if (cq.from?.id !== approverId || cq.from?.is_bot === true) {
      await this.noteRejected("callback_rejected:not_approver");
      return { kind: "rejected", reason: "not_approver" };
    }
    const chat = cq.message?.chat;
    if (chat?.id !== approverId || chat?.type !== "private" || typeof cq.message?.message_id !== "number") {
      await this.noteRejected("callback_rejected:wrong_chat");
      return { kind: "rejected", reason: "wrong_chat" };
    }
    const parsed = parseCallbackData(cq.data);
    if (!parsed) {
      await this.noteRejected("callback_rejected:bad_data");
      return { kind: "rejected", reason: "bad_data" };
    }
    const card = await this.d.db.getCard(parsed.cardId);
    if (!card) {
      await this.noteRejected("callback_rejected:unknown_card");
      return { kind: "rejected", reason: "unknown_card" };
    }
    if (!verifyCallback(this.d.cfg.hmacKey, parsed, card.nonce)) {
      await this.noteRejected("callback_rejected:bad_hmac", card.id);
      return { kind: "rejected", reason: "bad_hmac" };
    }
    if (card.telegramMessageId !== cq.message.message_id) {
      await this.noteRejected("callback_rejected:wrong_message", card.id);
      return { kind: "rejected", reason: "wrong_message" };
    }
    const action = parsed.action === "a" ? "approve" : "reject";
    const result = await this.d.db.decide({ cardId: card.id, action, approverId, updateId, cardMessageId: cq.message.message_id });
    if (result.outcome !== "recorded") {
      await this.noteRejected(`callback_stale:${result.outcome}`, card.id);
      await this.answer(cq.id, "This card is no longer active.");
      return { kind: "stale", reason: result.outcome };
    }
    await this.answer(cq.id, action === "approve" ? "Approval recorded (no order is placed)." : "Rejection recorded.");
    const row = result.kind === "claim" ? await this.d.db.getClaimForCard(card.id) : null;
    const original = result.kind === "test" ? renderTestCard(this.ctx(card.id)).text : row ? renderClaimCard(row, this.ctx(card.id)).text : renderExpired(card.id);
    try {
      await this.d.api.editMessageText(approverId, cq.message.message_id, renderOutcome(original, action, this.d.now(), result.kind === "test"));
    } catch {
      /* the decision is recorded; the confirmation edit is best effort */
    }
    this.d.log.log("bot.decision", { card: shortCard(card.id), action, kind: result.kind });
    return { kind: "decision", cardId: card.id, cardKind: result.kind, action };
  }

  private async answer(id: string, text: string): Promise<void> {
    try {
      await this.d.api.answerCallbackQuery(id, text);
    } catch {
      /* best effort */
    }
  }

  private async handleMessage(message: NonNullable<TelegramUpdate["message"]>): Promise<UpdateResult> {
    const { approverId } = this.d.cfg;
    if (message.from?.id !== approverId || message.from?.is_bot === true || message.chat?.id !== approverId || message.chat?.type !== "private") {
      await this.noteRejected("message_rejected:not_approver");
      return { kind: "rejected", reason: "not_approver" };
    }
    const command = typeof message.text === "string" ? /^\/(start|status|pause|resume)(?:@[A-Za-z0-9_]{1,40})?\s*$/.exec(message.text)?.[1] : undefined;
    if (!command) return { kind: "ignored" };
    let reply: string;
    if (command === "pause" || command === "resume") {
      await this.d.db.setPaused(command === "pause");
      await this.note(command === "pause" ? "paused" : "resumed", null);
      reply = command === "pause" ? "Paused: no new cards will be sent. /resume to continue." : "Resumed.";
    } else {
      const state = await this.d.db.getState();
      const counts = await this.d.db.countByState();
      reply = `TWINS approval bot: online. It records your decision only and places no order.\nPaused: ${state?.paused ? "yes" : "no"}\nCards - pending: ${counts["pending"] ?? 0}, awaiting you: ${counts["sent"] ?? 0}, decided: ${counts["decided"] ?? 0}, expired: ${counts["expired"] ?? 0}\nCommands: /status /pause /resume`;
    }
    try {
      await this.d.api.sendMessage(approverId, reply);
    } catch {
      /* best effort */
    }
    return { kind: "command", command };
  }

  /** One cycle: expire old cards, send new ones, then wait up to `pollSeconds` for updates. Returns what happened (counts only). */
  async runCycle(pollSeconds: number): Promise<{ sent: number; expired: number; updates: number; decisions: UpdateResult[] }> {
    const state = this.persistOffset ? await this.d.db.getState() : { activatedAt: this.d.now(), paused: true, updateOffset: this.memoryOffset };
    if (!state) throw new FatalBotError("state_missing", EXIT_PRIVILEGES);
    const expired = await this.expire();
    const sent = this.persistOffset ? await this.sendNew(state) : 0;
    const updates = await this.d.api.getUpdates(state.updateOffset, pollSeconds);
    const decisions: UpdateResult[] = [];
    for (const update of updates) {
      decisions.push(await this.handleUpdate(update));
      const next = update.update_id + 1;
      if (this.persistOffset) await this.d.db.setUpdateOffset(next);
      else this.memoryOffset = next;
    }
    return { sent, expired, updates: updates.length, decisions };
  }

  /** The service loop. Telegram rate limits are honoured; transient errors back off; too many in a row is fatal. */
  async run(shouldStop: () => boolean): Promise<void> {
    let errors = 0;
    while (!shouldStop()) {
      try {
        const r = await this.runCycle(Math.min(25, this.d.cfg.pollIntervalSeconds));
        errors = 0;
        if (r.sent > 0 || r.expired > 0) this.d.log.log("bot.cycle", { sent: r.sent, expired: r.expired });
        if (r.updates === 0) await this.d.sleep(500); // long polling already waited; this only guards against a tight loop
      } catch (error) {
        if (error instanceof FatalBotError) throw error;
        errors += 1;
        if (error instanceof TelegramApiError) {
          if (error.code === 401) throw new FatalBotError("telegram_unauthorized", EXIT_TELEGRAM);
          this.d.log.log("bot.telegram_error", { code: error.code }, "warn");
          await this.d.sleep(error.code === 429 ? Math.min(error.retryAfter ?? 30, 300) * 1000 : Math.min(2 ** errors * 1000, 120_000));
        } else {
          this.d.log.log("bot.error", { reason: "cycle_failed", count: errors }, "warn");
          await this.d.sleep(Math.min(2 ** errors * 1000, 120_000));
        }
        if (errors >= MAX_CONSECUTIVE_ERRORS) throw new FatalBotError("too_many_errors", EXIT_TOO_MANY_ERRORS);
      }
    }
  }

  /** Handshake: sends ONE clearly labelled TEST card (no claim, no channel message) and waits for the approver to tap it. */
  async handshake(timeoutSeconds: number, shouldStop: () => boolean): Promise<UpdateResult | { kind: "timeout" }> {
    this.persistOffset = false;
    const card = await this.d.db.createCard({ id: randomUUID(), kind: "test", claimId: null, nonce: randomBytes(16).toString("hex"), ttlSeconds: timeoutSeconds });
    if (!card) throw new FatalBotError("test_card_not_created", EXIT_PRIVILEGES);
    const rendered = renderTestCard({ ...this.ctx(card.id), ttlSeconds: timeoutSeconds });
    const messageId = await this.d.api.sendMessage(this.d.cfg.approverId, rendered.text, this.buttons(card, true));
    await this.d.db.markSent(card.id, messageId, rendered.sha256);
    await this.note("handshake_card_sent", card.id);
    const deadline = this.d.now().getTime() + timeoutSeconds * 1000;
    while (!shouldStop() && this.d.now().getTime() < deadline) {
      const r = await this.runCycle(10);
      const hit = r.decisions.find((x) => x.kind === "decision" && x.cardId === card.id);
      if (hit) return hit;
    }
    await this.expire();
    return { kind: "timeout" };
  }
}
