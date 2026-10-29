import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, unlinkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStatus } from "../../../apps/api/src/statusSurface";

const ROOT = join(__dirname, "../../..");
const ALERT = join(ROOT, "infrastructure/staging/twins-alert.sh");
const HEALTH = join(ROOT, "infrastructure/staging/twins-health-check.sh");
const VERIFY = join(ROOT, "infrastructure/staging/twins-backup-verify.sh");
const tmp = (): string => mkdtempSync(join(tmpdir(), "twins-host-"));

async function sink(status = 200) {
  const got: Array<{ body: Record<string, any>; raw: string; headers: Record<string, string | string[] | undefined>; url: string }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ body: JSON.parse(b), raw: b, headers: req.headers, url: req.url ?? "" }); res.writeHead(status).end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook-secret-token`, close: () => server.close() };
}
// async spawn: the in-process test sink must stay able to answer while the script runs
const run = (script: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("bash", [script, ...args], { env: { PATH: process.env["PATH"] ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });

describe("twins-alert.sh (host alert sender)", () => {
  it("sends the contract payload to the destination from the env file, signs it, and never prints the URL or secret", async () => {
    const s = await sink();
    const dir = tmp();
    writeFileSync(join(dir, "alert.env"), `TWINS_ALERT_WEBHOOK_URL=${s.url}\nTWINS_ALERT_WEBHOOK_SECRET=top-secret-value\nTWINS_ENV_NAME=staging\nTWINS_BUILD=main-a0120d75\n`);
    try {
      const r = await run(ALERT, ["--detail", "count=3", "--detail", "rawText=BUY RELIANCE", "backup.failed", "CRITICAL", "twins-backup", "dump_failed", "The backup failed.", "corr_abc-123"], { TWINS_ALERT_ENV_FILE: join(dir, "alert.env"), TWINS_ALERT_STATE_DIR: join(dir, "state") });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/"event":"alert.sent"/);
      expect(r.out).not.toMatch(/hook-secret-token|top-secret-value/);
      const m = s.got[0];
      expect(m?.body).toMatchObject({ v: 1, event: "backup.failed", severity: "CRITICAL", environment: "staging", service: "twins-backup", build: "main-a0120d75", correlationId: "corr_abc-123", code: "dump_failed", summary: "The backup failed.", details: { count: 3 } });
      expect(Object.keys(m?.body ?? {}).sort()).toEqual(["build", "code", "correlationId", "details", "environment", "event", "service", "severity", "summary", "timestamp", "v"]);
      expect(m?.body["details"]).toEqual({ count: 3 }); // the non-allow-listed detail was dropped
      expect(m?.headers["x-twins-signature"]).toBe(`sha256=${createHmac("sha256", "top-secret-value").update(m?.raw ?? "").digest("hex")}`);
    } finally { s.close(); }
  });
  it("derives event and code from a failed systemd unit (OnFailure)", async () => {
    const s = await sink();
    const dir = tmp();
    writeFileSync(join(dir, "alert.env"), `TWINS_ALERT_WEBHOOK_URL=${s.url}\n`);
    try {
      for (const [unit, event] of [["twins-backup.service", "backup.failed"], ["twins-audit-verify.service", "audit.verification_failed"], ["twins-backup-verify.service", "backup.verification_failed"], ["twins-other.service", "job.failed"]] as const) {
        await run(ALERT, ["--unit", unit], { TWINS_ALERT_ENV_FILE: join(dir, "alert.env"), TWINS_ALERT_STATE_DIR: join(dir, "s") });
        expect(s.got.at(-1)?.body).toMatchObject({ event, severity: "CRITICAL", service: "systemd", code: "unit_failed", details: { unit } });
      }
    } finally { s.close(); }
  });
  it("rejects secret-shaped or malformed arguments without sending anything", async () => {
    const s = await sink();
    const dir = tmp();
    writeFileSync(join(dir, "alert.env"), `TWINS_ALERT_WEBHOOK_URL=${s.url}\n`);
    const env = { TWINS_ALERT_ENV_FILE: join(dir, "alert.env"), TWINS_ALERT_STATE_DIR: join(dir, "s") };
    try {
      for (const summary of ["token=abcd1234efgh", "postgresql://u:pw123456@db/x", "AGE-SECRET-KEY-1ABCDEF", `say "quote"`, "x".repeat(300), "Bearer abcdefghijklmnop12345"]) {
        const r = await run(ALERT, ["a.b", "CRITICAL", "svc", "code", summary], env);
        expect(r.out, summary).toMatch(/"event":"alert.invalid"/);
      }
      expect((await run(ALERT, ["Bad Event", "CRITICAL", "svc", "code", "ok"], env)).out).toMatch(/alert.invalid/);
      expect((await run(ALERT, ["a.b", "LOUD", "svc", "code", "ok"], env)).out).toMatch(/alert.invalid/);
      expect((await run(ALERT, ["a.b", "INFO", "svc", "bad code", "ok"], env)).out).toMatch(/alert.invalid/);
      expect(s.got).toEqual([]);
    } finally { s.close(); }
  });
  it("throttles repeats, logs 'undelivered' without a destination, refuses plain http to a non-loopback host, and --test reports delivery honestly", async () => {
    const s = await sink();
    const dir = tmp();
    writeFileSync(join(dir, "alert.env"), `TWINS_ALERT_WEBHOOK_URL=${s.url}\n`);
    const env = { TWINS_ALERT_ENV_FILE: join(dir, "alert.env"), TWINS_ALERT_STATE_DIR: join(dir, "state") };
    try {
      await run(ALERT, ["--throttle", "600", "a.b", "WARNING", "svc", "code", "first"], env);
      const second = await run(ALERT, ["--throttle", "600", "a.b", "WARNING", "svc", "code", "second"], env);
      expect(second.out).toMatch(/alert.suppressed/);
      expect(s.got).toHaveLength(1);
      expect((await run(ALERT, ["--test", "alert.test", "INFO", "svc", "test_event", "TEST ALERT - no action required"], env)).code).toBe(0);
      writeFileSync(join(dir, "none.env"), "TWINS_ENV_NAME=staging\n");
      const none = await run(ALERT, ["--test", "alert.test", "INFO", "svc", "test_event", "TEST"], { TWINS_ALERT_ENV_FILE: join(dir, "none.env") });
      expect(none.code).toBe(2);
      expect(none.out).toMatch(/no_destination_configured/);
      expect((await run(ALERT, ["a.b", "INFO", "svc", "code", "ok"], { TWINS_ALERT_ENV_FILE: join(dir, "none.env") })).code).toBe(0); // a missing destination never fails the job being reported
      writeFileSync(join(dir, "http.env"), "TWINS_ALERT_WEBHOOK_URL=http://hooks.example.com/abc\n");
      const http = await run(ALERT, ["--test", "a.b", "INFO", "svc", "code", "ok"], { TWINS_ALERT_ENV_FILE: join(dir, "http.env") });
      expect(http.code).toBe(2);
      expect(http.out).toMatch(/destination_must_be_https/);
    } finally { s.close(); }
    const dead = await sink(500);
    writeFileSync(join(dir, "dead.env"), `TWINS_ALERT_WEBHOOK_URL=${dead.url}\n`);
    try { expect((await run(ALERT, ["--test", "a.b", "INFO", "svc", "code", "ok"], { TWINS_ALERT_ENV_FILE: join(dir, "dead.env") })).code).toBe(1); } finally { dead.close(); }
  });
});

describe("twins-health-check.sh", () => {
  function fakeAlert(dir: string): { bin: string; log: string } {
    const bin = join(dir, "fake-alert.sh");
    const log = join(dir, "alerts.log");
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }
  const now = Math.floor(Date.now() / 1000);
  const calls = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  it("alerts on a failed or stale backup / audit verification and stays quiet when both are fresh and successful", async () => {
    const dir = tmp(); const mon = join(dir, "mon"); mkdirSync(join(mon, "audit"), { recursive: true });
    const { bin, log } = fakeAlert(dir);
    const env = { MONITOR_DIR: mon, ALERT_BIN: bin };
    writeFileSync(join(mon, "backup.json"), JSON.stringify({ ok: true, epoch: now - 3600 }));
    writeFileSync(join(mon, "audit/audit-verify.json"), JSON.stringify({ ok: true, epoch: now - 600, last_ok_epoch: now - 600 }));
    await run(HEALTH, [], env);
    expect(calls(log)).toEqual([]);
    writeFileSync(join(mon, "backup.json"), JSON.stringify({ ok: true, epoch: now - 40 * 3600 }));
    writeFileSync(join(mon, "audit/audit-verify.json"), JSON.stringify({ ok: false, epoch: now - 60, last_ok_epoch: now - 5 * 3600 }));
    await run(HEALTH, [], env);
    const c = calls(log).join("\n");
    expect(c).toMatch(/backup\.delayed WARNING twins-backup stale/);
    expect(c).toMatch(/audit\.verification_failed CRITICAL twins-audit-verify last_run_failed/);
    expect(c).toMatch(/audit\.verification_delayed WARNING twins-audit-verify stale/); // the last PASS was 5 h ago
    writeFileSync(join(mon, "backup.json"), JSON.stringify({ ok: false, epoch: now - 60 }));
    await run(HEALTH, [], env);
    expect(calls(log).join("\n")).toMatch(/backup\.failed CRITICAL twins-backup last_run_failed/);
    expect((await run(HEALTH, [], { MONITOR_DIR: join(dir, "missing"), ALERT_BIN: bin })).code).toBe(0); // never fails its unit
    expect(calls(log).join("\n")).toMatch(/no_status_file/);
  });
});

describe("twins-backup-verify.sh (weekly local verification)", () => {
  function setup() {
    const dir = tmp();
    const backups = join(dir, "backups"); const status = join(dir, "status"); mkdirSync(backups); mkdirSync(status);
    const plain = Buffer.from("PGDMP-synthetic-dump");
    const plainSha = createHash("sha256").update(plain).digest("hex");
    const enc = Buffer.from("encrypted-bytes-1");
    const name = "twins-staging-daily-20310101T020000Z.dump.enc";
    writeFileSync(join(backups, name), enc);
    writeFileSync(join(backups, `${name}.sha256`), `${createHash("sha256").update(enc).digest("hex")}  ${name}\n`);
    writeFileSync(join(status, "backup.json"), JSON.stringify({ ok: true, epoch: 1, detail: name, plain_sha256: plainSha }));
    const tool = join(dir, "enc.py");
    writeFileSync(tool, `import sys\nopen(sys.argv[4],'wb').write(open(sys.argv[3],'rb').read() and b'${plain.toString()}')\n`);
    const key = join(dir, "key"); writeFileSync(key, "k");
    const alertBin = join(dir, "alert.sh"); const alertLog = join(dir, "alerts.log");
    writeFileSync(alertBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${alertLog}'\n`); chmodSync(alertBin, 0o755);
    return { dir, backups, status, name, tool, key, alertBin, alertLog, env: { BACKUP_DIR: backups, STATUS_DIR: status, ENC_TOOL: tool, KEY_FILE: key, ALERT_BIN: alertBin, PYTHON: "python3" } };
  }
  it("passes when every retained backup matches its checksum and the newest decrypts to the recorded digest", async () => {
    const s = setup();
    const r = await run(VERIFY, [], s.env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/BACKUP VERIFY OK/);
    expect(JSON.parse(readFileSync(join(s.status, "backup-verify.json"), "utf8"))).toMatchObject({ ok: true, checked: 1, problems: 0 });
    expect(existsSync(s.alertLog)).toBe(false);
  });
  it("checksum mismatch -> exit 1, status ok:false, CRITICAL backup.checksum_mismatch", async () => {
    const s = setup();
    writeFileSync(join(s.backups, s.name), "bit rot");
    const r = await run(VERIFY, [], s.env);
    expect(r.code).toBe(1);
    expect(JSON.parse(readFileSync(join(s.status, "backup-verify.json"), "utf8"))).toMatchObject({ ok: false, detail: "checksum_mismatch" });
    expect(readFileSync(s.alertLog, "utf8")).toMatch(/backup\.checksum_mismatch CRITICAL twins-backup-verify checksum_mismatch/);
  });
  it("decrypt failure, plaintext digest mismatch and an empty backup directory each fail with a CRITICAL alert", async () => {
    const s = setup();
    writeFileSync(s.tool, "import sys\nsys.exit(3)\n");
    expect((await run(VERIFY, [], s.env)).code).toBe(1);
    expect(readFileSync(s.alertLog, "utf8")).toMatch(/backup\.verification_failed CRITICAL twins-backup-verify decrypt_failed/);
    const s2 = setup();
    writeFileSync(join(s2.status, "backup.json"), JSON.stringify({ ok: true, epoch: 1, detail: s2.name, plain_sha256: "0".repeat(64) }));
    expect((await run(VERIFY, [], s2.env)).code).toBe(1);
    expect(readFileSync(s2.alertLog, "utf8")).toMatch(/backup\.checksum_mismatch CRITICAL twins-backup-verify plaintext_digest_mismatch/);
    const s3 = setup();
    writeFileSync(join(s3.backups, "x"), ""); // directory without any backup file
    for (const f of [s3.name, `${s3.name}.sha256`]) unlinkSync(join(s3.backups, f));
    expect((await run(VERIFY, [], s3.env)).code).toBe(1);
    expect(readFileSync(s3.alertLog, "utf8")).toMatch(/no_local_backups/);
  });
});

