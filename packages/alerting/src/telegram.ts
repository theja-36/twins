import type { AlertPayload } from "./payload";
import type { AlertSender } from "./sender";

/**
 * Telegram alert destination (Stage 2 / Task 5 follow-up). Posts a short PLAIN-TEXT message (no parse_mode, so nothing in an alert can be interpreted as
 * markup) to ONE chat with the existing approval-bot token. Only the already-sanitised alert payload is formatted: fixed fields, allow-listed details.
 * The bot token and chat id are credentials: they are validated here, never logged, never part of an error, and the sender label is a constant.
 */
export class TelegramConfigError extends Error {}

const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
const CHAT_ID = /^-?\d{5,20}$/;
const ICON: Record<string, string> = { CRITICAL: "\u{1F6A8}", WARNING: "⚠️", INFO: "ℹ️" };

export interface TelegramConfig {
  token: string;
  chatId: string;
  /** Test seam: the API base (default https://api.telegram.org). Anything else must be https or loopback http. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per alert for transient failures (network, 429, 5xx). Default 4. */
  attempts?: number;
  timeoutMs?: number;
  /** Upper bound for a single backoff wait (default 30 s). */
  maxBackoffMs?: number;
  random?: () => number;
}

/** Concise Telegram text: severity line, then environment/service/build, time, code, summary, optional compact details. At most ~600 characters. */
export function formatTelegramText(p: AlertPayload): string {
  const details = Object.entries(p.details).slice(0, 6).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  const lines = [
    `${ICON[p.severity] ?? ""} ${p.severity} ${p.event}`,
    `env: ${p.environment} | service: ${p.service} | build: ${p.build}`,
    `time: ${p.timestamp}`,
    `code: ${p.code}`,
    p.summary,
    ...(p.correlationId ? [`correlation: ${p.correlationId}`] : []),
    ...(details ? [`details: ${details}`] : []),
  ];
  return lines.join("\n").slice(0, 1000);
}

export function validateTelegramConfig(token: string, chatId: string, apiBase = "https://api.telegram.org"): void {
  if (!TOKEN.test(token)) throw new TelegramConfigError("TWINS_ALERT_TELEGRAM_BOT_TOKEN is not a Telegram bot token");
  if (!CHAT_ID.test(chatId)) throw new TelegramConfigError("TWINS_ALERT_TELEGRAM_CHAT_ID must be a numeric chat id");
  let u: URL;
  try { u = new URL(apiBase); } catch { throw new TelegramConfigError("Telegram API base is not a URL"); }
  if (u.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(u.hostname)) throw new TelegramConfigError("Telegram API base must be https (http only for loopback)");
}

export function createTelegramSender(config: TelegramConfig): AlertSender {
  const base = (config.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
  validateTelegramConfig(config.token, config.chatId, base);
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, config.attempts ?? 4);
  const random = config.random ?? Math.random;
  const cap = config.maxBackoffMs ?? 30_000;
  const url = `${base}/bot${config.token}/sendMessage`;
  return {
    label: "telegram", // constant: never the chat id or token
    async send(payload) {
      const body = JSON.stringify({ chat_id: Number(config.chatId), text: formatTelegramText(payload), disable_web_page_preview: true, disable_notification: payload.severity === "INFO" });
      for (let i = 1; i <= attempts; i++) {
        let waitMs = Math.min(cap, 500 * 2 ** (i - 1)) * (0.5 + random() / 2); // exponential backoff with jitter
        try {
          const res = await doFetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs ?? 8000), headers: { "content-type": "application/json" }, body });
          if (res.status === 200) return true;
          if (res.status === 429) {
            const retryAfter = Number(((await res.json().catch(() => ({}))) as { parameters?: { retry_after?: unknown } }).parameters?.retry_after);
            if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(cap, retryAfter * 1000);
          } else if (res.status >= 400 && res.status < 500) {
            return false; // wrong chat / bot blocked / bad token: retrying cannot help
          }
        } catch {
          /* network error or timeout: transient */
        }
        if (i < attempts) await sleep(waitMs);
      }
      return false;
    },
  };
}

/** Delivers to every sender; true if at least one delivered. A failing destination never hides the others. */
export function createFanoutSender(senders: AlertSender[]): AlertSender & { results(): Array<{ destination: string; ok: boolean }> } {
  let last: Array<{ destination: string; ok: boolean }> = [];
  return {
    label: senders.map((s) => s.label).join("+"),
    async send(payload) {
      last = await Promise.all(senders.map(async (s) => ({ destination: s.label, ok: await s.send(payload).catch(() => false) })));
      return last.some((r) => r.ok);
    },
    results: () => last,
  };
}
