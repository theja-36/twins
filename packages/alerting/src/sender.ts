import { createHmac } from "node:crypto";
import type { AlertPayload } from "./payload";

export interface AlertSender {
  /** Delivers one alert. Resolves true on delivery, false on failure. Never throws and never exposes the destination. */
  send(payload: AlertPayload): Promise<boolean>;
  readonly label: string;
}

export interface WebhookConfig {
  url: string;
  /** Optional shared secret: the body is signed (HMAC-SHA256, hex) in the `x-twins-signature: sha256=...` header. */
  secret?: string | undefined;
  timeoutMs?: number;
  attempts?: number;
  /** Test-only: allow plain http to a non-loopback host (an isolated test sink on a private network). */
  allowInsecureTestDestination?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class AlertConfigError extends Error {}

/** A webhook URL is a credential (they usually embed a token): it is validated, never logged, and only its host is ever exposed as a label. */
export function validateWebhookUrl(raw: string, allowInsecureTest = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AlertConfigError("TWINS_ALERT_WEBHOOK_URL is not a valid URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (loopback || allowInsecureTest))) throw new AlertConfigError("TWINS_ALERT_WEBHOOK_URL must be https (http only for loopback)");
  return u;
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function createWebhookSender(config: WebhookConfig): AlertSender {
  const url = validateWebhookUrl(config.url, config.allowInsecureTestDestination === true);
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, config.attempts ?? 2);
  const timeoutMs = config.timeoutMs ?? 5000;
  return {
    label: `webhook:${url.host}`,
    async send(payload) {
      const body = JSON.stringify(payload);
      for (let i = 1; i <= attempts; i++) {
        try {
          const res = await doFetch(url.toString(), {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "content-type": "application/json", "user-agent": "twins-alert/1", ...(config.secret ? { "x-twins-signature": signBody(body, config.secret) } : {}) },
            body,
          });
          if (res.status >= 200 && res.status < 300) return true;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) return false; // a client error will not fix itself
        } catch {
          /* network error / timeout: retry */
        }
        if (i < attempts) await sleep(500 * i);
      }
      return false;
    },
  };
}
