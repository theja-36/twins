import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_PORT, PreflightError, VIEWER_PORT, main, runVerify, type VerifyCounts, type VerifyOps } from "../../../scripts/options-demo";

const MESSAGE_ID = "11111111-2222-3333-4444-555555555555";
const OWNER_KEY = "OWNER-REAL-KEY-must-never-be-used";
const KEYS = ["throwaway-key-AAAA", "throwaway-secret-BBBB"];
const baseCounts: VerifyCounts = { instruments: 10, signals: 20, orders: 0, optionsClaims: 5, telegramMessages: 30, migrations: 7 };

interface World {
  ops: VerifyOps;
  out: string[];
  calls: { started: number; stopped: number; webhookPosts: number; startEnvs: Array<Record<string, Record<string, string>>>; authHeaders: string[]; preflightEnv: Array<Record<string, string | undefined>> };
}

function world(over: {
  preflight?: VerifyOps["preflight"];
  ready?: { api: boolean; viewer: boolean; worker: boolean };
  webhookStatus?: number;
  afterCounts?: Partial<VerifyCounts>;
  storedRow?: string;
  apiNoAuthStatus?: number;
  viewerNoAuthStatus?: number;
  viewerKind?: string;
  logs?: string;
  stopThrows?: boolean;
  portsFree?: boolean;
  lookupNeverFinds?: boolean;
} = {}): World {
  const calls: World["calls"] = { started: 0, stopped: 0, webhookPosts: 0, startEnvs: [], authHeaders: [], preflightEnv: [] };
  let posted = false;
  let key = "";
  let n = 0;
  let countsCalls = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
    if (auth) calls.authHeaders.push(auth);
    if (url.endsWith("/webhooks/telegram")) { calls.webhookPosts++; posted = true; return json(over.webhookStatus ?? 202, { status: "accepted" }); }
    if (url.includes(`:${API_PORT}/options-claims/`)) {
      if (auth !== `Bearer ${key}`) return json(auth === undefined ? over.apiNoAuthStatus ?? 401 : 401, { error: "Unauthorized" });
      return json(200, { versionCount: 1, claims: [{ resultKind: "claim", approvalPossible: false }] });
    }
    if (url.includes(`:${VIEWER_PORT}/view/options-claims/`)) {
      if (auth !== `Bearer ${key}`) return json(over.viewerNoAuthStatus ?? 401, { error: {} });
      return json(200, { versions: [{ kind: over.viewerKind ?? "claim", banner: "Stored assessment — not an order", approvalPossible: false }] });
    }
    return new Response("<html></html>", { status: 200 });
  };
  const out: string[] = [];
  const ops: VerifyOps = {
    preflight: over.preflight ?? (async (env) => { calls.preflightEnv.push(env); return { database: "twins_rehearsal_f2_fresh", migrations: 7 }; }),
    start(envs) {
      calls.started++;
      calls.startEnvs.push(envs as never);
      key = envs.api["TWINS_API_KEY"] ?? "";
      return { names: ["api", "worker", "viewer"], stop: async () => { calls.stopped++; if (over.stopThrows) throw new Error("stop failed"); } };
    },
    waitReady: async () => over.ready ?? { api: true, viewer: true, worker: true },
    fetch: fakeFetch,
    lookup: { find: async () => (posted && !over.lookupNeverFinds ? { messageId: MESSAGE_ID, claimRows: 1 } : null) },
    counts: async () => (++countsCalls === 1 ? baseCounts : { ...baseCounts, optionsClaims: baseCounts.optionsClaims + 1, telegramMessages: baseCounts.telegramMessages + 1, ...over.afterCounts }),
    storedRow: async () => over.storedRow ?? "claim|INSUFFICIENT_EVIDENCE|false|telegram-regex-v2",
    readLogs: () => over.logs ?? "[worker] listening on signal_queue and market_queue\n",
    portsFree: async () => over.portsFree ?? true,
    close: async () => undefined,
    newKey: () => KEYS[n++ % 2] as string,
    now: () => 1_760_000_000_000,
  };
  return { ops, out, calls };
}
const env = { DATABASE_URL: "postgresql://twins:db-password-XYZ@127.0.0.1:15432/twins_rehearsal_f2_fresh", REDIS_URL: "redis://127.0.0.1:16379", TWINS_API_KEY: OWNER_KEY };
const run = async (w: World, e: Record<string, string | undefined> = env) => runVerify(e, w.ops, (l) => w.out.push(l));

