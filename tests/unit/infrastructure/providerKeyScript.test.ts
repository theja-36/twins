import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/twins-set-provider-key.sh";
const FAKE = "abcdefghijklmnopqrstuvwxyz012345"; // a made-up 32-character value, not a real key
const sandbox = () => { const dir = mkdtempSync(join(tmpdir(), "provkey-")); return { dir, file: join(dir, "providers.env") }; };
const run = (file: string, input: string, args: string[] = []) => spawnSync("bash", [SCRIPT, ...args], { input, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", PROVIDERS_ENV_FILE: file } });

describe("twins-set-provider-key.sh", () => {
  it("creates the file with mode 600 and one TWINS_FRED_API_KEY line, and never prints the key", () => {
    const s = sandbox(); const r = run(s.file, FAKE + "\n");
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(s.file, "utf8")).toBe(`TWINS_FRED_API_KEY=${FAKE}\n`); expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(FAKE); expect(r.stdout).toMatch(/^OK: the FRED key was saved to providers\.env \(key length 32, file mode 600,/);
    expect(readdirSync(s.dir)).toEqual(["providers.env"]); // no temp file left behind
  });
  it("replaces only its own line and keeps every other setting, comments included, without duplicating", () => {
    const s = sandbox(); writeFileSync(s.file, "# provider settings\nTWINS_PROVIDERS_WATCH=[]\nTWINS_FRED_API_KEY=oldoldoldoldoldoldold12\nTWINS_HOLIDAYS_MARKET=NSE\n", { mode: 0o644 });
    const r = run(s.file, FAKE);
    expect(r.status, r.stderr).toBe(0);
    const t = readFileSync(s.file, "utf8"); expect(t.split("\n").filter(Boolean)).toEqual(["# provider settings", "TWINS_PROVIDERS_WATCH=[]", "TWINS_HOLIDAYS_MARKET=NSE", `TWINS_FRED_API_KEY=${FAKE}`]);
    expect(t).not.toContain("oldold"); expect(statSync(s.file).mode & 0o777).toBe(0o600); expect(r.stdout).toContain("other settings kept: 3 line(s)");
  });
  it("accepts a trailing carriage return (Windows-style paste) and no trailing newline", () => {
    const s = sandbox(); expect(run(s.file, FAKE + "\r\n").status).toBe(0); expect(readFileSync(s.file, "utf8")).toBe(`TWINS_FRED_API_KEY=${FAKE}\n`);
    const t = sandbox(); expect(run(t.file, FAKE).status).toBe(0);
  });
  it("refuses anything that is not key-shaped and changes nothing (the bad value is not echoed)", () => {
    for (const bad of ["", "short", "has space in it 12345678901234567890", "semi;colon;semi;colon;semi;colon;123", "x".repeat(65), "key=with=equals1234567890123456", "$(touch /tmp/pwned)abcdefghijklmnop"]) {
      const s = sandbox(); writeFileSync(s.file, "KEEP=1\n"); const r = run(s.file, bad + "\n");
      expect(r.status, JSON.stringify(bad)).not.toBe(0); expect(readFileSync(s.file, "utf8")).toBe("KEEP=1\n"); if (bad.length > 3) expect(r.stdout + r.stderr).not.toContain(bad);
    }
    expect(existsSync("/tmp/pwned")).toBe(false);
  });
  it("takes no arguments (the key can never be a command-line argument) and refuses a missing folder", () => {
    const s = sandbox(); const r = run(s.file, FAKE, [FAKE]); expect(r.status).toBe(2); expect(existsSync(s.file)).toBe(false);
    expect(run(join(s.dir, "nope", "providers.env"), FAKE).status).toBe(4);
  });
  it("the script text never traces, echoes or passes the key as an argument", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/set -x|set -o xtrace|echo\s+["']?\$\{?KEY|printf[^\n]*\$\{?KEY[^\n]*>&2|\bcurl\b|\bwget\b|\bps\b/);
    expect(code).toContain("read -r -t 60 KEY"); expect(code).toMatch(/printf '%s=%s\\n' "\$VAR" "\$KEY" >> "\$tmp"/);
  });
});
