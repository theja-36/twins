import { randomUUID } from "node:crypto";
import type { BotConfig } from "../../services/approval-bot/src/config";
import { loadBotConfig } from "../../services/approval-bot/src/config";
import type { ClaimRow } from "../../services/approval-bot/src/card";
import type { BotDb, BotState, CardRow, DecideInput, DecideResult } from "../../services/approval-bot/src/db";
import { TelegramApiError, type BotApiPort, type InlineButton, type TelegramUpdate } from "../../services/approval-bot/src/telegramApi";

export const APPROVER = 123456789; // synthetic
export const STRANGER = 987654321; // synthetic
export const CHANNEL = "tg_chat_-1001000000001"; // synthetic
export const OTHER_CHANNEL = "tg_chat_-1002000000002"; // synthetic
export const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmnopqrstu"; // synthetic, fails nothing real
export const HMAC_KEY = "ab".repeat(32);

export function testEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    TWINS_BOT_TOKEN: TOKEN,
    TWINS_BOT_APPROVER_ID: String(APPROVER),
    TWINS_BOT_DATABASE_URL: "postgresql://twins_bot:pw@twins-staging-postgres-1:5432/twins",
    TWINS_BOT_HMAC_KEY: HMAC_KEY,
    TWINS_BOT_SOURCE_CHANNELS: CHANNEL,
    TWINS_BOT_ACTIVE: "true",
    ...over,
  };
}

export const testConfig = (over: Record<string, string> = {}): BotConfig => loadBotConfig(testEnv(over));

export class TestClock {
  constructor(public ms = Date.parse("2026-10-26T04:00:00Z")) {}
  now = (): Date => new Date(this.ms);
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export function claimJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entry: { type: "above", price: 120 }, action: "buy", expiry: { day: 29, raw: "29 OCT 2026", year: 2026, month: 10, status: "full" },
    intent: "long_entry_presumed", strike: 24500, targets: [150], stopLoss: 90, levelBasis: "premium", optionType: "CE", underlying: "NIFTY",
    levelBasisConflict: false, optionTypeConflict: false, underlyingAliasUsed: false, impliedUnderlyingView: "bullish", compactCodeUnrecognized: false, ...over,
  };
}

export const REASONS = [
  { code: "contract.master_unconfigured", severity: "insufficient", description: "no verified instrument master is configured; the contract cannot be verified" },
  { code: "option_premium_data.unavailable", severity: "insufficient", description: "no verified live option premium data is available; the claim cannot be corroborated" },
];

export interface StoredClaim extends ClaimRow {
  channel: string;
  resultKind: string;
}

export function makeClaim(clock: TestClock, over: Partial<StoredClaim> = {}): StoredClaim {
  return {
    claimId: randomUUID(), createdAt: clock.now(), parserVersion: "telegram-regex-v2", claim: claimJson(), reasons: REASONS, assessmentOutcome: "INSUFFICIENT_EVIDENCE",
    externalMessageId: "28956", messageTimestamp: new Date(clock.ms - 3600_000), channel: CHANNEL, resultKind: "claim", ...over,
  };
}

/** In-memory BotDb with the SAME semantics as PgBotDb's SQL (single-use decide, expiry, one card per claim, append-only audit). */
export class MemoryBotDb implements BotDb {
  claims: StoredClaim[] = [];
  cards = new Map<string, CardRow & { createdAt: Date; sentAt: Date | null; claimId: string | null }>();
  reviews: Array<{ cardId: string; claimId: string; decision: string; approver: number; messageId: number; updateId: number; evidence: Record<string, unknown> }> = [];
  events: Array<{ type: string; cardId: string | null; detail: Record<string, unknown> }> = [];
  state: BotState | null = null;
  privilegeProblems: string[] = [];
  closed = false;
  failNext: Error | null = null;
  constructor(private readonly clock: TestClock) {}

