import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sh = readFileSync("infrastructure/staging/twins-kite-preflight.sh", "utf8");
const code = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("twins-kite-preflight.sh (read-only host checklist)", () => {
  it("is read-only: no network client, no login/exchange, no start/stop/write verbs", () => {
    expect(code).not.toMatch(/\b(curl|wget|nc|ncat|ssh|scp)\b/);
    expect(code).not.toMatch(/kite-login|kite-ticker (run|check)|compose .* up|docker (start|stop|restart|run|rm|compose)/);
    expect(code).not.toMatch(/\b(rm|mv|cp|tee|chmod|chown|sed -i|systemctl|iptables|ipset)\b/);
    expect(code).not.toMatch(/>\s*\/(var|etc|opt|usr)/);
  });
  it("never prints a secret: kite.env is read for variable names and the plan only, the token file only for its timestamp", () => {
    expect(code).not.toMatch(/cat\s+"?\$?\{?(KENV|TOKEN_FILE)/);
    expect(code).toContain("sed -E 's/=.*//'");
    expect(code).toMatch(/grep -E '\^TWINS_KITE_PLAN='/);
    expect(code).toContain("issuedAt");
    expect(code).not.toMatch(/accessToken|access_token|API_SECRET\)|echo.*API_KEY/i);
  });
  it("is informational: always exits 0 and prints PASS / WARN / FAIL with a summary", () => {
    expect(code).toMatch(/exit 0\s*$/);
    expect(sh).toContain("DO NOT START THE FEED");
    for (const w of ["PASS", "WARN", "FAIL", "SUMMARY"]) expect(sh).toContain(w);
    expect(sh).toContain("set -uo pipefail");
  });
  it("checks the safety flags exactly: LIVE false, paper false, enforcing unset, shadow true", () => {
    expect(sh).toContain('"LIVE=false PAPER=false ENFORCE= SHADOW=true"');
  });
});