describe("options:demo --verify", () => {
  it("all steps pass: PASS lines, RESULT PASS, browser NOT INSPECTED, exit 0, owned processes stopped once", async () => {
    const w = world();
    expect(await run(w)).toBe(0);
    const text = w.out.join("\n");
    for (const s of ["PASS  preflight", "PASS  start only demo-owned API, worker, viewer", "PASS  exactly one hypothetical message", "PASS  message reached a stored options-claim row", `message id ${MESSAGE_ID}`, "PASS  stored row", "PASS  authenticated API returns the row", "PASS  viewer stored-result response", "NOT a browser rendering check", "PASS  no signal, instrument or order created", "PASS  no secret in any child log", "PASS  demo-owned processes stopped"]) expect(text, s).toContain(s);
    expect(text).toMatch(/RESULT: PASS\s+\(browser rendering: NOT INSPECTED\)/);
    expect(text).not.toContain("FAIL");
    expect(w.calls.started).toBe(1);
    expect(w.calls.stopped).toBe(1);
    expect(w.calls.webhookPosts).toBe(1); // exactly one message
  });

  it("uses a fresh throwaway key; the caller's TWINS_API_KEY is neither used nor passed to any child", async () => {
    const w = world();
    await run(w);
    expect(w.calls.preflightEnv[0]?.["TWINS_API_KEY"]).toBe(KEYS[0]);
    const envs = w.calls.startEnvs[0] as Record<string, Record<string, string>>;
    expect(envs["api"]?.["TWINS_API_KEY"]).toBe(KEYS[0]);
    expect(envs["api"]?.["TELEGRAM_WEBHOOK_SECRET"]).toBe(KEYS[1]);
    expect(JSON.stringify(w.calls)).not.toContain(OWNER_KEY);
    expect(w.calls.authHeaders.filter((h) => h !== "Bearer not-the-key" && h !== `Bearer ${KEYS[0]}`)).toEqual([]);
    expect(envs["worker"]?.["TWINS_API_KEY"]).toBeUndefined();
    expect(envs["viewer"]?.["TWINS_API_KEY"]).toBeUndefined();
  });

  it("never prints a secret: neither throwaway value, the owner key nor the database password appears in any output", async () => {
    const w = world();
    await run(w);
    const text = w.out.join("\n");
    for (const s of [...KEYS, OWNER_KEY, "db-password-XYZ"]) expect(text).not.toContain(s);
    expect(text).not.toMatch(/postgresql:\/\/|redis:\/\//);
  });

  it("a preflight refusal starts nothing and exits 2 with the refusal message", async () => {
    const w = world({ preflight: async () => { throw new PreflightError("'twins_dev' is not on the exact approved list"); } });
    expect(await run(w)).toBe(2);
    expect(w.calls.started).toBe(0);
    expect(w.calls.webhookPosts).toBe(0);
    expect(w.out.join("\n")).toContain("demo refused:");
  });

  it.each([
    ["a service not ready", { ready: { api: true, viewer: true, worker: false } }, /FAIL  start only demo-owned/],
    ["the webhook rejecting the message", { webhookStatus: 401 }, /FAIL  exactly one hypothetical message/],
    ["a stored row that is approvable", { storedRow: "claim|INSUFFICIENT_EVIDENCE|true|telegram-regex-v2" }, /FAIL  stored row/],
    ["an unauthenticated API read being allowed", { apiNoAuthStatus: 200 }, /FAIL  authenticated API/],
    ["the viewer answering without a token", { viewerNoAuthStatus: 200 }, /FAIL  viewer stored-result/],
    ["a viewer record that is not a claim", { viewerKind: "unsupported" }, /FAIL  viewer stored-result/],
    ["a signal being created", { afterCounts: { signals: 21 } }, /FAIL  no signal, instrument or order/],
    ["an instrument being created", { afterCounts: { instruments: 11 } }, /FAIL  no signal, instrument or order/],
    ["an order being created", { afterCounts: { orders: 1 } }, /FAIL  no signal, instrument or order/],
    ["a migration being applied", { afterCounts: { migrations: 8 } }, /FAIL  no signal, instrument or order/],
    ["two options-claim rows being written", { afterCounts: { optionsClaims: 7 } }, /FAIL  no signal, instrument or order/],
    ["the throwaway key appearing in a log", { logs: `oops ${KEYS[0]}` }, /FAIL  no secret in any child log/],
    ["an external-request attempt in a log", { logs: "EXTERNAL_NETWORK_BLOCKED host" }, /FAIL  no secret in any child log/],
  ])("FAIL (exit 1) and still stops the owned processes: %s", async (_l, over, line) => {
    const w = world(over as never);
    expect(await run(w)).toBe(1);
    expect(w.out.join("\n")).toMatch(line);
    expect(w.out.join("\n")).toMatch(/RESULT: FAIL\s+\(browser rendering: NOT INSPECTED\)/);
    expect(w.calls.stopped).toBe(1);
    for (const s of KEYS) expect(w.out.join("\n")).not.toContain(s);
  });

  it("a process that cannot be stopped, or ports that stay busy, is a FAIL", async () => {
    const stuck = world({ stopThrows: true });
    expect(await run(stuck)).toBe(1);
    expect(stuck.out.join("\n")).toMatch(/FAIL  demo-owned processes stopped/);
    const busy = world({ portsFree: false });
    expect(await run(busy)).toBe(1);
  });

  it("a claim that never appears is a FAIL (bounded wait) and the owned processes are still stopped", async () => {
    const w = world({ lookupNeverFinds: true });
    w.ops.claimTimeoutMs = 40;
    expect(await run(w)).toBe(1);
    expect(w.out.join("\n")).toMatch(/FAIL  run - timed out waiting for the options claim record/);
    expect(w.calls.webhookPosts).toBe(1);
    expect(w.calls.stopped).toBe(1);
  });
});

describe("the command surface", () => {
  it("--verify with no database configured refuses at preflight (exit 2) and starts nothing", async () => {
    const out: string[] = [];
    const code = await main(["--verify"], { PATH: process.env.PATH }, (l) => out.push(l));
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/demo refused: .*DATABASE_URL is not set/);
  });

  it("--verify against a wrong database refuses (exit 2) before anything starts", async () => {
    const out: string[] = [];
    const code = await main(["--verify"], { PATH: process.env.PATH, DATABASE_URL: "postgresql://twins:x@127.0.0.1:15432/twins_dev", REDIS_URL: "redis://127.0.0.1:16379" }, (l) => out.push(l));
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/approved list/);
  });

  it("the interactive mode and --check are unchanged and the verify code adds no new dependency, network target or cleanup", () => {
    const src = readFileSync("scripts/options-demo.ts", "utf8");
    expect(src).toContain("export async function runDemo(");
    expect(src).toMatch(/await new Promise<void>\(\(\) => undefined\);/); // interactive mode still waits for Ctrl+C
    expect(src).toContain('if (argv.includes("--check"))');
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../packages/config/src/liveGuard", "../tests/integration/migrationState", "../tests/integration/targetConfig", "../tests/support/networkGuard", "ioredis", "node:child_process", "node:crypto", "node:fs", "node:net", "node:os", "node:path", "node:url", "pg"].sort());
    expect(src).not.toMatch(/\bmigrate\(|DROP |TRUNCATE|DELETE FROM|FLUSH|obliterate/i);
    expect(src).not.toMatch(/console\.log\([^)]*(apiKey|webhookSecret|TWINS_API_KEY|DATABASE_URL)/);
  });
});
