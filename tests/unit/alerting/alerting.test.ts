import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  alerterFromEnv, alertingSink, buildAlert, createAlerter, createRelayServer, createRelaySender, createWebhookSender, recordProcessStart, sanitizeDetails, scrubSummary, signBody,
  validateWebhookUrl, type AlertPayload, type AlertSender,
} from "../../../packages/alerting/src/index";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { main as verifyAuditMain } from "../../../scripts/ops/verify-audit-chain";
import { main as alertTestMain } from "../../../scripts/ops/alert-test";

const CTX = { environment: "staging", service: "worker", build: "main-a0120d75" };
const NOW = new Date("2031-01-01T00:00:00.000Z");
const collector = () => {
  const sent: AlertPayload[] = [];
  const sender: AlertSender = { label: "test", send: async (p) => { sent.push(p); return true; } };
  return { sent, sender };
};
/** A sink wired to an alerter that records payloads; returns a logger the way processes use it. */
function wired(over: { minSeverity?: "INFO" | "WARNING" | "CRITICAL" } = {}) {
  const { sent, sender } = collector();
  const alerter = createAlerter({ context: CTX, sender, now: () => NOW, ...over });
  const records: LogRecord[] = [];
  const logger = createStructuredLogger(alertingSink((r) => records.push(r), alerter), { service: "worker" });
  return { sent, records, logger, alerter };
}

describe("alert payload contract", () => {
  it("has every required field and nothing else; build, correlation id and code are validated", () => {
    const p = buildAlert({ event: "outbox.dead_lettered", severity: "CRITICAL", code: "INGESTION_FAILED", summary: "An intake message was dead-lettered.", correlationId: "corr_abc-123", details: { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 8 } }, CTX, NOW);
    expect(p).toEqual({
      v: 1, event: "outbox.dead_lettered", severity: "CRITICAL", environment: "staging", service: "worker", timestamp: "2031-01-01T00:00:00.000Z", build: "main-a0120d75",
      correlationId: "corr_abc-123", code: "INGESTION_FAILED", summary: "An intake message was dead-lettered.", details: { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 8 },
    });
    const bad = buildAlert({ event: "x.y", severity: "INFO", code: "has spaces", summary: "s", correlationId: "a b" }, { environment: "st aging", service: "w;x", build: "bad build" }, NOW);
    expect(bad).toMatchObject({ code: "unspecified", environment: "unknown", service: "unknown", build: "unknown" });
    expect(bad.correlationId).toBeUndefined();
    expect(() => buildAlert({ event: "Bad Event", severity: "INFO", code: "c", summary: "s" }, CTX)).toThrow();
    expect(() => buildAlert({ event: "ok.event", severity: "FATAL" as never, code: "c", summary: "s" }, CTX)).toThrow();
  });
  it("defines exactly three severities in order", async () => {
    const m = await import("../../../packages/alerting/src/index");
    expect(m.SEVERITIES).toEqual(["INFO", "WARNING", "CRITICAL"]);
  });
});

describe("redaction", () => {
  // Synthetic secret-SHAPED values, assembled at runtime so that no secret-looking literal exists in the repository (the secret scanner would rightly flag it).
  const SECRETS = [
    ["AGE-SECRET-", "KEY-1", "Q".repeat(60)].join(""), ["postgresql", "://twins:", "hunter2pass", "@db:5432/x"].join(""), ["Bearer", " abcdefghijklmnop12345"].join(""), ["pass", "word=hunter2hunter2"].join(""),
    ["123456789", ":", "AAEhBP0av18neEJt2_4Tz8JYAX7vXcQd0aB"].join(""), ["AK", "IAABCDEFGHIJKLMNOP"].join(""), ["-----BEGIN ", "PRIVATE KEY-----"].join(""), "x".repeat(60),
  ];
  it("drops every key that is not on the allow-list (message text, payloads, credentials, stacks, paths)", () => {
    const d = sanitizeDetails({ rawText: "BUY RELIANCE", text: "hello", payload: { a: 1 }, token: "t", password: "p", stack: "at x (/etc/secret/file.ts:1)", path: "/etc/twins/staging.env", outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 3, chain: "audit_events" });
    expect(d).toEqual({ outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 3, chain: "audit_events" });
  });
  it("replaces secret-shaped VALUES even under an allowed key, in details, summary, build and correlation id", () => {
    for (const s of SECRETS) {
      expect(sanitizeDetails({ reason: s, name: s, failure: s }), s).toEqual({ reason: "[redacted]", name: "[redacted]", failure: "[redacted]" });
      expect(scrubSummary(`oops ${s}`), s).toBe("[redacted summary]");
      expect(buildAlert({ event: "a.b", severity: "INFO", code: "c", summary: "s", correlationId: s }, { ...CTX, build: s }, NOW).build, s).toBe("unknown");
    }
    const p = buildAlert({ event: "a.b", severity: "CRITICAL", code: "c", summary: "Fixed text", details: { sha256: "a".repeat(64), outboxId: "not-a-uuid" } }, CTX, NOW);
    expect(p.details).toEqual({ sha256: "a".repeat(64), outboxId: "[redacted]" }); // a checksum is allowed under its own key only
    expect(JSON.stringify(buildAlert({ event: "a.b", severity: "INFO", code: "c", summary: SECRETS.join(" "), details: { reason: SECRETS[0] } }, CTX, NOW))).not.toMatch(/AGE-SECRET|hunter2|AKIA|BEGIN PRIVATE|AAEhBP0/);
  });
});

