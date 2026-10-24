import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/ops/capture-watch.sh";
const script = readFileSync(SCRIPT, "utf8");
const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("capture watcher (real-time, content-free)", () => {
  it("every stage of the event pipeline is line-buffered: grep --line-buffered then awk with fflush, never cut/sed/tr", () => {
    expect(code).toMatch(/grep --line-buffered -E "\$EVENTS" \| awk -v alert_log="\$ALERT_LOG" -v rx="\$ALERT_RX" '\{ line = substr\(\$0, 1, 200\); print line;/);
    expect(code).toMatch(/fflush\(\) \}'/);
    expect(code).not.toMatch(/\|\s*(cut|tr|sed|head|tail|sort|uniq)\b/); // block-buffered when writing to a pipe: the original bug was a trailing `cut`
  });
  it("watches exactly the capture events of interest and prints stop-condition anomalies", () => {
    for (const e of ["delivered", "alert", "queue_overflow", "delivery_retry", "session_restart", "protected_content_changed"]) expect(code).toContain(e);
    for (const a of ["ANOMALY OOM", "ANOMALY api restarted", "ANOMALY worker restarted", "ANOMALY api 5xx", "STATE capture"]) expect(code).toContain(a);
  });
  it("streams an event IMMEDIATELY (well before the source stream ends) and drops lines that are not events", async () => {
    const start = Math.floor(Date.now() / 1000);
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      START_EPOCH: String(start),
      DURATION: "6",
      WATCH_NO_STATE: "1",
      // two event lines and one noise line, then the stream stays open for 4 more seconds
      WATCH_LOG_CMD: `printf '%s\\n' '{"event": "capture.connection", "state": "x"}' '{"event": "capture.delivered", "kind": "message", "status": 200}'; sleep 4; printf '%s\\n' '{"event": "capture.alert", "reason": "flood_wait"}'`,
    };
    const child = spawn("bash", [SCRIPT], { env });
    let out = "";
    let firstAt = 0;
    child.stdout.on("data", (d: Buffer) => {
      if (firstAt === 0) firstAt = Date.now();
      out += d.toString();
    });
    const t0 = Date.now();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(firstAt - t0).toBeLessThan(2000); // the delivered line arrived long before the 4 s source sleep ended
    expect(out).toContain('"event": "capture.delivered"');
    expect(out).toContain('"event": "capture.alert"');
    expect(out).not.toContain("capture.connection");
    expect(out).toContain("DEADLINE reached");
  }, 20000);
  it("appends alert lines (and only alert lines) to ALERT_LOG with a UTC timestamp, while still streaming everything", async () => {
    const { mkdtempSync, readFileSync: read } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/twins-watch-`);
    const alertLog = `${dir}/alerts.log`;
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      START_EPOCH: String(Math.floor(Date.now() / 1000)),
      DURATION: "3",
      WATCH_NO_STATE: "1",
      ALERT_LOG: alertLog,
      WATCH_LOG_CMD: `printf '%s\\n' '{"event": "capture.delivered", "kind": "message", "status": 200}' '{"event": "capture.alert", "reason": "flood_wait"}' '{"event": "capture.session_restart", "reason": "recoverable"}'`,
    };
    const child = spawn("bash", [SCRIPT], { env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(out).toContain("capture.delivered");
    const lines = read(alertLog, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // the alert and the session restart; the delivery is not an alert
    for (const l of lines) expect(l).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z \{"event": "capture\.(alert|session_restart)"/);
  }, 20000);
  it("state changes are emitted once (not on every poll) and restarts of the capture container are reported", () => {
    expect(code).toContain('if [ "$cs" != "$last_cs" ]; then emit "STATE capture: $cs"; last_cs="$cs"; fi');
    expect(code).toContain("emit() {");
    expect(code).toContain('ALERT_RX=\'capture[.](alert|'); // a bracket expression: awk warns about a backslash-dot inside -v assignments
    expect(code).toContain('oom_seen="$oom_seen $n"'); // an OOM anomaly is reported once per service, not every poll
  });
  it("never prints message content: it only forwards lines that are capture events (whose fields are whitelisted by the client) and truncates them", () => {
    expect(code).toContain("substr($0, 1, 200)");
  });
});
