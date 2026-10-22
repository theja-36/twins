/**
 * Telegram intake policy: WHICH chats may be ingested, and whether only options messages may proceed.
 *
 * Fail-closed by design:
 *  - TWINS_TELEGRAM_ALLOWED_CHAT_IDS missing, empty or whitespace-only approves NO chat.
 *  - A malformed value throws at startup. It is never partially applied, ignored or widened (no wildcards, no names,
 *    no ranges, no empty entries); error messages name the problem and the entry position, never the entry itself.
 *  - TWINS_TELEGRAM_OPTIONS_ONLY accepts exactly "true" or "false" (unset/empty = false); anything else throws, so a
 *    typo can never silently turn the safety mode off.
 *
 * The same policy object is enforced by the API (before enqueue) and by the worker (before ingestion, source creation
 * or any downstream work), so a job queued earlier or by another producer is still checked.
 */
export class TelegramPolicyConfigError extends Error {
  constructor(message: string) {
    super(`invalid Telegram intake configuration: ${message}`);
    this.name = "TelegramPolicyConfigError";
  }
}

export const MAX_ALLOWED_CHAT_IDS = 50;
/** Canonical decimal integer: optional minus, no leading zero, not zero, no plus sign, no whitespace inside. */
const CANONICAL_CHAT_ID = /^-?[1-9][0-9]{0,15}$/;

/** Parses the allowlist. Returns a (possibly empty) set of canonical chat-id strings, or throws. */
export function parseAllowedChatIds(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const parts = raw.split(",");
  if (parts.length > MAX_ALLOWED_CHAT_IDS) throw new TelegramPolicyConfigError(`more than ${MAX_ALLOWED_CHAT_IDS} entries`);
  const out = new Set<string>();
  parts.forEach((part, i) => {
    const entry = part.trim();
    if (entry === "") throw new TelegramPolicyConfigError(`entry ${i + 1} is empty`);
    if (!CANONICAL_CHAT_ID.test(entry) || !Number.isSafeInteger(Number(entry))) {
      throw new TelegramPolicyConfigError(`entry ${i + 1} is not a canonical integer chat id (digits only, optional leading '-', no wildcard, name or range)`);
    }
    out.add(entry);
  });
  return out;
}

/** Strict boolean: "true" -> true, "false" or unset/empty -> false, anything else throws. */
export function parseOptionsOnly(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new TelegramPolicyConfigError('TWINS_TELEGRAM_OPTIONS_ONLY must be exactly "true" or "false"');
}

export interface TelegramIntakePolicy {
  /** True only for a chat id that is explicitly on the allowlist. Anything else (null, undefined, malformed) is false. */
  isChatApproved(chatId: string | number | null | undefined): boolean;
  /** Number of approved chats (a count only; ids are not exposed). */
  readonly approvedChatCount: number;
  /** When true the worker lets only options messages proceed; everything else is blocked before any downstream work. */
  readonly optionsOnly: boolean;
}

export function createTelegramIntakePolicy(input: { allowedChatIds?: string | undefined; optionsOnly?: string | undefined } = {}): TelegramIntakePolicy {
  const approved = parseAllowedChatIds(input.allowedChatIds);
  const optionsOnly = parseOptionsOnly(input.optionsOnly);
  return {
    approvedChatCount: approved.size,
    optionsOnly,
    isChatApproved(chatId) {
      let key: string;
      if (typeof chatId === "number") {
        if (!Number.isSafeInteger(chatId)) return false;
        key = String(chatId);
      } else if (typeof chatId === "string") {
        key = chatId;
      } else {
        return false;
      }
      return CANONICAL_CHAT_ID.test(key) && approved.has(key);
    },
  };
}

/** Reads the policy from the environment. Throws TelegramPolicyConfigError for malformed values. */
export function loadTelegramIntakePolicy(env: Record<string, string | undefined> = process.env): TelegramIntakePolicy {
  return createTelegramIntakePolicy({
    allowedChatIds: env["TWINS_TELEGRAM_ALLOWED_CHAT_IDS"],
    optionsOnly: env["TWINS_TELEGRAM_OPTIONS_ONLY"],
  });
}

/**
 * Chat id of a queued job, derived without trusting a single field. `chatId` (set for current producers) is used when
 * present; otherwise the identifier must encode it as `tg_chat_<id>`. When both exist they must agree. Returns null when
 * no usable id can be derived (such a job is never approved).
 */
export function chatIdOfQueuedMessage(message: { chatId?: string | undefined | null; channelIdentifier?: string | undefined }): string | null {
  const fromIdentifier = typeof message.channelIdentifier === "string" ? /^tg_chat_(-?[1-9][0-9]{0,15})$/.exec(message.channelIdentifier)?.[1] ?? null : null;
  const fromField = typeof message.chatId === "string" && CANONICAL_CHAT_ID.test(message.chatId) ? message.chatId : null;
  if (message.chatId !== undefined && message.chatId !== null && fromField === null) return null; // present but unusable
  if (fromField !== null && fromIdentifier !== null && fromField !== fromIdentifier) return null; // contradictory
  return fromField ?? fromIdentifier;
}