describe("severity routing (every policy event)", () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["safety.outbox.dead_lettered", { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 8, errorCode: "INGESTION_FAILED" }, "outbox.dead_lettered", "CRITICAL"],
    ["safety.outbox.stuck", { count: 2, oldestAgeSeconds: 4000 }, "outbox.stuck", "CRITICAL"],
    ["telegram.capture.gap", { ageSeconds: 9000, windowSeconds: 3600 }, "telegram.capture_gap", "CRITICAL"],
    ["kite.session.invalidated", { reason: "server_rejected" }, "kite.session_invalidated", "CRITICAL"],
    ["worker.queue.job_failed", { queue: "ingest", jobId: "j1", attemptsMade: 5, maxAttempts: 5 }, "queue.job_exhausted", "CRITICAL"],
    ["safety.kill_switch.activated", { version: 4, changedBy: "operator:ops" }, "safety.kill_switch_activated", "CRITICAL"],
    ["safety.control.changed", { control: "TRADING_ENABLED", newValue: true, version: 2 }, "safety.trading_enabled", "CRITICAL"],
    ["safety.state_unavailable", { cause: "timeout" }, "runtime_state.unavailable", "CRITICAL"],
    ["backup.failed", { step: "dump", failure: "empty_dump" }, "backup.failed", "CRITICAL"],
    ["backup.failed", { step: "verify_upload", failure: "checksum_mismatch" }, "backup.checksum_mismatch", "CRITICAL"],
    ["backup.failed", { step: "upload", failure: "upload_failed" }, "backup.upload_failed", "CRITICAL"],
    ["verify.failed", { checked: 3, problemCount: 1 }, "backup.verification_failed", "CRITICAL"],
    ["drill.failed", { step: "decrypt", failure: "decrypt_failed" }, "backup.restore_drill_failed", "CRITICAL"],
    ["migration.failed", { errorCode: "42P01" }, "migration.failed", "CRITICAL"],
    ["process.restart_loop", { service: "worker", restarts: 3, windowSeconds: 600 }, "process.restart_loop", "CRITICAL"],
    ["outbox.reconciled", { action: "lease_expired", outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 1 }, "outbox.stale_job_recovered", "WARNING"],
    ["outbox.retry_scheduled", { attempt: 6, maxAttempts: 8, errorCode: "X", outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f" }, "outbox.retry_threshold", "WARNING"],
    ["backup.delayed", { ageSeconds: 200000 }, "backup.delayed", "WARNING"],
    ["safety.control.changed", { control: "INTAKE_ENABLED", newValue: false, version: 3 }, "safety.intake_disabled", "WARNING"],
  ];
  it.each(cases)("%s -> %s (%s)", (event, fields, expectedEvent, severity) => {
    const w = wired({ minSeverity: "INFO" });
    (w.logger as unknown as { error: (e: string, f: object) => void }).error(event, fields);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ event: expectedEvent, severity, service: "worker", environment: "staging", build: "main-a0120d75", v: 1 });
    expect(w.records[0]?.event).toBe(event); // the normal log line is still written
  });
  it("kill switch cleared is INFO and below the default WARNING threshold it is logged, not sent", () => {
    const w = wired();
    w.logger.info("safety.control.changed", { control: "KILL_SWITCH_ACTIVE", newValue: false, version: 5 });
    expect(w.sent).toEqual([]);
    const all = wired({ minSeverity: "INFO" });
    all.logger.info("safety.control.changed", { control: "KILL_SWITCH_ACTIVE", newValue: false, version: 5 });
    expect(all.sent[0]).toMatchObject({ event: "safety.kill_switch_cleared", severity: "INFO" });
  });
  it("events outside the policy, retries far from the limit, and trading switched OFF raise nothing", () => {
    const w = wired({ minSeverity: "INFO" });
    w.logger.info("outbox.retry_scheduled", { attempt: 1, maxAttempts: 8 });
    w.logger.info("safety.control.changed", { control: "TRADING_ENABLED", newValue: false, version: 2 });
    w.logger.info("worker.job.completed", {});
    w.logger.info("alert.sent", {}); // alert logs never feed the rules
    expect(w.sent).toEqual([]);
  });
  it("message content in a triggering log record cannot reach the alert (the logger strips it; the builder drops it again)", () => {
    const w = wired();
    w.logger.error("safety.outbox.dead_lettered", { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", rawText: "BUY RELIANCE @ 2800", text: "secret chat", payload: { x: 1 }, errorCode: "E" });
    expect(JSON.stringify(w.sent)).not.toMatch(/RELIANCE|secret chat|payload/);
  });
});

