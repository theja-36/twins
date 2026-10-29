/**
 * Alert relay process (compose service `alert-relay`). Holds TWINS_ALERT_WEBHOOK_URL / _SECRET; accepts alerts only from the internal network with
 * TWINS_ALERT_RELAY_TOKEN. Without a webhook it still runs and logs every alert as `relay.undelivered` so a missing destination is visible.
 */
import { createRelayServer, createWebhookSender, type AlertSender } from "../../packages/alerting/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

enforceLiveTradingGuard("alert-relay");
const log = (event: string, fields: Record<string, unknown> = {}): void => console.log(JSON.stringify({ ts: new Date().toISOString(), level: event.includes("failed") || event.includes("rejected") ? "warn" : "info", event, service: "alert-relay", ...fields }));
const token = process.env["TWINS_ALERT_RELAY_TOKEN"] ?? "";
if (token.length < 24) { log("relay.config_error", { reason: "TWINS_ALERT_RELAY_TOKEN missing or shorter than 24 characters" }); process.exit(2); }
const url = process.env["TWINS_ALERT_WEBHOOK_URL"];
let sender: AlertSender;
if (url) {
  try {
    sender = createWebhookSender({ url, secret: process.env["TWINS_ALERT_WEBHOOK_SECRET"], allowInsecureTestDestination: process.env["TWINS_ALERT_ALLOW_INSECURE_TEST"] === "1" });
  } catch { log("relay.config_error", { reason: "TWINS_ALERT_WEBHOOK_URL is invalid" }); process.exit(2); }
} else {
  sender = { label: "none", send: async (p) => { log("relay.undelivered", { alertEvent: p.event, severity: p.severity, reason: "no_destination_configured" }); return false; } };
}
const server = createRelayServer({ token, sender, log });
server.listen(8099, "0.0.0.0", () => log("relay.listening", { destination: sender.label }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