  private maybeFail(): void {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  async checkPrivileges(): Promise<string[]> {
    this.maybeFail();
    return [...this.privilegeProblems];
  }
  async getState(): Promise<BotState | null> {
    return this.state ? { ...this.state } : null;
  }
  async ensureState(at: Date): Promise<void> {
    this.state ??= { activatedAt: at, paused: false, updateOffset: 0 };
  }
  async setUpdateOffset(n: number): Promise<void> {
    if (this.state) this.state.updateOffset = n;
  }
  async setPaused(p: boolean): Promise<void> {
    if (this.state) this.state.paused = p;
  }
  private toClaimRow(c: StoredClaim): ClaimRow {
    const { channel: _c, resultKind: _r, ...row } = c;
    void _c;
    void _r;
    return row;
  }
  async selectNewClaims(since: Date, channels: readonly string[], limit: number): Promise<ClaimRow[]> {
    this.maybeFail();
    const hasCard = new Set([...this.cards.values()].map((c) => c.claimId));
    return this.claims
      .filter((c) => c.resultKind === "claim" && c.createdAt > since && channels.includes(c.channel) && !hasCard.has(c.claimId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((c) => this.toClaimRow(c));
  }
  async getClaimForCard(cardId: string): Promise<ClaimRow | null> {
    const card = this.cards.get(cardId);
    const claim = card && this.claims.find((c) => c.claimId === card.claimId);
    return claim ? this.toClaimRow(claim) : null;
  }
  async listPendingCards(limit: number): Promise<CardRow[]> {
    return [...this.cards.values()].filter((c) => c.state === "pending" && c.kind === "claim" && c.expiresAt > this.clock.now()).slice(0, limit);
  }
  async createCard(i: { id: string; kind: "claim" | "test"; claimId: string | null; nonce: string; ttlSeconds: number }): Promise<CardRow | null> {
    if (i.claimId !== null && [...this.cards.values()].some((c) => c.claimId === i.claimId)) return null; // unique claim_id
    const card = { id: i.id, kind: i.kind, claimId: i.claimId, state: "pending" as const, nonce: i.nonce, telegramMessageId: null, cardTextSha256: null, expiresAt: new Date(this.clock.ms + i.ttlSeconds * 1000), createdAt: this.clock.now(), sentAt: null };
    this.cards.set(i.id, card);
    return card;
  }
  async markSent(id: string, messageId: number, sha: string): Promise<boolean> {
    const c = this.cards.get(id);
    if (!c || c.state !== "pending") return false;
    Object.assign(c, { state: "sent", telegramMessageId: messageId, cardTextSha256: sha, sentAt: this.clock.now() });
    return true;
  }
  async getCard(id: string): Promise<CardRow | null> {
    return this.cards.get(id) ?? null;
  }
  async decide(i: DecideInput): Promise<DecideResult> {
    this.maybeFail();
    const c = this.cards.get(i.cardId);
    if (!c) return { outcome: "unknown" };
    if (c.state === "sent" && c.expiresAt > this.clock.now() && c.telegramMessageId === i.cardMessageId) {
      c.state = "decided";
      if (c.kind === "claim") {
        const claim = this.claims.find((x) => x.claimId === c.claimId)!;
        this.reviews.push({ cardId: c.id, claimId: claim.claimId, decision: i.action, approver: i.approverId, messageId: i.cardMessageId, updateId: i.updateId, evidence: { claim_id: claim.claimId, parser_version: claim.parserVersion, card_text_sha256: c.cardTextSha256 } });
      }
      this.events.push({ type: c.kind === "claim" ? "decision" : "test_decision", cardId: c.id, detail: { action: i.action, update_id: i.updateId } });
      return { outcome: "recorded", kind: c.kind };
    }
    return c.expiresAt <= this.clock.now() && (c.state === "sent" || c.state === "pending") ? { outcome: "expired" } : { outcome: "not_pending" };
  }
  async expireDue(): Promise<CardRow[]> {
    const out: CardRow[] = [];
    for (const c of this.cards.values()) if ((c.state === "sent" || c.state === "pending") && c.expiresAt <= this.clock.now()) { c.state = "expired"; out.push({ ...c }); }
    return out;
  }
  async countSentSince(since: Date): Promise<number> {
    return [...this.cards.values()].filter((c) => c.kind === "claim" && c.sentAt !== null && c.sentAt > since).length;
  }
  async countByState(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of this.cards.values()) if (c.kind === "claim") out[c.state] = (out[c.state] ?? 0) + 1;
    return out;
  }
  async recordEvent(type: string, cardId: string | null, detail: Record<string, string | number | boolean>): Promise<void> {
    this.events.push({ type, cardId, detail });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }
}

export interface SentMessage {
  chatId: number;
  text: string;
  buttons: InlineButton[] | undefined;
  messageId: number;
}

export class FakeBotApi implements BotApiPort {
  inbox: TelegramUpdate[] = [];
  sent: SentMessage[] = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  answers: Array<{ id: string; text: string | undefined }> = [];
  offsets: number[] = [];
  nextMessageId = 1000;
  sendError: Error | null = null;
  meError: Error | null = null;
  getUpdatesError: Error | null = null;
  onPoll: ((timeoutSeconds: number) => void) | null = null;
  async getMe(): Promise<{ id: number; username: string }> {
    if (this.meError) throw this.meError;
    return { id: 555, username: "twins_test_bot" };
  }
  async getUpdates(offset: number, timeoutSeconds = 0): Promise<TelegramUpdate[]> {
    this.onPoll?.(timeoutSeconds);
    if (this.getUpdatesError) {
      const e = this.getUpdatesError;
      this.getUpdatesError = null;
      throw e;
    }
    this.offsets.push(offset);
    const out = this.inbox.filter((u) => u.update_id >= offset);
    this.inbox = this.inbox.filter((u) => u.update_id >= offset && !out.includes(u));
    return out;
  }
  async sendMessage(chatId: number, text: string, buttons?: InlineButton[]): Promise<number> {
    if (this.sendError) throw this.sendError;
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, text, buttons, messageId });
    return messageId;
  }
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
  }
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }
  /** A callback_query update as Telegram would deliver it for a tap on `data` in message `messageId`. */
  tap(updateId: number, data: string, over: { from?: number; chat?: number; chatType?: string; messageId?: number; fromIsBot?: boolean } = {}): TelegramUpdate {
    return {
      update_id: updateId,
      callback_query: {
        id: `cq-${updateId}`,
        from: { id: over.from ?? APPROVER, is_bot: over.fromIsBot ?? false },
        message: { message_id: over.messageId ?? this.sent[this.sent.length - 1]!.messageId, chat: { id: over.chat ?? APPROVER, type: over.chatType ?? "private" } },
        data,
      },
    };
  }
  text(updateId: number, text: string, over: { from?: number; chat?: number; chatType?: string } = {}): TelegramUpdate {
    return { update_id: updateId, message: { message_id: updateId, from: { id: over.from ?? APPROVER, is_bot: false }, chat: { id: over.chat ?? APPROVER, type: over.chatType ?? "private" }, text } };
  }
}

export { TelegramApiError };
export const silentLogger = () => {
  const lines: string[] = [];
  return { lines, write: (l: string) => void lines.push(l) };
};
