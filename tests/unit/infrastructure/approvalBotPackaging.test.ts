import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const compose = read("infrastructure/staging/docker-compose.staging.yml");
const service = (name: string) => {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_-]+:\\n|\\nnetworks:)`).exec(compose);
  if (!m) throw new Error(`service ${name} not found`);
  return m[1]!.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
};

describe("approval-bot compose service", () => {
  const b = service("approval-bot");
  it("is off by default (profile), hardened, read-only, restart unless-stopped, no published ports", () => {
    expect(b).toMatch(/profiles: \["bot"\]/);
    expect(b).toContain("<<: *hardening");
    expect(b).not.toMatch(/\bports:/);
    expect(b).not.toMatch(/read_only: false/);
    expect(b).toContain('command: ["node", "--import", "tsx", "/app/services/approval-bot/src/index.ts", "run"]');
  });
  it("gets its secrets only from the optional host file bot.env, with no secret literal and no staging credentials", () => {
    expect(b).toMatch(/env_file:\s*\n\s*- path: \.\/bot\.env\s*\n\s*required: false/);
    expect(b).not.toMatch(/POSTGRES_PASSWORD|REDIS_PASSWORD|TWINS_API_KEY|TWINS_CAPTURE|TELEGRAM_WEBHOOK_SECRET|DATABASE_URL|TWINS_BOT_(?:TOKEN|HMAC_KEY|ACTIVE)/);
    for (const name of ["api", "worker", "postgres", "redis", "scheduler", "migrate", "capture"]) {
      expect(service(name), name).not.toMatch(/bot\.env|TWINS_BOT_/);
    }
  });
  it("is on the data network and its own egress network only; no other service uses that egress network", () => {
    expect(b).toContain("networks: [twins_data, twins_bot_egress]");
    for (const name of ["api", "worker", "postgres", "redis", "scheduler", "migrate", "capture"]) expect(service(name), name).not.toMatch(/twins_bot_egress/);
    expect(b).not.toMatch(/coolify|twins_edge|twins_egress\b/);
    expect(compose).toContain("subnet: 10.0.25.0/24");
  });
  it("uses an optional own image tag falling back to the shared one, never pulls", () => {
    expect(b).toContain("image: twins-staging:${TWINS_BOT_IMAGE_TAG:-${TWINS_IMAGE_TAG:-local}}");
    expect(b).toContain("pull_policy: never");
  });
  it("bot.env is ignored by git and the example holds no values", () => {
    expect(read(".gitignore")).toContain("infrastructure/staging/bot.env");
    const example = read("infrastructure/staging/bot.env.example");
    for (const line of example.split("\n").filter((l) => /^TWINS_BOT_[A-Z_]+=/.test(l))) {
      const [k, v] = line.split("=");
      expect(v, k).toBe(k === "TWINS_BOT_ACTIVE" ? "false" : "");
    }
    expect(example).toContain("TWINS_BOT_TOKEN=");
  });
});

describe("approval-bot egress firewall", () => {
  const SCRIPT = "infrastructure/staging/bot-egress-firewall.sh";
  const CIDRS = "infrastructure/staging/telegram-cidr-ipv4.txt";
  const dry = (args: string[]) => execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DRY_RUN: "1" } });
  it("has its own chain and subnet, and does not share anything with the capture firewall", () => {
    const out = dry(["apply", CIDRS]).trim().split("\n");
    expect(out[0]).toBe("iptables -N TWINS-BOT-EGRESS");
    expect(out[out.length - 1]).toBe("iptables -I DOCKER-USER 1 -s 10.0.25.0/24 -j TWINS-BOT-EGRESS");
    expect(out.filter((l) => /-j ACCEPT$/.test(l))).toHaveLength(9);
    expect(out.join("\n")).not.toMatch(/CAPTURE|10\.0\.24/);
    expect(dry(["remove"]).trim().split("\n")).toEqual([
      "iptables -D DOCKER-USER -s 10.0.25.0/24 -j TWINS-BOT-EGRESS",
      "iptables -F TWINS-BOT-EGRESS",
      "iptables -X TWINS-BOT-EGRESS",
    ]);
  });
  it("is the capture script with only its identity changed (same rules, same checks)", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n")
        .replace(/10\.0\.2[45]\.0\/24/g, "SUBNET")
        .replace(/TWINS-(?:CAPTURE|BOT)-EGRESS/g, "CHAIN")
        .replace(/twins-(?:capture|bot)/g, "twins-T")
        .replace(/\((?:capture|bot) stopped\)/g, "(X stopped)");
    expect(strip(read(SCRIPT))).toBe(strip(read("infrastructure/staging/capture-egress-firewall.sh")));
  });
  it("the systemd unit applies, verifies and removes with the bot script", () => {
    const unit = read("infrastructure/staging/twins-bot-egress-firewall.service");
    expect(unit).toMatch(/^ExecStart=\/opt\/twins-staging\/bot-egress-firewall\.sh apply \/opt\/twins-staging\/telegram-cidr-ipv4\.txt$/m);
    expect(unit).toMatch(/^ExecStartPost=\/opt\/twins-staging\/bot-egress-firewall\.sh status /m);
    expect(unit).toMatch(/^ExecStop=\/opt\/twins-staging\/bot-egress-firewall\.sh remove$/m);
    expect(unit).not.toMatch(/capture-egress-firewall|10\.0\.24/);
  });
});
