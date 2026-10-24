/**
 * Minimal Telegram Bot API client. Only the five methods the bot needs (an allowlist, like the capture client's request allowlist). The token
 * is part of every URL, so nothing here ever puts a URL, a request or a response body into an error or a log: errors carry the method, a numeric
 * code and (for rate limits) retry_after only. Redirects are refused. Every call has a timeout.
 */
export const ALLOWED_METHODS = ["getMe", "getUpdates", "sendMessage", "editMessageText", "answerCallbackQuery"] as const;
export type BotMethod = (typeof ALLOWED_METHODS)[number];

export class TelegramApiError extends Error {
  constructor(readonly method: string, readonly code: number, readonly retryAfter?: number) {
    super(`telegram ${method} failed (${code})`);
    this.name = "TelegramApiError";
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from?: { id?: number; is_bot?: boolean };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
    data?: string;
  };
  message?: { message_id?: number; from?: { id?: number; is_bot?: boolean }; chat?: { id?: number; type?: string }; text?: string };
}

/** What the bot logic needs from Telegram (a port, so tests can drive it with a fake). */
export interface BotApiPort {
  getMe(): Promise<{ id: number; username: string }>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, buttons?: InlineButton[]): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export class BotApi implements BotApiPort {
  constructor(
    private readonly token: string,
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  private async call<T>(method: BotMethod, params: Record<string, unknown>, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (!ALLOWED_METHODS.includes(method)) throw new TelegramApiError(String(method), 0);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramApiError(method, 0); // network error, timeout or refused redirect: no cause is kept (it could contain the URL)
    }
    let body: { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramApiError(method, response.status);
    }
    if (body.ok !== true) {
      const retry = body.parameters?.retry_after;
      throw new TelegramApiError(method, typeof body.error_code === "number" ? body.error_code : response.status, typeof retry === "number" ? retry : undefined);
    }
    return body.result as T;
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const me = await this.call<{ id: number; username?: string; is_bot?: boolean }>("getMe", {});
    if (typeof me.id !== "number" || me.is_bot !== true) throw new TelegramApiError("getMe", 0);
    return { id: me.id, username: typeof me.username === "string" ? me.username : "" };
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["callback_query", "message"] },
      (timeoutSeconds + 15) * 1000,
    );
    return Array.isArray(result) ? result : [];
  }

  async sendMessage(chatId: number, text: string, buttons?: InlineButton[]): Promise<number> {
    const result = await this.call<{ message_id?: number }>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
    });
    if (typeof result.message_id !== "number") throw new TelegramApiError("sendMessage", 0);
    return result.message_id;
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    // Omitting reply_markup removes the inline buttons.
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text, show_alert: false } : {}) });
  }
}
