import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/twins-capture-gap-check.sh";
const NOW = 2_000_000_000;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "twins-gap-"));
  const bin = join(dir, "bin");
  const monitor = join(dir, "monitor");
  mkdirSync(bin);
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // docker: `inspect` prints STUB_STATE (or fails for "missing"); `exec ... psql` prints STUB_LAST (or fails for "fail")
  stub("docker", `case "$1" in
  inspect) [ "$STUB_STATE" = missing ] && exit 1; echo "$STUB_STATE";;
  exec) [ "$STUB_LAST" = fail ] && exit 1; echo "$STUB_LAST";;
esac`);
  const alertLog = join(dir, "alerts.log");
  stub("alert", `printf '%s\\n' "$*" >> "${alertLog}"`);
  const run = (env: Record<string, string>) => spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, DOCKER: "docker", ALERT_BIN: join(bin, "alert"), MONITOR_DIR: monitor, TWINS_NOW: String(NOW), ...env } });
  const alerts = (): string[] => (existsSync(alertLog) ? readFileSync(alertLog, "utf8").trim().split("\n").filter(Boolean) : []);
  const status = (): Record<string, unknown> => JSON.parse(readFileSync(join(monitor, "capture-gap.json"), "utf8"));
  return { run, alerts, status, monitor };
}

describe("twins-capture-gap-check.sh (host capture-gap detector)", () => {
  it("a running client with a recent message raises nothing and writes an ok status (mode 0600)", () => {
    const sb = sandbox();
    const r = sb.run({ STUB_STATE: "running", STUB_LAST: String(NOW - 3600) });
    expect(r.status).toBe(0);
    expect(sb.alerts()).toEqual([]);
    expect(sb.status()).toMatchObject({ ok: true, state: "running", reason: "", ageSeconds: 3600 });
    expect(statSync(join(sb.monitor, "capture-gap.json")).mode & 0o777).toBe(0o600);
  });
  it("a quiet channel inside the window is fine; beyond it raises CRITICAL telegram.capture_gap with ageSeconds / windowSeconds / reason only", () => {
    const sb = sandbox();
    expect(sb.run({ STUB_STATE: "running", STUB_LAST: String(NOW - 9 * 86400) }).status).toBe(0); // a real 9-day silence in October
    expect(sb.alerts()).toEqual([]);
    sb.run({ STUB_STATE: "running", STUB_LAST: String(NOW - 15 * 86400) });
    const a = sb.alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("telegram.capture_gap CRITICAL twins-capture-gap no_capture_in_window");
    expect(a[0]).toContain(`--detail ageSeconds=${15 * 86400}`);
    expect(a[0]).toContain("--detail windowSeconds=1209600");
    expect(a[0]).toContain("--detail reason=no_capture_in_window");
    expect(a[0]).toContain("--throttle 21600");
    expect(a[0]).not.toMatch(/token|password|text/i);
    expect(sb.status()).toMatchObject({ ok: false, reason: "no_capture_in_window" });
  });
  it("a stopped client is only an alert after the grace period: first sighting records 'down since', a later run past the grace raises client_not_running; recovery clears it", () => {
    const sb = sandbox();
    sb.run({ STUB_STATE: "exited", STUB_LAST: String(NOW), TWINS_NOW: String(NOW) });
    expect(sb.alerts()).toEqual([]); // just noticed
    sb.run({ STUB_STATE: "exited", STUB_LAST: String(NOW), TWINS_NOW: String(NOW + 600) });
    expect(sb.alerts()).toEqual([]); // 10 minutes: inside the 15-minute grace
    sb.run({ STUB_STATE: "exited", STUB_LAST: String(NOW), TWINS_NOW: String(NOW + 1000) });
    expect(sb.alerts()).toHaveLength(1);
    expect(sb.alerts()[0]).toContain("client_not_running");
    expect(sb.alerts()[0]).toContain("--detail ageSeconds=1000");
    sb.run({ STUB_STATE: "running", STUB_LAST: String(NOW + 1100), TWINS_NOW: String(NOW + 1100) });
    expect(existsSync(join(sb.monitor, "capture-gap.state"))).toBe(false); // recovered
    expect(sb.status()).toMatchObject({ ok: true });
    sb.run({ STUB_STATE: "exited", STUB_LAST: String(NOW), TWINS_NOW: String(NOW + 1200) });
    expect(sb.alerts()).toHaveLength(1); // the clock restarted: no new alert yet
  });
  it("a missing container and a restarting one count as not running", () => {
    for (const state of ["missing", "restarting", "dead", "created"]) {
      const sb = sandbox();
      sb.run({ STUB_STATE: state, STUB_LAST: String(NOW) });
      sb.run({ STUB_STATE: state, STUB_LAST: String(NOW), TWINS_NOW: String(NOW + 901) });
      expect(sb.alerts(), state).toHaveLength(1);
    }
  });
  it("an unreadable database does not raise a false gap (the age check is skipped and logged), but a stopped client still does", () => {
    const sb = sandbox();
    const r = sb.run({ STUB_STATE: "running", STUB_LAST: "fail" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("capture_gap.age_unknown");
    expect(sb.alerts()).toEqual([]);
    sb.run({ STUB_STATE: "exited", STUB_LAST: "fail" });
    sb.run({ STUB_STATE: "exited", STUB_LAST: "fail", TWINS_NOW: String(NOW + 2000) });
    expect(sb.alerts()).toHaveLength(1);
  });
  it("a database with no captured message at all is a gap; thresholds are configurable; malformed configuration is refused without an alert", () => {
    const sb = sandbox();
    sb.run({ STUB_STATE: "running", STUB_LAST: "0" });
    expect(sb.alerts()).toHaveLength(1);
    const tuned = sandbox();
    tuned.run({ STUB_STATE: "running", STUB_LAST: String(NOW - 7200), TWINS_CAPTURE_GAP_WINDOW_SECONDS: "3600" });
    expect(tuned.alerts()[0]).toContain("--detail windowSeconds=3600");
    const bad = sandbox();
    const r = bad.run({ STUB_STATE: "running", STUB_LAST: "0", TWINS_CAPTURE_GAP_WINDOW_SECONDS: "abc" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("capture_gap.bad_config");
    expect(bad.alerts()).toEqual([]);
  });
  it("the units are read-only, alert on failure, and run every 10 minutes", () => {
    const service = readFileSync("infrastructure/staging/twins-capture-gap-check.service", "utf8");
    const timer = readFileSync("infrastructure/staging/twins-capture-gap-check.timer", "utf8");
    expect(service).toMatch(/OnFailure=twins-alert-on-failure@%n\.service/);
    expect(service).toMatch(/ExecStart=\/usr\/local\/sbin\/twins-capture-gap-check$/m);
    expect(service).toMatch(/Type=oneshot/);
    expect(timer).toMatch(/OnCalendar=\*:0\/10/);
    expect(timer).toMatch(/Unit=twins-capture-gap-check\.service/);
    const script = readFileSync(SCRIPT, "utf8");
    expect(script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(/\b(docker (stop|start|restart|rm|kill|compose)|systemctl|UPDATE|INSERT|DELETE)\b/);
  });
  it("the alert it raises is accepted by the real twins-alert.sh contract (event, severity, allowed detail keys)", () => {
    const alertSh = readFileSync("infrastructure/staging/twins-alert.sh", "utf8");
    for (const key of ["ageSeconds", "windowSeconds", "reason"]) expect(alertSh).toMatch(new RegExp(`ALLOWED_KEYS=.* ${key} `));
    expect("telegram.capture_gap").toMatch(/^[a-z][a-z0-9_.]{1,60}$/);
  });
});
