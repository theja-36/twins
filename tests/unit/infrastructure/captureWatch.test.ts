import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/ops/capture-watch.sh";
const script = readFileSync(SCRIPT, "utf8");
const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("capture watcher (real-time, content-free)", () => {
  it("every stage of the event pipeline is line-buffered: grep --line-buffered then awk with fflush, never cut/sed/tr", () => {
    expect(code).toMatch(/grep --line-buffered -E "\$EVENTS" \| awk '\{ print substr\(\$0, 1, 200\); fflush\(\) \}'/);
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
  it("never prints message content: it only forwards lines that are capture events (whose fields are whitelisted by the client) and truncates them", () => {
    expect(code).toContain("substr($0, 1, 200)");
  });
});
