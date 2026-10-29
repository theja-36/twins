/**
 * Telegram alert destination against a MOCKED Telegram Bot API (a local HTTP server standing in for api.telegram.org). Nothing leaves the machine.
 * Covers: message format and content, retry/backoff for transient failures, permanent failures, relay end to end, undelivered CRITICAL alerts
 * (logged, counted, persisted, retried, never silent), redaction, token/chat-id secrecy, the host chat resolver and the test-alert command.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAlert, createFanoutSender, createRelayServer, createRelaySender, createTelegramSender, createWebhookSender, formatTelegramText, TelegramConfigError, validateTelegramConfig,
  type AlertPayload, type RelayServer,
} from "../../../packages/alerting/src/index";
import { main as alertTest } from "../../../scripts/ops/alert-test";

// Synthetic, well-formed values (a made-up token shape and chat id). Assembled at runtime so no token-looking literal is committed.
const TOKEN = ["123456789", ":", "AAF_synthetic_test_token_0123456789abcd"].join("");
const CHAT = "-1001234567890";
const RELAY_TOKEN = "r".repeat(32);

interface Call { path: string; body: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
type Script = Array<{ status: number; body?: unknown } | "drop">;

async function mockTelegram(script: Script = [], updates: unknown[] = []) {
  const calls: Call[] = [];
  const queue = [...script];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path.endsWith("/getUpdates")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: updates })); return; }
      calls.push({ path, body: b ? JSON.parse(b) : {} });
      const step = queue.shift() ?? { status: 200 };
      if (step === "drop") { req.socket.destroy(); return; }
      res.writeHead(step.status, { "content-type": "application/json" }).end(JSON.stringify(step.body ?? (step.status === 200 ? { ok: true, result: { message_id: 1 } } : { ok: false })));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { calls, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const payload = (over: Partial<Parameters<typeof buildAlert>[0]> = {}, build = "task5-5683e412"): AlertPayload =>
  buildAlert({ event: "outbox.dead_lettered", severity: "CRITICAL", code: "INGESTION_FAILED", summary: "An intake message was dead-lettered; operator action required.", correlationId: "corr_abc-123", details: { outboxId: "a7a3af84-31e0-4588-8db9-314b25563f3f", attempt: 8 }, ...over }, { environment: "staging", service: "worker", build }, new Date("2031-01-01T00:00:00.000Z"));
const noSleep = async () => undefined;
const open: Array<{ close: () => void }> = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

describe("Telegram message format and content", () => {
  it("a CRITICAL alert carries event, severity, environment, service, build, timestamp, safe code and summary as concise plain text", () => {
    const text = formatTelegramText(payload());
    expect(text).toContain("CRITICAL outbox.dead_lettered");
    for (const part of ["env: staging", "service: worker", "build: task5-5683e412", "time: 2031-01-01T00:00:00.000Z", "code: INGESTION_FAILED", "An intake message was dead-lettered; operator action required.", "correlation: corr_abc-123", "outboxId=a7a3af84-31e0-4588-8db9-314b25563f3f", "attempt=8"]) expect(text, part).toContain(part);
    expect(text.length).toBeLessThan(700);
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
  });
  it("never contains secrets, tokens, keys, message text or the chat id, whatever the input", () => {
    const secret = ["AGE-SECRET-", "KEY-1", "Q".repeat(60)].join("");
    const text = formatTelegramText(payload({ summary: `leak ${secret}`, details: { rawText: "BUY RELIANCE @ 2800", token: TOKEN, reason: secret, name: ["postgresql", "://u:", "pw123456", "@h/db"].join("") } }));
    for (const forbidden of [secret, TOKEN, "RELIANCE", "pw123456", CHAT, "postgresql"]) expect(text, forbidden).not.toContain(forbidden);
  });
});

describe("Telegram sender", () => {
  it("posts to /bot<token>/sendMessage with a numeric chat_id and the formatted text (no parse_mode) and succeeds on 200", async () => {
    const tg = await mockTelegram(); open.push(tg);
    const sender = createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: noSleep });
    expect(await sender.send(payload())).toBe(true);
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]?.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(tg.calls[0]?.body).toMatchObject({ chat_id: Number(CHAT), disable_web_page_preview: true });
    expect(tg.calls[0]?.body["parse_mode"]).toBeUndefined();
    expect(tg.calls[0]?.body["text"]).toContain("CRITICAL outbox.dead_lettered");
    expect(sender.label).toBe("telegram"); // never the token or the chat id
  });
  it("retries transient failures (5xx, dropped connection, 429 honouring retry_after) with backoff and then succeeds", async () => {
    const tg = await mockTelegram([{ status: 502 }, "drop", { status: 429, body: { ok: false, parameters: { retry_after: 2 } } }, { status: 200 }]); open.push(tg);
    const waits: number[] = [];
    const sender = createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: async (ms) => void waits.push(ms), random: () => 1 });
    expect(await sender.send(payload())).toBe(true);
    expect(tg.calls).toHaveLength(4);
    expect(waits).toEqual([500, 1000, 2000]); // exponential (500, 1000) then Telegram's retry_after of 2 s
  });
  it("gives up after the attempt limit on persistent transient failures, and at once on a permanent 4xx (wrong chat / blocked bot / bad token)", async () => {
    const tg = await mockTelegram([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 403, body: { ok: false, description: "bot was blocked" } }]); open.push(tg);
    const sender = createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: noSleep });
    expect(await sender.send(payload())).toBe(false);
    expect(tg.calls).toHaveLength(4);
    expect(await sender.send(payload())).toBe(false);
    expect(tg.calls).toHaveLength(5); // the 403 was not retried
  });
  it("validates configuration without echoing it", () => {
    for (const [t, c] of [["not-a-token", CHAT], [TOKEN, "not-numeric"], [TOKEN, ""], ["", CHAT]] as const) {
      const err = (() => { try { validateTelegramConfig(t, c); return undefined; } catch (e) { return e as Error; } })();
      expect(err).toBeInstanceOf(TelegramConfigError);
      expect(err?.message).not.toContain(TOKEN);
    }
    expect(() => validateTelegramConfig(TOKEN, CHAT, "http://hooks.example.com")).toThrow(/https/);
    expect(() => validateTelegramConfig(TOKEN, CHAT)).not.toThrow();
  });
  it("a failing destination never hides the others (fan-out)", async () => {
    const tg = await mockTelegram([{ status: 400 }]); open.push(tg);
    const hook = createServer((_req, res) => res.writeHead(200).end()); await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r)); open.push(hook);
    const fan = createFanoutSender([createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: noSleep }), createWebhookSender({ url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h` })]);
    expect(await fan.send(payload())).toBe(true);
    expect(fan.results()).toEqual([{ destination: "telegram", ok: false }, { destination: "webhook:127.0.0.1:" + (hook.address() as AddressInfo).port, ok: true }]);
  });
});

describe("relay with the Telegram destination", () => {
  async function relayWith(script: Script, extra: Partial<Parameters<typeof createRelayServer>[0]> = {}) {
    const tg = await mockTelegram(script); open.push(tg);
    const logs: Array<Record<string, unknown>> = [];
    const statuses: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let t = Date.parse("2031-01-01T00:00:00Z");
    const server: RelayServer = createRelayServer({ token: RELAY_TOKEN, destinations: [createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: noSleep, attempts: 2 })], log: (e, f) => logs.push({ event: e, ...f }), onStatus: (s) => statuses.push({ ...s }), retryTickMs: 0, now: () => new Date(t), retryBaseMs: 1000, ...extra });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); open.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/alert`;
    return { tg, server, url, logs, statuses, advance: (ms: number) => { t += ms; }, post: (p: AlertPayload) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(p) }) };
  }
  const settle = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

  it("an application alert posted to the relay arrives in the Telegram chat, exactly once, with no token or chat id in logs or status", async () => {
    const r = await relayWith([]);
    expect((await r.post(payload())).status).toBe(202);
    await settle(() => r.tg.calls.length === 1);
    expect(r.tg.calls).toHaveLength(1);
    expect(r.tg.calls[0]?.body["text"]).toContain("CRITICAL outbox.dead_lettered");
    await settle(() => r.server.status().delivered === 1);
    expect(r.server.status()).toMatchObject({ delivered: 1, failed: 0, pendingCritical: 0, undeliveredCritical: 0, destinations: ["telegram"] });
    const everything = JSON.stringify([r.logs, r.statuses, r.server.status()]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(CHAT);
  });
  it("an undelivered CRITICAL alert is logged at error level, counted, persisted in the status, retried with backoff, and delivered when Telegram recovers", async () => {
    const r = await relayWith([{ status: 500 }, { status: 500 }, { status: 200 }]);
    await r.post(payload());
    await settle(() => r.server.status().undeliveredCritical === 1);
    expect(r.server.status()).toMatchObject({ failed: 1, undeliveredCritical: 1, pendingCritical: 1, droppedCritical: 0 });
    expect(r.server.status().lastUndeliveredCriticalAt).toBe("2031-01-01T00:00:00.000Z");
    expect(r.logs.find((l) => l["event"] === "relay.undelivered_critical")).toMatchObject({ alertEvent: "outbox.dead_lettered", severity: "CRITICAL", reason: "all_destinations_failed" });
    expect(r.statuses.at(-1)).toMatchObject({ pendingCritical: 1, undeliveredCritical: 1 });
    expect(await r.server.retryPending()).toBe(0); // not yet due
    r.advance(1500);
    expect(await r.server.retryPending()).toBe(1);
    expect(r.server.status()).toMatchObject({ delivered: 1, pendingCritical: 0, droppedCritical: 0 });
    expect(r.logs.some((l) => l["event"] === "relay.forwarded" && l["retry"] === 1)).toBe(true);
  });
  it("a CRITICAL alert that stays undeliverable past the retry window is dropped LOUDLY (error log + droppedCritical in the status), never silently", async () => {
    const r = await relayWith(Array(40).fill({ status: 500 }), { criticalRetryWindowMs: 10_000 });
    await r.post(payload());
    await settle(() => r.server.status().pendingCritical === 1);
    r.advance(20_000);
    await r.server.retryPending();
    expect(r.server.status()).toMatchObject({ pendingCritical: 0, droppedCritical: 1, undeliveredCritical: 1 });
    expect(r.logs.find((l) => l["event"] === "relay.critical_dropped")).toMatchObject({ alertEvent: "outbox.dead_lettered", severity: "CRITICAL", reason: "retry_window_exhausted" });
    expect(r.statuses.at(-1)).toMatchObject({ droppedCritical: 1 });
  });
  it("non-CRITICAL failures are logged (warn) and counted but not retried; with no destination every alert is reported as undelivered", async () => {
    const r = await relayWith([{ status: 400 }]);
    await r.post(payload({ severity: "WARNING", event: "backup.delayed" }));
    await settle(() => r.server.status().failed === 1);
    expect(r.server.status()).toMatchObject({ failed: 1, undeliveredCritical: 0, pendingCritical: 0 });
    expect(r.logs.find((l) => l["event"] === "relay.forward_failed")).toMatchObject({ severity: "WARNING" });
    const none = createRelayServer({ token: RELAY_TOKEN, destinations: [], retryTickMs: 0 }); await new Promise<void>((x) => none.listen(0, "127.0.0.1", x)); open.push(none);
    await fetch(`http://127.0.0.1:${(none.address() as AddressInfo).port}/v1/alert`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}` }, body: JSON.stringify(payload()) });
    await settle(() => none.status().undeliveredCritical === 1);
    expect(none.status()).toMatchObject({ undeliveredCritical: 1, pendingCritical: 1, destinations: [] });
  });
  it("the relay status endpoint needs the relay token and exposes only counters, labels and event names", async () => {
    const r = await relayWith([]);
    await r.post(payload());
    await settle(() => r.server.status().delivered === 1);
    const base = r.url.replace("/v1/alert", "/v1/status");
    expect((await fetch(base)).status).toBe(401);
    const body = (await (await fetch(base, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body["recent"][0]).toMatchObject({ event: "outbox.dead_lettered", severity: "CRITICAL", results: [{ destination: "telegram", ok: true }] });
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${TOKEN}|${CHAT}|a7a3af84|INGESTION`));
  });
});

describe("safe test-alert command", () => {
  it("sends alert.test through the relay and reports the per-destination result; exit 1 when the destination fails, 2 when none is configured", async () => {
    const tg = await mockTelegram([{ status: 200 }, { status: 403 }]); open.push(tg);
    const server = createRelayServer({ token: RELAY_TOKEN, destinations: [createTelegramSender({ token: TOKEN, chatId: CHAT, apiBase: tg.base, sleep: noSleep })], retryTickMs: 0 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); open.push(server);
    const env = { TWINS_ALERT_RELAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/alert`, TWINS_ALERT_RELAY_TOKEN: RELAY_TOKEN, TWINS_ENV_NAME: "staging", TWINS_IMAGE_TAG: "task5-test" };
    const out: string[] = [];
    expect(await alertTest([], env, (l) => out.push(l))).toBe(0);
    expect(JSON.parse(out[0] as string)).toEqual({ ok: true, severity: "INFO", results: [{ destination: "telegram", ok: true }] });
    expect(tg.calls[0]?.body["text"]).toContain("INFO alert.test");
    expect(tg.calls[0]?.body["text"]).toContain("TEST ALERT - no action required");
    expect(tg.calls[0]?.body["text"]).toContain("build: task5-test");
    out.length = 0;
    expect(await alertTest(["--severity", "CRITICAL"], env, (l) => out.push(l))).toBe(1); // Telegram answered 403
    expect(JSON.parse(out[0] as string)).toMatchObject({ ok: false, results: [{ destination: "telegram", ok: false }] });
    expect(out.join("")).not.toMatch(new RegExp(`${TOKEN}|${CHAT}`));
    const none = createRelayServer({ token: RELAY_TOKEN, destinations: [], retryTickMs: 0 }); await new Promise<void>((r) => none.listen(0, "127.0.0.1", r)); open.push(none);
    out.length = 0;
    expect(await alertTest([], { ...env, TWINS_ALERT_RELAY_URL: `http://127.0.0.1:${(none.address() as AddressInfo).port}/v1/alert` }, (l) => out.push(l))).toBe(2);
    expect(await alertTest([], {}, (l) => out.push(l))).toBe(2);
  });
});

describe("chat resolver script (host)", () => {
  const SCRIPT = join(__dirname, "../../../infrastructure/staging/twins-telegram-resolve-chat.sh");
  const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], { env: { PATH: process.env["PATH"] ?? "", ...env } });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
  const files = () => { const d = mkdtempSync(join(tmpdir(), "twins-resolve-")); writeFileSync(join(d, "bot.env"), `TWINS_BOT_ACTIVE=false\nTWINS_BOT_TOKEN=${TOKEN}\n`); writeFileSync(join(d, "staging.env"), "TWINS_API_KEY=x\nTWINS_ALERT_TELEGRAM_CHAT_ID=\n"); return d; };
  const chat = (id: number, type: string, title: string) => ({ update_id: 1, my_chat_member: { chat: { id, type, title } } });
  it("writes ONLY the numeric id of the single matching chat into the staging env file and prints it masked", async () => {
    const d = files();
    const tg = await mockTelegram([], [chat(-1001234567890, "supergroup", "TWINS ops alerts"), chat(-1009999999999, "channel", "Some other chat")]); open.push(tg);
    const r = await run(["--env-file", join(d, "staging.env"), "--bot-env", join(d, "bot.env"), "--title", "ops alerts"], { TELEGRAM_API_BASE: tg.base });
    expect(r.code).toBe(0);
    expect(readFileSync(join(d, "staging.env"), "utf8")).toBe(`TWINS_API_KEY=x\nTWINS_ALERT_TELEGRAM_CHAT_ID=${CHAT}\n`);
    expect(JSON.parse(r.out.trim().split("\n").at(-1) as string)).toMatchObject({ written: true, chat: "...7890", type: "supergroup", title: "TWINS ops alerts" });
    expect(r.out).not.toContain(CHAT);
    expect(r.out).not.toContain(TOKEN);
  });
  it("refuses to guess: several or no candidates -> exit 3, nothing written, ids only masked", async () => {
    const d = files();
    const tg = await mockTelegram([], [chat(-1001234567890, "supergroup", "TWINS ops alerts"), chat(-1009999999999, "channel", "Another")]); open.push(tg);
    const many = await run(["--env-file", join(d, "staging.env"), "--bot-env", join(d, "bot.env")], { TELEGRAM_API_BASE: tg.base });
    expect(many.code).toBe(3);
    expect(readFileSync(join(d, "staging.env"), "utf8")).toContain("TWINS_ALERT_TELEGRAM_CHAT_ID=\n");
    expect(many.out).toMatch(/"chat": "\.\.\.7890"/);
    expect(many.out).not.toMatch(/1001234567890|1009999999999/);
    expect((await run(["--env-file", join(d, "staging.env"), "--bot-env", join(d, "bot.env"), "--title", "nothing matches"], { TELEGRAM_API_BASE: tg.base })).code).toBe(3);
    expect((await run(["--env-file", join(d, "staging.env"), "--bot-env", join(d, "missing.env")], { TELEGRAM_API_BASE: tg.base })).code).toBe(2);
  });
  it("the relay sender helper is unaffected (internal path still works)", async () => {
    const server = createRelayServer({ token: RELAY_TOKEN, destinations: [], retryTickMs: 0 }); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); open.push(server);
    expect(await createRelaySender({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/alert`, token: RELAY_TOKEN }).send(payload())).toBe(true);
  });
});
void (undefined as unknown as Server);
