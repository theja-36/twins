import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/capture-egress-firewall.sh";
const CIDRS = "infrastructure/staging/telegram-cidr-ipv4.txt";
const script = readFileSync(SCRIPT, "utf8");
const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // comments describe what the script does NOT touch
const dry = (args: string[]) => execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DRY_RUN: "1" } });

describe("capture egress firewall script", () => {
  it("the CIDR file holds exactly the recorded Telegram IPv4 ranges (pinned hash)", () => {
    const text = readFileSync(CIDRS, "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe("e03cdce9ba86e0c7b4a689f5a1574d24c5f4689bef8a5518f0e9bdbb84a265c5");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(9);
    for (const l of lines) expect(l).toMatch(/^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/);
  });
  it("apply builds ONE dedicated chain (ACCEPT per range on tcp/443, LOG, final DROP) and inserts the single jump LAST", () => {
    const out = dry(["apply", CIDRS]).trim().split("\n");
    expect(out[0]).toBe("iptables -N TWINS-CAPTURE-EGRESS");
    expect(out.filter((l) => /-j ACCEPT$/.test(l))).toHaveLength(9);
    for (const l of out.filter((x) => /-j ACCEPT$/.test(x))) expect(l).toMatch(/^iptables -A TWINS-CAPTURE-EGRESS -d [0-9./]+ -p tcp --dport 443 /);
    expect(out[out.length - 2]).toMatch(/-j DROP$/);
    expect(out[out.length - 1]).toBe("iptables -I DOCKER-USER 1 -s 10.0.24.0/24 -j TWINS-CAPTURE-EGRESS"); // jump only after the chain is complete: no fail-open window
    expect(out.every((l) => l.startsWith("iptables -N TWINS-CAPTURE-EGRESS") || /TWINS-CAPTURE-EGRESS|DOCKER-USER 1 -s 10\.0\.24\.0\/24/.test(l))).toBe(true);
  });
  it("remove deletes only the jump and the dedicated chain", () => {
    expect(dry(["remove"]).trim().split("\n")).toEqual([
      "iptables -D DOCKER-USER -s 10.0.24.0/24 -j TWINS-CAPTURE-EGRESS",
      "iptables -F TWINS-CAPTURE-EGRESS",
      "iptables -X TWINS-CAPTURE-EGRESS",
    ]);
  });
  it("never touches other chains, policies, tables, ufw or flushes DOCKER-USER; refuses malformed lists", () => {
    expect(code).not.toMatch(/-F DOCKER-USER|-P |-t nat|ufw|iptables -F\b(?! )|--flush|-X DOCKER|-I INPUT|-A INPUT|-A FORWARD|restore/);
    const bad = "/tmp/twins-bad-cidr.txt";
    execFileSync("bash", ["-c", `printf '1.2.3.4/33\\n' > ${bad}`]);
    expect(() => dry(["apply", bad])).toThrow();
    expect(script).toContain('SUBNET="10.0.24.0/24"');
    expect(script).toContain('PORT="443"');
  });
  it("the compose egress subnet and the script subnet agree", () => {
    expect(readFileSync("infrastructure/staging/docker-compose.staging.yml", "utf8")).toContain("subnet: 10.0.24.0/24");
  });
});