describe("status surface fields (unit)", () => {
  const NOW = new Date("2031-01-01T01:00:00Z");
  const base = {
    now: () => NOW, startedAt: new Date("2031-01-01T00:00:00Z"), pingDatabase: async () => undefined, pingRedis: async () => undefined,
    readSafety: async () => ({ tradingEnabled: false, intakeEnabled: true, killSwitchActive: false, versions: { TRADING_ENABLED: 1, INTAKE_ENABLED: 1, KILL_SWITCH_ACTIVE: 1 } }),
    outboxCounts: async () => ({ PENDING: 2, FAILED: 1, PROCESSING: 1, DEAD_LETTER: 3, COMPLETED: 50 }), statusDir: undefined,
  };
  it("reports uptime, connectivity, the three controls and outbox counts; fails closed and degraded when a dependency is down, with fixed codes only", async () => {
    const ok = await buildStatus(base);
    expect(ok).toMatchObject({ status: "ok", uptimeSeconds: 3600, database: { ok: true }, redis: { ok: true }, runtimeState: { available: true, TRADING_ENABLED: false, INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }, outbox: { available: true, pending: 3, processing: 1, deadLetter: 3, completed: 50 }, lastSuccessfulBackupAt: null, lastSuccessfulAuditVerificationAt: null });
    const down = await buildStatus({ ...base, pingDatabase: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); }, readSafety: async () => { throw new Error("secret"); }, outboxCounts: async () => { throw new Error("secret"); } });
    expect(down).toMatchObject({ status: "degraded", database: { ok: false, code: "unavailable" }, runtimeState: { available: false, TRADING_ENABLED: false, INTAKE_ENABLED: false, KILL_SWITCH_ACTIVE: true }, outbox: { available: false } });
    expect(JSON.stringify(down)).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5|secret/);
  });
});