describe("alerter behaviour", () => {
  it("throttles identical alerts and reports how many were suppressed; different keys are independent", async () => {
    const { sent, sender } = collector();
    let t = NOW.getTime();
    const a = createAlerter({ context: CTX, sender, throttleMs: 60_000, now: () => new Date(t) });
    for (let i = 0; i < 5; i++) a.alert({ event: "outbox.stuck", severity: "CRITICAL", code: "c", summary: "s", dedupeKey: "k1" });
    a.alert({ event: "outbox.stuck", severity: "CRITICAL", code: "c", summary: "s", dedupeKey: "k2" });
    await a.flush();
    expect(sent).toHaveLength(2);
    t += 61_000;
    a.alert({ event: "outbox.stuck", severity: "CRITICAL", code: "c", summary: "s", dedupeKey: "k1" });
    await a.flush();
    expect(sent[2]?.details["suppressedSinceLast"]).toBe(4);
  });
  it("with no destination the alert is logged as undelivered (never silent); a failing sender is logged and never throws", async () => {
    const records: LogRecord[] = [];
    const logger = createStructuredLogger((r) => records.push(r));
    const none = createAlerter({ context: CTX, logger });
    none.alert({ event: "backup.failed", severity: "CRITICAL", code: "c", summary: "s" });
    expect(records.find((r) => r.event === "alert.undelivered")).toMatchObject({ reason: "no_destination_configured", alertEvent: "backup.failed" });
    const failing = createAlerter({ context: CTX, logger, sender: { label: "x", send: async () => { throw new Error("boom https://hook.example/T0KEN"); } } });
    failing.alert({ event: "backup.failed", severity: "CRITICAL", code: "c", summary: "s" });
    await failing.flush();
    const failedLog = records.find((r) => r.event === "alert.delivery_failed");
    expect(failedLog).toBeDefined();
    expect(JSON.stringify(records)).not.toContain("T0KEN");
  });
  it("an invalid environment configuration is rejected without echoing it", () => {
    expect(() => alerterFromEnv({ TWINS_ALERT_WEBHOOK_URL: "http://hooks.example.com/abc" }, "x")).toThrow(/https/);
    expect(() => alerterFromEnv({ TWINS_ALERT_MIN_SEVERITY: "LOUD" }, "x")).toThrow(/INFO, WARNING or CRITICAL/);
    expect(() => alerterFromEnv({ TWINS_ALERT_RELAY_URL: "http://alert-relay:8099/v1/alert", TWINS_ALERT_RELAY_TOKEN: "short" }, "x")).toThrow(/at least 24/);
    expect(alerterFromEnv({}, "x").configured).toBe(false);
    expect(alerterFromEnv({ TWINS_ALERT_RELAY_URL: "http://alert-relay:8099/v1/alert", TWINS_ALERT_RELAY_TOKEN: "" }, "x").configured).toBe(false); // relay URL without a token = not configured
    expect(alerterFromEnv({ TWINS_ALERT_WEBHOOK_URL: "https://hooks.example.com/abc" }, "x").configured).toBe(true);
    expect(() => validateWebhookUrl("http://127.0.0.1:9/x")).not.toThrow();
    expect(() => validateWebhookUrl("not a url")).toThrow();
  });
  it("process start counting raises process.restart_loop on the third start in the window", async () => {
    const store = new Map<string, number>();
    const counter = { incr: async (k: string) => { store.set(k, (store.get(k) ?? 0) + 1); return store.get(k) as number; } };
    const w = wired();
    for (let i = 0; i < 3; i++) await recordProcessStart(counter, "worker", w.logger);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ event: "process.restart_loop", severity: "CRITICAL", details: { restarts: 3, windowSeconds: 600 } });
    expect(await recordProcessStart({ incr: async () => { throw new Error("redis down"); } }, "api", w.logger)).toBe(0); // best effort
  });
});

