import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadExpectedMigrations } from "../../integration/migrationState";
import {
  API_PORT, HYPOTHETICAL_MESSAGE, PreflightError, ProcessSet, VIEWER_PORT, buildChildEnvs, buildWebhookPayload, childArgs, main, preflight, realDeps, waitForClaim,
  type PreflightDeps,
} from "../../../scripts/options-demo";
import { analyzeTelegramText } from "../../../packages/signals/src/extract";

const API_KEY = "owner-api-key-DO-NOT-PRINT-123";
const PASSWORD = "db-password-DO-NOT-PRINT-456";
const SECRET = "webhook-secret-DO-NOT-PRINT-789";
const expected = loadExpectedMigrations();
const exact = expected.map((m) => ({ hash: m.hash, created_at: String(m.when) }));
const goodEnv = {
  PATH: process.env.PATH, TWINS_API_KEY: API_KEY, LIVE_TRADING: "false",
  DATABASE_URL: `postgresql://twins:${PASSWORD}@127.0.0.1:15432/twins_rehearsal_f2_fresh`, REDIS_URL: "redis://127.0.0.1:16379",
};
const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
  env: goodEnv, apiPort: API_PORT, viewerPort: VIEWER_PORT, expectedMigrations: expected,
  isPortFree: async () => true, readMigrations: async () => exact, pendingQueueJobs: async () => 0, ...over,
});
const refusal = async (d: PreflightDeps) => preflight(d).then(() => "", (e: Error) => { expect(e).toBeInstanceOf(PreflightError); return e.message; });

