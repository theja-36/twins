/**
 * Alert relay process (compose service `alert-relay`). The ONLY process holding alert credentials: the webhook (TWINS_ALERT_WEBHOOK_URL / _SECRET) and/or the
 * Telegram destination (TWINS_ALERT_TELEGRAM_BOT_TOKEN, the existing approval-bot token, plus TWINS_ALERT_TELEGRAM_CHAT_ID, the numeric id of the operational
 * alert chat). Accepts alerts only from the internal network with TWINS_ALERT_RELAY_TOKEN. With no destination it still runs and logs every alert as
 * undelivered; undelivered CRITICAL alerts are retried, logged at error level and counted in the status file (never silently dropped).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRelayServer, createTelegramSender, createWebhookSender, TelegramConfigError, type AlertSender, type RelayStatus } from "../../packages/alerting/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

enforceLiveTradingGuard("alert-relay");
const log = (event: string, fields: Record<string, unknown> = {}): void => console.log(JSON.stringify({ ts: new Date().toISOString(), level: /undelivered|dropped|failed|rejected|config_error/.test(event) ? (/critical/.test(event) ? "error" : "warn") : "info", event, service: "alert-relay", ...fields }));
const env = process.env;
const token = env["TWINS_ALERT_RELAY_TOKEN"] ?? "";
if (token.length < 24) { log("relay.config_error", { reason: "TWINS_ALERT_RELAY_TOKEN missing or shorter than 24 characters" }); process.exit(2); }

const destinations: AlertSender[] = [];
try {
  if (env["TWINS_ALERT_WEBHOOK_URL"]) destinations.push(createWebhookSender({ url: env["TWINS_ALERT_WEBHOOK_URL"], secret: env["TWINS_ALERT_WEBHOOK_SECRET"], allowInsecureTestDestination: env["TWINS_ALERT_ALLOW_INSECURE_TEST"] === "1" }));
  const tgToken = env["TWINS_ALERT_TELEGRAM_BOT_TOKEN"];
  const tgChat = env["TWINS_ALERT_TELEGRAM_CHAT_ID"];
  if (tgToken || tgChat) {
    if (!tgToken || !tgChat) throw new TelegramConfigError("both TWINS_ALERT_TELEGRAM_BOT_TOKEN and TWINS_ALERT_TELEGRAM_CHAT_ID are required for the Telegram destination");
    destinations.push(createTelegramSender({ token: tgToken, chatId: tgChat }));
  }
} catch (error) {
  log("relay.config_error", { reason: error instanceof TelegramConfigError ? error.message : "invalid alert destination configuration" }); // messages name the variable, never its value
  process.exit(2);
}

const statusFile = env["TWINS_ALERT_RELAY_STATUS_FILE"] ?? "/status/alert-relay.json";
const persist = (s: RelayStatus): void => {
  try {
    mkdirSync(dirname(statusFile), { recursive: true });
    const tmp = `${statusFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ok: s.pendingCritical === 0 && s.droppedCritical === 0, ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000), ...s })}\n`, { mode: 0o600 });
    renameSync(tmp, statusFile);
  } catch { /* a missing status mount must not stop alert delivery */ }
};
const server = createRelayServer({ token, destinations, log, onStatus: persist });
if (destinations.length === 0) log("relay.no_destination", { note: "alerts are logged as undelivered until a destination is configured" });
server.listen(8099, "0.0.0.0", () => log("relay.listening", { destinations: destinations.map((d) => d.label) }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