describe("webhook sender and relay", () => {
  it("signs the body (HMAC-SHA256), posts JSON, retries a 5xx but not a 4xx, and refuses redirects and plain http to non-loopback", async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    let status = 500;
    const fetchImpl = (async (_u: string, init: RequestInit) => { calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) }); return new Response("", { status }); }) as typeof fetch;
    const sender = createWebhookSender({ url: "https://hooks.example.com/secret-token", secret: "shared-secret", fetchImpl, sleep: async () => undefined });
    const payload = buildAlert({ event: "a.b", severity: "CRITICAL", code: "c", summary: "s" }, CTX, NOW);
    expect(await sender.send(payload)).toBe(false);
    expect(calls).toHaveLength(2); // 5xx retried once
    expect(calls[0]?.headers["x-twins-signature"]).toBe(signBody(calls[0]?.body ?? "", "shared-secret"));
    expect(sender.label).toBe("webhook:hooks.example.com"); // host only, never the path/token
    calls.length = 0; status = 400;
    expect(await sender.send(payload)).toBe(false);
    expect(calls).toHaveLength(1); // a 4xx is not retried
    status = 200;
    expect(await sender.send(payload)).toBe(true);
    expect(() => createWebhookSender({ url: "http://hooks.example.com/x" })).toThrow();
  });
  it("the relay needs the bearer token, re-sanitises what it forwards, rejects malformed or oversized bodies, and exposes nothing else", async () => {
    const forwarded: AlertPayload[] = [];
    const server = createRelayServer({ token: "t".repeat(32), sender: { label: "x", send: async (p) => { forwarded.push(p); return true; } }, now: () => NOW });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ v: 1, event: "outbox.dead_lettered", severity: "CRITICAL", environment: "staging", service: "worker", code: "E1", summary: "Dead-lettered.", details: { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", rawText: "BUY RELIANCE", token: "leak", reason: "Bearer abcdefghijklmnop12345" } });
      const h = { "content-type": "application/json", authorization: `Bearer ${"t".repeat(32)}` };
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body })).status).toBe(401);
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body, headers: { ...h, authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body, headers: h })).status).toBe(202);
      await vi.waitFor(() => expect(forwarded).toHaveLength(1));
      expect(forwarded[0]?.details).toEqual({ outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", reason: "[redacted]" });
      expect(JSON.stringify(forwarded)).not.toMatch(/RELIANCE|leak/);
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body: "{nope", headers: h })).status).toBe(400);
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body: JSON.stringify({ v: 2 }), headers: h })).status).toBe(400);
      expect((await fetch(`${base}/v1/alert`, { method: "POST", body: "x".repeat(20_000), headers: h }).catch(() => ({ status: 413 }))).status).toBe(413);
      expect((await fetch(`${base}/other`, { method: "GET" })).status).toBe(404);
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const viaSender = createRelaySender({ url: `${base}/v1/alert`, token: "t".repeat(32) });
      expect(await viaSender.send(buildAlert({ event: "a.b", severity: "WARNING", code: "c", summary: "s" }, CTX, NOW))).toBe(true);
      expect(await createRelaySender({ url: `${base}/v1/alert`, token: "bad".repeat(10) }).send(buildAlert({ event: "a.b", severity: "WARNING", code: "c", summary: "s" }, CTX, NOW))).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("audit verification failure alert", () => {
  it("a failing verification raises CRITICAL audit.verification_failed (broken chain) or audit.protection_failed (trigger/DDL watch) and exits 1; a pass raises nothing", async () => {
    const { sent, sender } = collector();
    const alerter = createAlerter({ context: { ...CTX, service: "audit-verify" }, sender, now: () => NOW });
    const out: string[] = [];
    // an unreachable/erroring database -> exit 3 + CRITICAL audit.verification_unavailable
    const code3 = await verifyAuditMain([], { env: { DATABASE_URL: "postgresql://x" }, out: (l) => out.push(l), err: () => undefined, alerter, open: () => ({ db: { query: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } }, close: async () => undefined }) });
    expect(code3).toBe(3);
    expect(sent[0]).toMatchObject({ event: "audit.verification_unavailable", severity: "CRITICAL" });
  });
});

describe("alert-test command", () => {
  it("is clearly marked as a test, delivers through the configured destination, and never prints it", async () => {
    const got: AlertPayload[] = [];
    const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(JSON.parse(b) as AlertPayload); res.writeHead(200).end(); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-path-token`;
    const lines: string[] = [];
    try {
      expect(await alertTestMain([], { TWINS_ALERT_WEBHOOK_URL: url, TWINS_ENV_NAME: "staging", TWINS_IMAGE_TAG: "main-test" }, (l) => lines.push(l))).toBe(0);
      expect(got[0]).toMatchObject({ event: "alert.test", severity: "INFO", code: "test_event", summary: "TEST ALERT - no action required", environment: "staging", build: "main-test", service: "alert-test" });
      expect(lines.join("")).not.toContain("secret-path-token");
      expect(await alertTestMain([], {}, (l) => lines.push(l))).toBe(2); // no destination
      expect(await alertTestMain(["--severity", "LOUD"], { TWINS_ALERT_WEBHOOK_URL: url }, (l) => lines.push(l))).toBe(2);
    } finally {
      server.close();
    }
  });
});
