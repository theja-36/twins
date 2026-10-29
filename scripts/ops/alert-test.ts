/**
 * Sends ONE clearly marked test alert through the configured destination (TWINS_ALERT_WEBHOOK_URL) and reports delivery.
 *   alert-test [--severity INFO|WARNING|CRITICAL]
 * The payload is the normal contract with event `alert.test`, code `test_event` and the summary "TEST ALERT - no action required". Exit 0 if delivered,
 * 1 if not, 2 if no destination is configured / the configuration is invalid. The destination is never printed.
 */
import { pathToFileURL } from "node:url";
import { alerterFromEnv, createAlerter, createWebhookSender, SEVERITIES, type Severity } from "../../packages/alerting/src/index";

export async function main(argv: string[], env: Record<string, string | undefined>, out: (l: string) => void): Promise<number> {
  const i = argv.indexOf("--severity");
  const severity = (i >= 0 ? argv[i + 1] : "INFO") as Severity;
  if (!SEVERITIES.includes(severity)) { out("usage: alert-test [--severity INFO|WARNING|CRITICAL]"); return 2; }
  if (!env["TWINS_ALERT_WEBHOOK_URL"]) { out(JSON.stringify({ ok: false, reason: "no_destination_configured" })); return 2; }
  let delivered: boolean | undefined;
  try {
    const probe = alerterFromEnv(env, "alert-test");
    void probe; // validates the whole configuration (URL scheme, severity)
    const sender = createWebhookSender({ url: env["TWINS_ALERT_WEBHOOK_URL"], secret: env["TWINS_ALERT_WEBHOOK_SECRET"], allowInsecureTestDestination: env["TWINS_ALERT_ALLOW_INSECURE_TEST"] === "1" });
    const alerter = createAlerter({
      context: { environment: env["TWINS_ENV_NAME"] ?? env["APP_ENV"] ?? "unknown", service: "alert-test", build: env["TWINS_IMAGE_TAG"] },
      sender: { label: sender.label, send: async (p) => { delivered = await sender.send(p); return delivered; } },
      minSeverity: "INFO",
    });
    alerter.alert({ event: "alert.test", severity, code: "test_event", summary: "TEST ALERT - no action required", details: { reason: "manual_test" } });
    await alerter.flush();
  } catch {
    out(JSON.stringify({ ok: false, reason: "invalid_configuration" }));
    return 2;
  }
  out(JSON.stringify({ ok: delivered === true, severity, destination: new URL(env["TWINS_ALERT_WEBHOOK_URL"]).host }));
  return delivered === true ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), process.env, (l) => console.log(l)).then((c) => process.exit(c));
}
