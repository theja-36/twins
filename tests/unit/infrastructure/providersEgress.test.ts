import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/twins-providers-egress.sh";
const START = "infrastructure/staging/twins-providers-start.sh";
const T0 = 2_000_000_000;
const API = ["34.120.1.10", "34.120.1.11"]; // api.gdeltproject.org (illustrative public addresses)
const WS = ["23.45.67.89", "23.45.67.90"]; // api.stlouisfed.org (illustrative public addresses)

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "twins-egress-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const answers = join(dir, "answers"); mkdirSync(answers);
  const resolver = join(bin, "resolve-stub");
  writeFileSync(resolver, `#!/bin/bash\ncat "${answers}/$1.txt" 2>/dev/null || exit 1\n`); chmodSync(resolver, 0o755);
  const alertLog = join(dir, "alerts.log");
  writeFileSync(join(bin, "alert"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${alertLog}"\n`); chmodSync(join(bin, "alert"), 0o755);
  const answer = (host: string, ips: string[] | null) => { if (ips === null) writeFileSync(join(answers, `${host}.txt`), "", { mode: 0o600 }); else writeFileSync(join(answers, `${host}.txt`), ips.join("\n") + "\n"); };
  const missing = (host: string) => { try { writeFileSync(join(answers, `${host}.txt`), ""); } catch { /* */ } };
  const run = (args: string[], now = T0, extra: Record<string, string> = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, DRY_RUN: "1", RESOLVER: resolver, MONITOR_DIR: join(dir, "mon"), ALERT_BIN: join(bin, "alert"), TWINS_NOW: String(now), ...extra } });
  const alerts = (): string[] => (existsSync(alertLog) ? readFileSync(alertLog, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, answer, missing, run, alerts, status: () => JSON.parse(readFileSync(join(dir, "mon", "providers-egress.json"), "utf8")) as Record<string, unknown>, bin };
}
const up = (s: ReturnType<typeof sandbox>) => { s.answer("api.gdeltproject.org", API); s.answer("api.stlouisfed.org", WS); };

