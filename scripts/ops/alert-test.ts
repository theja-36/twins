/**
 * Safe test alert through the SAME path real alerts take (application -> alert-relay -> every configured destination), then reports the relay's own
 * per-destination result. The payload is the normal contract with event `alert.test`, code `test_event` and the summary "TEST ALERT - no action required".
 *   alert-test [--severity INFO|WARNING|CRITICAL]
 * Exit 0 if at least one destination delivered, 1 if none did, 2 if no relay/destination is configured or the configuration is invalid.
 * Without a relay (TWINS_ALERT_RELAY_URL) a direct webhook (TWINS_ALERT_WEBHOOK_URL) is used. Nothing secret is printed (destination labels only).
 */
import { pathToFileURL } from "node:url";
import { alerterFromEnv, buildAlert, createRelaySender, createWebhookSender, SEVERITIES, type Severity } from "../../packages/alerting/src/index";

export async function main(argv: string[], env: Record<string, string | undefined>, out: (l: string) => void, fetchImpl: typeof fetch = fetch): Promise<number> {
  const i = argv.indexOf("--severity");
  const severity = (i >= 0 ? argv[i + 1] : "INFO") as Severity;
  if (!SEVERITIES.includes(severity)) { out("usage: alert-test [--severity INFO|WARNING|CRITICAL]"); return 2; }
  const relayUrl = env["TWINS_ALERT_RELAY_URL"];
  const relayToken = env["TWINS_ALERT_RELAY_TOKEN"];
  try { alerterFromEnv(env, "alert-test"); } catch { out(JSON.stringify({ ok: false, reason: "invalid_configuration" })); return 2; }
  const payload = buildAlert({ event: "alert.test", severity, code: "test_event", summary: "TEST ALERT - no action required", details: { reason: "manual_test" } }, { environment: env["TWINS_ENV_NAME"] ?? env["APP_ENV"] ?? "unknown", service: "alert-test", build: env["TWINS_IMAGE_TAG"] });
  if (relayUrl && relayToken) {
    const accepted = await createRelaySender({ url: relayUrl, token: relayToken, fetchImpl }).send(payload);
    if (!accepted) { out(JSON.stringify({ ok: false, stage: "relay", reason: "relay_did_not_accept" })); return 1; }
    // the relay forwards asynchronously: poll its status for the outcome of THIS test (matched by event and time)
    const statusUrl = relayUrl.replace(/\/v1\/alert$/, "/v1/status");
    const started = Date.now();
    for (let n = 0; n < 40 && Date.now() - started < 30_000; n++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetchImpl(statusUrl, { headers: { authorization: `Bearer ${relayToken}` } }).catch(() => undefined);
      const status = (await res?.json().catch(() => undefined)) as { recent?: Array<{ event: string; at: string; results: Array<{ destination: string; ok: boolean }> }>; destinations?: string[] } | undefined;
      const hit = status?.recent?.find((r) => r.event === "alert.test" && Date.parse(r.at) >= started - 1000);
      if (hit && hit.results.length === 0) { out(JSON.stringify({ ok: false, reason: "no_destination_configured" })); return 2; }
      if (hit) {
        out(JSON.stringify({ ok: hit.results.some((r) => r.ok), severity, results: hit.results }));
        return hit.results.some((r) => r.ok) ? 0 : 1;
      }
      if (status && (status.destinations ?? []).length === 0) { out(JSON.stringify({ ok: false, reason: "no_destination_configured" })); return 2; }
    }
    out(JSON.stringify({ ok: false, reason: "no_result_from_relay" }));
    return 1;
  }
  if (!env["TWINS_ALERT_WEBHOOK_URL"]) { out(JSON.stringify({ ok: false, reason: "no_destination_configured" })); return 2; }
  const sender = createWebhookSender({ url: env["TWINS_ALERT_WEBHOOK_URL"], secret: env["TWINS_ALERT_WEBHOOK_SECRET"], allowInsecureTestDestination: env["TWINS_ALERT_ALLOW_INSECURE_TEST"] === "1" });
  const ok = await sender.send(payload);
  out(JSON.stringify({ ok, severity, results: [{ destination: sender.label, ok }] }));
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), process.env, (l) => console.log(l)).then((c) => process.exit(c));
}