describe("preflight (read-only; refuses rather than adjusts)", () => {
  it("accepts the approved database at the repository migration state with idle services and free ports", async () => {
    expect(await preflight(deps())).toEqual({ database: "twins_rehearsal_f2_fresh", migrations: expected.length });
  });

  it.each([
    ["twins_dev", "postgresql://twins:x@127.0.0.1:15432/twins_dev", /approved list/],
    ["twins_ci", "postgresql://twins:x@127.0.0.1:15432/twins_ci", /approved list/],
    ["a non-loopback host", "postgresql://twins:x@db.example.com:15432/twins_rehearsal_f2_fresh", /127\.0\.0\.1:15432/],
    ["the wrong user", "postgresql://other:x@127.0.0.1:15432/twins_rehearsal_f2_fresh", /user/],
    ["no DATABASE_URL", "", /DATABASE_URL is not set/],
  ])("refuses a wrong database: %s", async (_l, url, message) => {
    const msg = await refusal(deps({ env: { ...goodEnv, DATABASE_URL: url } }));
    expect(msg).toMatch(message);
  });

  it("refuses a wrong Redis, a missing API key, and LIVE_TRADING other than false", async () => {
    expect(await refusal(deps({ env: { ...goodEnv, REDIS_URL: "redis://127.0.0.1:6379" } }))).toMatch(/16379/);
    expect(await refusal(deps({ env: { ...goodEnv, TWINS_API_KEY: undefined } }))).toMatch(/TWINS_API_KEY must be set/);
    expect(await refusal(deps({ env: { ...goodEnv, LIVE_TRADING: "true" } }))).toMatch(/LIVE_TRADING must be unset or exactly 'false'/);
  });

  it("refuses a missing migration (target behind) or a foreign history, and never migrates", async () => {
    const behind = await refusal(deps({ readMigrations: async () => exact.slice(0, expected.length - 1) }));
    expect(behind).toMatch(/behind/);
    expect(behind).toContain(expected[expected.length - 1]?.tag ?? "?");
    expect(behind).toMatch(/Nothing was migrated/);
    expect(await refusal(deps({ readMigrations: async () => [...exact, { hash: "x", created_at: "1" }] }))).toMatch(/ahead or foreign/);
    expect(await refusal(deps({ readMigrations: async () => [] }))).toMatch(/behind: 0 of/);
  });

  it("refuses an unreachable database or Redis with a safe code only", async () => {
    const db = await refusal(deps({ readMigrations: async () => { throw Object.assign(new Error(`connect failed ${PASSWORD}`), { code: "ECONNREFUSED" }); } }));
    expect(db).toContain("ECONNREFUSED");
    expect(db).not.toContain(PASSWORD);
    const redis = await refusal(deps({ pendingQueueJobs: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } }));
    expect(redis).toMatch(/cannot reach the test Redis \(ECONNREFUSED\)/);
  });

  it("refuses pending queue work that a demo worker would consume", async () => {
    expect(await refusal(deps({ pendingQueueJobs: async () => 3 }))).toMatch(/3 job\(s\) are already pending/);
  });

  it("refuses an occupied port (real listener), for the API and for the viewer", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const busy = (server.address() as net.AddressInfo).port;
    try {
      const real = realDeps(goodEnv, busy, busy + 1);
      expect(await real.isPortFree(busy)).toBe(false);
      expect(await refusal({ ...deps(), isPortFree: real.isPortFree, apiPort: busy })).toMatch(new RegExp(`API port ${busy} is already in use`));
      expect(await refusal({ ...deps(), isPortFree: real.isPortFree, viewerPort: busy })).toMatch(new RegExp(`viewer port ${busy} is already in use`));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("no refusal message ever contains the API key, the database password or a URL", async () => {
    const messages = [
      await refusal(deps({ env: { ...goodEnv, DATABASE_URL: `postgresql://twins:${PASSWORD}@db.example.com:15432/twins_dev` } })),
      await refusal(deps({ readMigrations: async () => [] })),
      await refusal(deps({ pendingQueueJobs: async () => 1 })),
      await refusal(deps({ env: { ...goodEnv, LIVE_TRADING: "true" } })),
    ];
    for (const m of messages) {
      expect(m).not.toContain(PASSWORD);
      expect(m).not.toContain(API_KEY);
      expect(m).not.toMatch(/postgresql:\/\/|redis:\/\//);
    }
  });
});

describe("what each child process gets", () => {
  const envs = buildChildEnvs({ ...goodEnv, AWS_SECRET_ACCESS_KEY: "must-not-leak", OPENROUTER_API_KEY: "must-not-leak" }, SECRET);
  it("minimal environments; secrets only where needed; never inherited extras", () => {
    for (const e of [envs.api, envs.worker, envs.viewer]) {
      expect(e["LIVE_TRADING"]).toBe("false");
      expect(e["TRADING_MODE"]).toBe("paper");
      expect(JSON.stringify(e)).not.toContain("must-not-leak");
    }
    expect(envs.api).toMatchObject({ HOST: "127.0.0.1", PORT: String(API_PORT), TWINS_API_KEY: API_KEY, TELEGRAM_WEBHOOK_SECRET: SECRET });
    expect(envs.worker["TELEGRAM_WEBHOOK_SECRET"]).toBeUndefined();
    expect(envs.worker["TWINS_API_KEY"]).toBeUndefined();
    expect(envs.worker["TWINS_OPTIONS_MANUAL_REFERENCE"]).toMatch(/data\/options-reference\/manual-reference\.v1\.json$/);
    expect(envs.viewer["TWINS_API_KEY"]).toBeUndefined();
    expect(envs.viewer["DATABASE_URL"]).toBeUndefined();
    expect(envs.viewer["TELEGRAM_WEBHOOK_SECRET"]).toBeUndefined();
  });
  it("secrets are passed through the environment, never through argv or a URL", () => {
    const args = [...childArgs("apps/api/src/index.ts"), ...childArgs("apps/web/src/server.ts", ["--api", `http://127.0.0.1:${API_PORT}`, "--port", String(VIEWER_PORT)])].join(" ");
    for (const s of [API_KEY, SECRET, PASSWORD]) expect(args).not.toContain(s);
    expect(args).toContain("networkGuardSetup.ts"); // the guard is preloaded into every child
  });
});

describe("the submitted message", () => {
  it("is one clearly hypothetical options message that the existing parser recognises as an options claim", () => {
    expect(analyzeTelegramText(HYPOTHETICAL_MESSAGE).kind).toBe("options_claim");
    const p = buildWebhookPayload(1_760_000_000_000, () => 0.5);
    expect(p.body.channel_post.text).toBe(HYPOTHETICAL_MESSAGE);
    expect(p.channelIdentifier).toBe(`tg_chat_${p.chatId}`);
    expect(p.chatId).toBeLessThan(0);
  });
  it("is unique per run and carries no secret", () => {
    const a = buildWebhookPayload(1_760_000_000_000, () => 0.1);
    const b = buildWebhookPayload(1_760_000_001_000, () => 0.9);
    expect(a.chatId === b.chatId && a.messageId === b.messageId).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/secret|token|key/i);
  });
  it("the internal message id is found programmatically once the claim row exists; a timeout is reported", async () => {
    let polls = 0;
    const lookup = { find: async () => (++polls < 3 ? null : polls < 4 ? { messageId: "m", claimRows: 0 } : { messageId: "11111111-2222-3333-4444-555555555555", claimRows: 1 }) };
    expect(await waitForClaim(lookup, "tg_chat_-1", "1", 5000, 5)).toBe("11111111-2222-3333-4444-555555555555");
    await expect(waitForClaim({ find: async () => null }, "tg_chat_-1", "1", 30, 5)).rejects.toThrow(/timed out waiting for the options claim record/);
  });
});

describe("process ownership: only what the demo started is stopped", () => {
  const spawned: number[] = [];
  afterEach(() => { for (const pid of spawned.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("stopAll terminates the owned process groups (including grandchildren) and leaves an unrelated owner process running", async () => {
    // an "existing owner process" the demo did not start:
    const outsider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
    outsider.unref();
    spawned.push(outsider.pid as number);
    const set = new ProcessSet();
    const keepAlive = "setInterval(()=>{},1000)";
    const owned1 = set.start("fake-api", process.execPath, ["-e", keepAlive], { PATH: process.env.PATH ?? "" }, "/dev/null");
    // a process that itself spawns a grandchild in the same group:
    const owned2 = set.start("fake-worker", process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e','${keepAlive}'],{stdio:'ignore'});${keepAlive}`], { PATH: process.env.PATH ?? "" }, "/dev/null");
    spawned.push(owned1.pid, owned2.pid);
    await new Promise((r) => setTimeout(r, 400));
    expect(set.names).toEqual(["fake-api", "fake-worker"]);
    expect(alive(owned1.pid) && alive(owned2.pid) && alive(outsider.pid as number)).toBe(true);
    await set.stopAll(3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(owned1.pid)).toBe(false);
    expect(alive(owned2.pid)).toBe(false);
    expect(() => process.kill(-owned2.pid, 0)).toThrow(); // the whole group (grandchild included) is gone
    expect(alive(outsider.pid as number)).toBe(true); // the owner's process is untouched
    await set.stopAll(); // idempotent
  }, 20_000);
});

describe("the entry point itself", () => {
  it("every child is launched with the network guard preloaded: an external request is refused before DNS", () => {
    const r = spawnSync(process.execPath, [...childArgs("scripts/options-demo.ts").slice(0, 4), "-e", "fetch('https://query1.finance.yahoo.com/').then(()=>console.log('SENT'),e=>console.log(e.code))"], { encoding: "utf8", timeout: 30_000 });
    expect(r.stdout.trim()).toBe("EXTERNAL_NETWORK_BLOCKED");
  }, 40_000);

  it("--check with no environment refuses (exit 2) and prints no secret", async () => {
    const lines: string[] = [];
    const code = await main(["--check"], { PATH: process.env.PATH }, (l) => lines.push(l));
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/demo refused: TWINS_API_KEY must be set/);
  });

  it("source: no external adapter, no printing of env values, no migration or cleanup statements", () => {
    const src = readFileSync("scripts/options-demo.ts", "utf8");
    expect(src).not.toMatch(/YahooFinanceAdapter|adapters\/market|fetch\("https?:\/\/(?!127\.0\.0\.1)/);
    expect(src).not.toMatch(/console\.log\([^)]*(TWINS_API_KEY|DATABASE_URL|webhookSecret|PASSWORD)/);
    expect(src).not.toMatch(/\bmigrate\(|drizzle-kit|DROP |TRUNCATE|DELETE FROM|\.obliterate|FLUSH/i);
    expect(src).not.toMatch(/\?token=|[?&]secret=/);
  });
});
