import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { must } from "../../support/must";

/**
 * Every TWINS process must enforce the shared LIVE_TRADING guard. This file proves it three ways:
 *  1. static: each process entry point named in the staging compose file (plus the other runnable entry points) calls the guard FIRST,
 *     every compose service carries the fixed paper/false literals, and no other source reads LIVE_TRADING directly;
 *  2. behavioural: each entry point is actually started with live trading configured and must exit 81 before doing anything;
 *  3. negative control: with the guard satisfied the same entry points proceed to their ordinary (config) failure, not to 81.
 */
const ROOT = resolve(__dirname, "../../..");
const compose = readFileSync(join(ROOT, "infrastructure/staging/docker-compose.staging.yml"), "utf8");

/** Entry points started by the compose file: service -> repo-relative path of the file its command runs. */
function composeEntries(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of compose.matchAll(/\n  ([a-z-]+):\n((?:(?!\n  [a-z_-]+:\n|\nnetworks:)[\s\S])*)/g)) {
    const body = (m[2] ?? "").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const cmd = /command: \[(.*)\]/.exec(body)?.[1];
    if (!cmd) continue;
    const file = /\/app\/((?:apps|services|packages|scripts)\/[^"]+\.(?:ts|py))/.exec(cmd)?.[1];
    if (file) result[must(m[1])] = file;
  }
  return result;
}
const entries = composeEntries();

/** Runnable entry points that are not compose services. Each must enforce the guard too. */
const EXTRA_ENTRIES = ["tools/t1-feasibility/t1_check.py", "apps/web/src/server.ts", "scripts/options-preview.ts", "scripts/options-import-dhan.ts", "scripts/options-demo.ts"];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const isPython = (p: string) => p.endsWith(".py");

describe("LIVE_TRADING guard coverage: static", () => {
  it("finds the compose-started processes (so this test cannot silently pass on an empty set)", () => {
    expect(Object.keys(entries).sort()).toEqual(["api", "approval-bot", "audit-verify", "capture", "migrate", "safety-control", "scheduler", "worker"]);
  });

  it("every entry point calls the shared guard; module-level guards precede configuration, and capture's main() starts with it", () => {
    for (const file of [...Object.values(entries), ...EXTRA_ENTRIES]) {
      const text = read(file);
      if (isPython(file)) {
        // first statement of main(): nothing (not even configuration) is read before it
        const body = text.slice(text.indexOf("\ndef main(")).split("\n").slice(2).find((l) => l.trim() !== "");
        expect(body?.trim(), file).toMatch(/^(?:enforce_live_trading_guard|_enforce_live_guard)\(/);
        continue;
      }
      const at = text.search(/enforceLiveTradingGuard\(/);
      expect(at, file).toBeGreaterThanOrEqual(0);
      // Module-level processes (worker, scheduler, bot): the guard must precede configuration and any resource. Processes whose entry is a
      // function (api buildApp, migrate/viewer main) are proven by the behavioural tests below, which start them for real.
      const guardLine = text.slice(0, at).split("\n").length;
      for (const rx of [/^const config = loadConfig\(\)/m, /^const \w+ = new Redis\(/m, /^export const workerDb = createBoundedDb/m]) {
        const first = text.search(rx);
        if (first >= 0) expect(guardLine, `${file} must guard before ${rx}`).toBeLessThan(text.slice(0, first).split("\n").length);
      }
    }
  });

  it("no process keeps a private copy of the rule (worker and scheduler inline exits are gone)", () => {
    for (const file of [...Object.values(entries), ...EXTRA_ENTRIES]) {
      const text = read(file);
      expect(text, file).not.toMatch(/liveTradingEnabled\)\s*\{/);
      expect(text, file).not.toMatch(/process\.env\[?\.?["']?LIVE_TRADING/);
    }
  });

  it("only the guard modules, config parser and the demo/preflight message read or name LIVE_TRADING in runtime source", () => {
    const allowed = new Set([
      "packages/config/src/index.ts",
      "packages/config/src/liveGuard.ts",
      "services/telegram-capture/twins_capture/liveguard.py",
      "scripts/options-demo.ts",
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (["node_modules", "dist", "tests", "__pycache__"].includes(name)) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|py)$/.test(name) && /LIVE_TRADING/.test(read(rel))) found.push(rel);
      }
    };
    for (const dir of ["apps", "services", "packages", "adapters", "scripts"]) walk(dir);
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("every compose service that runs TWINS code is pinned to paper / LIVE_TRADING false by literals the env file cannot change", () => {
    const withCode = ["api", "worker", "scheduler", "migrate", "safety-control", "audit-verify", "approval-bot", "capture"];
    for (const name of withCode) {
      const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_-]+:\\n|\\nnetworks:)`).exec(compose);
      const body = (m?.[1] ?? "").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      const viaAnchor = /<<: \*app-env|environment: \*app-env/.test(body);
      if (viaAnchor) continue;
      expect(body, name).toMatch(/LIVE_TRADING: "false"/);
      expect(body, name).toMatch(/TRADING_MODE: paper/);
    }
    expect(compose).toMatch(/x-app-env: &app-env[\s\S]*?TRADING_MODE: paper[\s\S]*?LIVE_TRADING: "false"/);
  });

  it("no process is exempt: the T1 feasibility tool loads the same shared guard and fails closed when it cannot", () => {
    const text = read("tools/t1-feasibility/t1_check.py");
    expect(text).toMatch(/twins_capture", "liveguard\.py/);
    expect(text).toMatch(/_enforce_live_guard\(\)\s+# first statement/);
    expect(text).toMatch(/"guard_unavailable"/);
  });
});

/** How to start each entry point for the behavioural test. */
const STARTS: Array<{ name: string; cmd: string; args: string[]; control?: { env?: Record<string, string>; notStatus: number } }> = [
  { name: "api", cmd: "node", args: ["--import", "tsx", join(ROOT, "apps/api/src/index.ts")] },
  { name: "worker", cmd: "node", args: ["--import", "tsx", "services/worker/src/index.ts"] },
  { name: "scheduler", cmd: "node", args: ["--import", "tsx", "services/scheduler/src/index.ts"] },
  { name: "migrate", cmd: "node", args: ["--import", "tsx", "packages/database/src/migrate.ts"], control: { notStatus: 81 } },
  { name: "approval-bot run", cmd: "node", args: ["--import", "tsx", "services/approval-bot/src/index.ts", "run"], control: { notStatus: 81 } },
  { name: "approval-bot check-config", cmd: "node", args: ["--import", "tsx", "services/approval-bot/src/index.ts", "check-config"], control: { notStatus: 81 } },
  { name: "options viewer", cmd: "node", args: ["--import", "tsx", join(ROOT, "apps/web/src/server.ts")] },
  { name: "options-preview", cmd: "node", args: ["--import", "tsx", "scripts/options-preview.ts"] },
  { name: "options-import-dhan", cmd: "node", args: ["--import", "tsx", "scripts/options-import-dhan.ts"] },
  { name: "options-demo", cmd: "node", args: ["--import", "tsx", "scripts/options-demo.ts"] },
  { name: "safety-control", cmd: "node", args: ["--import", "tsx", join(ROOT, "scripts/ops/safety-control.ts"), "status"], control: { notStatus: 81 } },
  { name: "audit-verify", cmd: "node", args: ["--import", "tsx", join(ROOT, "scripts/ops/verify-audit-chain.ts")], control: { notStatus: 81 } },
  { name: "t1-check", cmd: "python3", args: ["-E", "-s", "-B", "tools/t1-feasibility/t1_check.py", "--help"], control: { notStatus: 81 } },
  { name: "capture run", cmd: "python3", args: ["-E", "-s", "-B", "services/telegram-capture/main.py", "run"], control: { notStatus: 81 } },
  { name: "capture check-config", cmd: "python3", args: ["-E", "-s", "-B", "services/telegram-capture/main.py", "check-config"], control: { notStatus: 81 } },
  { name: "capture history", cmd: "python3", args: ["-E", "-s", "-B", "services/telegram-capture/main.py", "history", "--chat", "-1001234567890", "--dry-run"], control: { notStatus: 81 } },
];

const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp" };
const start = (s: (typeof STARTS)[number], env: Record<string, string>) =>
  spawnSync(s.cmd, s.args, { cwd: ROOT, env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 40_000 });

describe("LIVE_TRADING guard coverage: every process refuses to start in live configuration", () => {
  for (const s of STARTS) {
    it(`${s.name}: LIVE_TRADING=true -> exit 81, one content-free line, nothing else`, () => {
      const r = start(s, { LIVE_TRADING: "true", TRADING_MODE: "live" });
      expect(r.status).toBe(81);
      expect(r.stdout).toBe("");
      const lines = r.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(must(lines[0]))).toMatchObject({ event: "live_guard.refused", reasons: ["live_trading_not_false", "trading_mode_not_permitted"] });
    }, 60_000);

    it(`${s.name}: an ambiguous value (LIVE_TRADING=TRUE) is refused too`, () => {
      const r = start(s, { LIVE_TRADING: "TRUE" });
      expect(r.status).toBe(81);
    }, 60_000);

    if (s.control) {
      it(`${s.name}: control - with LIVE_TRADING=false the guard lets it through to its ordinary failure`, () => {
        const r = start(s, { LIVE_TRADING: "false", TRADING_MODE: "paper" });
        expect(r.status).not.toBe(81);
        expect(r.stderr).not.toContain("live_guard.refused");
      }, 60_000);
    }
  }
});

describe("python capture: the Python suite for the guard runs under the existing capture test discovery", () => {
  it("test_liveguard.py exists in the discovered test directory", () => {
    expect(execFileSync("ls", ["services/telegram-capture/tests"], { cwd: ROOT, encoding: "utf8" })).toContain("test_liveguard.py");
  });
});
