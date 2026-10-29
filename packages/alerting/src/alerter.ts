import type { StructuredLogger } from "@twins/shared";
import { buildAlert, severityRank, type AlertContext, type AlertInput, type AlertPayload, type Severity } from "./payload";
import { createRelaySender } from "./relay";
import { AlertConfigError, createWebhookSender, type AlertSender } from "./sender";

export interface AlerterOptions {
  context: AlertContext;
  /** No sender = alerts are logged as undelivered (`alert.undelivered`) so a missing destination is visible, never silent. */
  sender?: AlertSender | undefined;
  logger?: StructuredLogger | undefined;
  /** Alerts below this severity are logged but not delivered (default WARNING). */
  minSeverity?: Severity;
  /** Identical alerts (same event + key) inside this window are suppressed and counted (default 10 min; CRITICAL kill-switch style events pass their own key). */
  throttleMs?: number;
  now?: () => Date;
}

export interface Alerter {
  /** Fire-and-forget: never throws, never blocks the caller. Use flush() before a short-lived process exits. */
  alert(input: AlertInput & { dedupeKey?: string }): void;
  flush(): Promise<void>;
  readonly configured: boolean;
}

export function createAlerter(options: AlerterOptions): Alerter {
  const now = options.now ?? (() => new Date());
  const min = options.minSeverity ?? "WARNING";
  const throttleMs = options.throttleMs ?? 10 * 60_000;
  const last = new Map<string, { at: number; suppressed: number }>();
  const pending = new Set<Promise<void>>();
  const log = options.logger;
  return {
    configured: options.sender !== undefined,
    alert(input) {
      let payload: AlertPayload;
      try {
        payload = buildAlert(input, options.context, now());
      } catch {
        log?.error("alert.invalid", { alertEvent: String(input.event).slice(0, 60) });
        return;
      }
      const key = `${payload.event}|${input.dedupeKey ?? ""}`;
      const t = now().getTime();
      const prev = last.get(key);
      if (prev && t - prev.at < throttleMs && payload.event !== "alert.test") {
        prev.suppressed += 1;
        return;
      }
      const suppressed = prev?.suppressed ?? 0;
      last.set(key, { at: t, suppressed: 0 });
      if (suppressed > 0) payload.details["suppressedSinceLast"] = suppressed;
      if (severityRank(payload.severity) < severityRank(min) && payload.event !== "alert.test") {
        log?.info("alert.below_threshold", { alertEvent: payload.event, severity: payload.severity });
        return;
      }
      if (!options.sender) {
        log?.warn("alert.undelivered", { alertEvent: payload.event, severity: payload.severity, reason: "no_destination_configured" });
        return;
      }
      const sender = options.sender;
      const task = sender.send(payload).then(
        (ok) => { if (ok) log?.info("alert.sent", { alertEvent: payload.event, severity: payload.severity, destination: sender.label }); else log?.warn("alert.delivery_failed", { alertEvent: payload.event, severity: payload.severity, destination: sender.label }); },
        () => { log?.warn("alert.delivery_failed", { alertEvent: payload.event, severity: payload.severity, destination: sender.label }); },
      ).finally(() => { pending.delete(task); });
      pending.add(task);
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}

/** Builds an alerter from the environment: TWINS_ALERT_WEBHOOK_URL (+ _SECRET), TWINS_ENV_NAME, TWINS_IMAGE_TAG, TWINS_ALERT_MIN_SEVERITY. An invalid URL throws AlertConfigError. */
export function alerterFromEnv(env: Record<string, string | undefined>, service: string, logger?: StructuredLogger): Alerter {
  const url = env["TWINS_ALERT_WEBHOOK_URL"];
  const relayUrl = env["TWINS_ALERT_RELAY_URL"];
  const relayToken = env["TWINS_ALERT_RELAY_TOKEN"];
  if (relayUrl && relayToken && (relayToken.length < 24 || !/^http:\/\/[a-z0-9.-]+(:\d+)?\/v1\/alert$/i.test(relayUrl))) throw new AlertConfigError("TWINS_ALERT_RELAY_URL needs an http://<service>/v1/alert URL and a TWINS_ALERT_RELAY_TOKEN of at least 24 characters");
  const min = (env["TWINS_ALERT_MIN_SEVERITY"] ?? "WARNING").toUpperCase();
  if (!["INFO", "WARNING", "CRITICAL"].includes(min)) throw new AlertConfigError("TWINS_ALERT_MIN_SEVERITY must be INFO, WARNING or CRITICAL");
  return createAlerter({
    context: { environment: env["TWINS_ENV_NAME"] ?? env["APP_ENV"] ?? "unknown", service, build: env["TWINS_BUILD"] ?? env["TWINS_IMAGE_TAG"] },
    // Containers on the internal network use the relay (it alone holds the webhook credential); a process with direct egress uses the webhook itself.
    ...(relayUrl && relayToken ? { sender: createRelaySender({ url: relayUrl, token: relayToken }) } : url ? { sender: createWebhookSender({ url, secret: env["TWINS_ALERT_WEBHOOK_SECRET"], allowInsecureTestDestination: env["TWINS_ALERT_ALLOW_INSECURE_TEST"] === "1" }) } : {}),
    logger,
    minSeverity: min as Severity,
  });
}
