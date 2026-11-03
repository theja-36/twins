import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/twins-kite-token-check.sh";
const TOKEN = "acc_token_0123456789abcdef";
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "twins-kt-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const alertLog = join(dir, "alerts.log");
  writeFileSync(join(bin, "alert"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${alertLog}"\n`); chmodSync(join(bin, "alert"), 0o755);
  const tokenFile = join(dir, "kite-token.json");
  const write = (issuedAt: string, mode = 0o600) => { writeFileSync(tokenFile, JSON.stringify({ accessToken: TOKEN, issuedAt, apiKeyFingerprint: "0123456789ab" }), { mode }); chmodSync(tokenFile, mode); };
  const run = (nowIso: string, extra: Record<string, string> = {}) => spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ALERT_BIN: join(bin, "alert"), MONITOR_DIR: join(dir, "mon"), TWINS_KITE_TOKEN_FILE: tokenFile, TWINS_NOW: String(Math.floor(Date.parse(nowIso) / 1000)), ...extra } });
  const alerts = (): string[] => (existsSync(alertLog) ? readFileSync(alertLog, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, tokenFile, write, run, alerts, status: () => JSON.parse(readFileSync(join(dir, "mon", "kite-token.json"), "utf8")) as Record<string, unknown> };
}

describe("twins-kite-token-check.sh (opt-in morning check; metadata only)", () => {
  it("a token issued the previous day after market hours is fine at 08:30 IST the next morning only if it has not passed 06:00 IST: it has, so it is expired", () => {
    const s = sandbox();
    s.write("2026-11-02T10:00:00.000Z"); // 15:30 IST Monday
    s.run("2026-11-03T03:00:00Z");       // 08:30 IST Tuesday: past Tuesday 06:00 IST
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toContain("kite.session_invalidated CRITICAL twins-kite-token token_expired");
    expect(s.alerts()[0]).toContain("--detail reason=token_expired");
    expect(s.status()).toMatchObject({ ok: false, reason: "token_expired" });
  });
  it("a token issued this morning (after 06:00 IST) is fine; one issued at 05:00 IST is expired by 06:00", () => {
    const s = sandbox();
    s.write("2026-11-03T02:30:00.000Z"); // 08:00 IST today
    s.run("2026-11-03T03:00:00Z");
    expect(s.alerts()).toEqual([]);
    expect(s.status()).toMatchObject({ ok: true, reason: "" });
    const early = sandbox();
    early.write("2026-11-02T23:30:00.000Z"); // 05:00 IST Tuesday
    early.run("2026-11-03T03:00:00Z");
    expect(early.alerts()[0]).toContain("token_expired");
  });
  it("missing file, group-readable file, symlink and garbage are each reported with their own reason", () => {
    const missing = sandbox(); missing.run("2026-11-03T03:00:00Z");
    expect(missing.alerts()[0]).toContain("token_missing");
    const open = sandbox(); open.write("2026-11-03T02:30:00.000Z", 0o640); open.run("2026-11-03T03:00:00Z");
    expect(open.alerts()[0]).toContain("unsafe_permissions");
    const link = sandbox(); writeFileSync(join(link.dir, "real.json"), "{}", { mode: 0o600 }); symlinkSync(join(link.dir, "real.json"), link.tokenFile); link.run("2026-11-03T03:00:00Z");
    expect(link.alerts()[0]).toContain("unsafe_permissions");
    const junk = sandbox(); writeFileSync(junk.tokenFile, "not json", { mode: 0o600 }); junk.run("2026-11-03T03:00:00Z");
    expect(junk.alerts()[0]).toContain("token_unreadable");
  });
  it("the token value never reaches the alert, the log or the status; the script exits 0; units are weekday-only and alert on failure", () => {
    const s = sandbox(); s.write("2026-11-02T10:00:00.000Z");
    const r = s.run("2026-11-03T03:00:00Z", { TWINS_KITE_TOKEN_THROTTLE_SECONDS: "60" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr + s.alerts().join("") + JSON.stringify(s.status())).not.toContain(TOKEN);
    expect(s.alerts()[0]).toContain("--throttle 60");
    const timer = readFileSync("infrastructure/staging/twins-kite-token-check.timer", "utf8");
    expect(timer).toMatch(/OnCalendar=Mon\.\.Fri 03:00:00 UTC/);
    expect(readFileSync("infrastructure/staging/twins-kite-token-check.service", "utf8")).toMatch(/OnFailure=twins-alert-on-failure@%n\.service/);
    const alertSh = readFileSync("infrastructure/staging/twins-alert.sh", "utf8");
    expect(alertSh).toMatch(/ALLOWED_KEYS=.* reason /);
    expect(readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(/\bcat "\$TOKEN_FILE"|accessToken/);
  });
  it("bad configuration is refused quietly", () => {
    const s = sandbox(); s.write("2026-11-03T02:30:00.000Z");
    const r = s.run("2026-11-03T03:00:00Z", { TWINS_KITE_TOKEN_THROTTLE_SECONDS: "abc" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kite_token.bad_config");
    expect(s.alerts()).toEqual([]);
  });
});