describe("twins-providers-egress.sh (dry run: nothing touches iptables or ipset, nothing resolves a real name)", () => {
  it("apply prints the exact commands: set, refresh first, ONE chain (replies, set rule on tcp/443, LOG, final DROP), the jump LAST", () => {
    const s = sandbox(); up(s);
    const r = s.run(["apply"]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.trim().split("\n");
    expect(out[0]).toBe("ipset create twins_prov_dst hash:ip timeout 600 -exist");
    const adds = out.filter((l) => l.startsWith("ipset add"));
    expect(out.some((l) => l.startsWith("refresh ok"))).toBe(true);
    expect(adds.sort()).toEqual([...API, ...WS].sort().map((ip) => `ipset add twins_prov_dst ${ip} timeout 600 -exist`));
    expect(out.indexOf(adds[0] as string)).toBeLessThan(out.findIndex((l) => l.includes("-N TWINS-PROVIDERS-EGRESS"))); // the set is filled BEFORE the chain can drop anything
    const chain = out.filter((l) => l.startsWith("iptables"));
    expect(chain[0]).toBe("iptables -w 5 -N TWINS-PROVIDERS-EGRESS");
    expect(chain[1]).toContain("--ctstate ESTABLISHED,RELATED");
    expect(chain[2]).toMatch(/-A TWINS-PROVIDERS-EGRESS -p tcp --dport 443 -m set --match-set twins_prov_dst dst .* -j ACCEPT$/);
    expect(chain[3]).toContain("-j LOG");
    expect(chain[4]).toMatch(/-j DROP$/);
    expect(chain[5]).toBe("iptables -w 5 -I DOCKER-USER 1 -s 10.0.29.0/24 -j TWINS-PROVIDERS-EGRESS"); // last: no fail-open window
    expect(chain).toHaveLength(6);
    expect(s.run(["apply"]).status).toBe(3); // refuses to touch an existing chain
  });
  it("remove deletes only the jump, the chain and the set (full rollback)", () => {
    const s = sandbox(); up(s);
    s.run(["apply"]);
    const r = s.run(["remove"]);
    expect(r.stdout.trim().split("\n")).toEqual(["iptables -w 5 -D DOCKER-USER -s 10.0.29.0/24 -j TWINS-PROVIDERS-EGRESS", "iptables -w 5 -F TWINS-PROVIDERS-EGRESS", "iptables -w 5 -X TWINS-PROVIDERS-EGRESS", "ipset destroy twins_prov_dst"]);
    expect(s.run(["status"]).status).toBe(1); // nothing applied any more
    expect(s.run(["apply"]).status).toBe(0);  // and it can be applied again
  });
  it("what is allowed and blocked: only the resolved addresses on tcp/443; any other address, port, private or loopback address is blocked", () => {
    const s = sandbox(); up(s);
    s.run(["apply"]);
    for (const ip of [...API, ...WS]) expect(s.run(["simulate", ip, "443"]).stdout.trim(), ip).toBe(`ALLOW ${ip}:443`);
    expect(s.run(["simulate", "34.120.1.10", "80"]).stdout.trim()).toBe("BLOCK 34.120.1.10:80");
    expect(s.run(["simulate", "8.8.8.8", "443"]).stdout.trim()).toBe("BLOCK 8.8.8.8:443");
    expect(s.run(["simulate", "10.0.1.5", "443"]).stdout.trim()).toBe("BLOCK 10.0.1.5:443");
    expect(s.run(["simulate", "127.0.0.1", "443"]).stdout.trim()).toBe("BLOCK 127.0.0.1:443");
  });
  it("status (the start-up check) passes only when applied, filled and freshly refreshed", () => {
    const s = sandbox(); up(s);
    expect(s.run(["status"]).stdout).toContain("MISSING");
    s.run(["apply"]);
    const ok = s.run(["status"], T0 + 10);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("OK: 4 active addresses");
    expect(s.run(["status"], T0 + 300).status).toBe(0);      // exactly at the limit
    const stale = s.run(["status"], T0 + 301);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("STALE");
  });
  it("rotation: a new address after a refresh is allowed at once, old addresses stay allowed until their 10 minutes are over, then they are blocked", () => {
    const s = sandbox(); up(s);
    s.run(["apply"]);
    s.answer("api.stlouisfed.org", ["23.45.67.90", "3.7.7.7"]); // 23.45.67.89 rotated away
    s.run(["refresh"], T0 + 30);
    expect(s.run(["simulate", "3.7.7.7"], T0 + 31).stdout).toContain("ALLOW");
    expect(s.run(["simulate", "23.45.67.89"], T0 + 31).stdout).toContain("ALLOW");   // the old one still has its entry
    expect(s.run(["simulate", "23.45.67.89"], T0 + 599).stdout).toContain("ALLOW");
    expect(s.run(["simulate", "23.45.67.89"], T0 + 601).stdout).toContain("BLOCK"); // expired: never refreshed again
    expect(s.run(["simulate", "3.7.7.7"], T0 + 601).stdout).toContain("ALLOW");   // refreshed at +30, lives to +630
    expect(s.status()).toMatchObject({ ok: true, hosts: { "api.gdeltproject.org": 2, "api.stlouisfed.org": 2 } });
  });
  it("FAIL CLOSED: when the refresh stops, check-stale alerts after 5 minutes (throttled, ids only), status fails, and after 10 minutes every address is blocked; a good refresh recovers", () => {
    const s = sandbox(); up(s);
    s.run(["apply"]);
    expect(s.run(["check-stale"], T0 + 200).stdout).toContain("fresh");
    expect(s.alerts()).toEqual([]);
    const stale = s.run(["check-stale"], T0 + 400);
    expect(stale.status).toBe(0);
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toContain("providers.egress_stale WARNING twins-providers-egress refresh_stale");
    expect(s.alerts()[0]).toContain("--detail ageSeconds=400");
    expect(s.alerts()[0]).toContain("--detail windowSeconds=300");
    expect(s.alerts()[0]).toContain("--throttle 3600");
    expect(s.run(["status"], T0 + 400).status).toBe(1);
    for (const ip of [...API, ...WS]) expect(s.run(["simulate", ip], T0 + 601).stdout, ip).toContain("BLOCK"); // fail closed
    expect(s.run(["status"], T0 + 601).stdout).toContain("EMPTY");
    s.run(["refresh"], T0 + 700);
    expect(s.run(["status"], T0 + 701).status).toBe(0);
    expect(s.run(["simulate", "34.120.1.10"], T0 + 701).stdout).toContain("ALLOW");
  });
  it("a resolution failure changes nothing, is recorded, is never fatal, and keeps the last COMPLETE refresh time (so staleness still counts)", () => {
    const s = sandbox(); up(s);
    s.run(["apply"]);
    s.answer("api.gdeltproject.org", null); // api no longer resolves
    const r = s.run(["refresh"], T0 + 30);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("refresh incomplete");
    expect(s.status()).toMatchObject({ ok: false, reason: "resolution_failed", last_ok_epoch: T0 });
    expect(s.run(["simulate", "34.120.1.10"], T0 + 31).stdout).toContain("ALLOW"); // existing entry untouched
    expect(s.run(["status"], T0 + 290).status).toBe(0);
    expect(s.run(["status"], T0 + 320).status).toBe(1); // 320 s since the last COMPLETE refresh
  });
  it("poisoned or odd DNS answers never open an internal or special address: private, loopback, link-local, CGNAT, multicast, zero, malformed are all rejected; at most 16 per host", () => {
    const s = sandbox();
    const bad = ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.5.5", "172.31.1.1", "192.168.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0", "255.255.255.255", "300.1.1.1", "1.2.3", "::1", "abc", "8.8.8.8 "];
    s.answer("api.gdeltproject.org", [...bad, "34.120.1.10"]);
    s.answer("api.stlouisfed.org", Array.from({ length: 30 }, (_, i) => `3.6.15.${i + 1}`));
    s.run(["apply"]);
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "100.64.0.1", "0.0.0.0"]) expect(s.run(["simulate", ip], T0 + 1).stdout, ip).toContain("BLOCK");
    expect(s.run(["simulate", "34.120.1.10"], T0 + 1).stdout).toContain("ALLOW");
    expect(s.status()).toMatchObject({ hosts: { "api.gdeltproject.org": 2, "api.stlouisfed.org": 16 } }); // 8.8.8.8 (with the trailing space trimmed) and 34.120.1.10
    expect(s.run(["simulate", "8.8.8.8"], T0 + 1).stdout).toContain("ALLOW"); // a public address returned by the name is accepted: the set follows the names
  });
  it("check-stale with no refresh ever recorded alerts too; unknown commands and bad time are refused; simulate is dry-run only", () => {
    const s = sandbox();
    s.run(["check-stale"]);
    expect(s.alerts()).toHaveLength(1);
    expect(s.run(["frobnicate"]).status).toBe(2);
    expect(s.run(["status"], T0, { TWINS_NOW: "abc" }).status).toBe(2);
    expect(spawnSync("bash", [SCRIPT, "simulate", "1.2.3.4"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", MONITOR_DIR: join(s.dir, "mon") } }).status).toBe(2);
  });
  it("the script touches only its own set, chain and jump: no other chain, policy, table, flush, ufw or restore; the host list is fixed (not configurable)", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/-F DOCKER-USER|-P |-t nat|ufw|--flush|-X DOCKER|-I INPUT|-A INPUT|-A FORWARD|restore|ipset flush/);
    expect(code).toMatch(/HOSTS=\("api\.gdeltproject\.org" "api\.stlouisfed\.org"\)/);
    expect(code).not.toMatch(/\$\{HOSTS:-|\$\{KITE_HOSTS/);
    expect(code).toMatch(/if \[ "\$DRY" = "1" \]; then RESOLVER="\$\{RESOLVER:-resolve-stub\}"; else RESOLVER="dig"; fi/); // only a dry run may substitute the resolver
    expect(code).not.toMatch(/\bcurl\b|\bwget\b|api\.gdeltproject\.org\/|https?:\/\//); // it never sends a request to the providerse; it only resolves names
  });
  it("the units: boot-time apply with a status gate and a rollback on stop; a 30-second refresh timer with the staleness check; both alert on failure", () => {
    const svc = readFileSync("infrastructure/staging/twins-providers-egress.service", "utf8");
    expect(svc).toMatch(/^ExecStartPre=-\/opt\/twins-staging\/twins-providers-egress\.sh remove$/m);
    expect(svc).toMatch(/^ExecStart=\/opt\/twins-staging\/twins-providers-egress\.sh apply$/m);
    expect(svc).toMatch(/^ExecStartPost=\/opt\/twins-staging\/twins-providers-egress\.sh status$/m);
    expect(svc).toMatch(/^ExecStop=\/opt\/twins-staging\/twins-providers-egress\.sh remove$/m);
    const rs = readFileSync("infrastructure/staging/twins-providers-egress-refresh.service", "utf8");
    expect(rs).toMatch(/^ExecStart=\/opt\/twins-staging\/twins-providers-egress\.sh refresh$/m);
    expect(rs).toMatch(/^ExecStartPost=\/opt\/twins-staging\/twins-providers-egress\.sh check-stale$/m);
    expect(rs).toMatch(/OnFailure=twins-alert-on-failure@%n\.service/);
    const timer = readFileSync("infrastructure/staging/twins-providers-egress-refresh.timer", "utf8");
    expect(timer).toMatch(/^OnUnitActiveSec=30s$/m);
    expect(timer).toMatch(/^Unit=twins-providers-egress-refresh\.service$/m);
  });
});

describe("twins-providers-start.sh (the start gate)", () => {
  function gate(egressStatus: number) {
    const dir = mkdtempSync(join(tmpdir(), "twins-gate-"));
    const egress = join(dir, "egress"); const dockerLog = join(dir, "docker.log");
    writeFileSync(egress, `#!/bin/bash\n[ "$1" = status ] && { echo "status says ${egressStatus === 0 ? "OK" : "STALE"}"; exit ${egressStatus}; }\nexit 9\n`); chmodSync(egress, 0o755);
    writeFileSync(join(dir, "docker"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${dockerLog}"\n`); chmodSync(join(dir, "docker"), 0o755);
    const r = spawnSync("bash", [START], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", EGRESS_BIN: egress, DOCKER: join(dir, "docker"), COMPOSE_DIR: dir } });
    return { r, docker: existsSync(dockerLog) ? readFileSync(dockerLog, "utf8").trim() : "" };
  }
  it("starts ONLY the provider-exporter service, and only when the egress status check passes", () => {
    const ok = gate(0);
    expect(ok.r.status).toBe(0);
    expect(ok.docker).toBe("compose -f docker-compose.staging.yml --env-file staging.env --profile providers up -d --no-deps provider-exporter");
    const bad = gate(1);
    expect(bad.r.status).toBe(3);
    expect(bad.docker).toBe(""); // docker was never called
    expect(bad.r.stdout).toContain("providers_start.start_refused");
  });
  it("accepts no arguments (nothing can widen what it starts)", () => {
    expect(spawnSync("bash", [START, "--all"], { encoding: "utf8" }).status).toBe(2);
  });
});
