/**
 * ONE-COMMAND OFFLINE OPTIONS DEMO (local only). Starts exactly three processes - the API, the signal worker and the
 * read-only result viewer - against the approved isolated integration database, submits ONE clearly hypothetical options
 * message through the existing local webhook, finds its internal message id programmatically, and prints the viewer URL
 * and id. It stops only the processes it started and RETAINS all database records.
 *
 *   TWINS_API_KEY=<your key> DATABASE_URL=<approved rehearsal URL> REDIS_URL=redis://127.0.0.1:16379 npm run options:demo
 *   npm run options:demo -- --check      # preflight only: starts nothing, writes nothing
 *   DATABASE_URL=<approved rehearsal URL> REDIS_URL=redis://127.0.0.1:16379 npm run options:demo -- --verify
 *       # self-contained check: preflight, start the owned API/worker/viewer, submit ONE hypothetical message, verify
 *       # persistence + authenticated API + viewer response, print PASS/FAIL, stop the owned processes and exit.
 *       # It uses a fresh throwaway API key generated in memory (your TWINS_API_KEY is neither needed nor used);
 *       # records and logs are retained. Browser rendering is NOT INSPECTED.
 *
 * Safety: refuses a wrong database, a missing/ahead migration, an occupied port, pending queue work, or a missing key;
 * never migrates, resets or substitutes a database; never prints, persists or URL-embeds the API key or webhook secret
 * (the API key comes from YOUR environment and is typed into the viewer by you; the webhook secret is random and
 * in-memory); children run with a minimal environment and the test network guard preloaded, so no public request can
 * leave them. No external market adapter is ever invoked (an options message returns before the market step).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";
import { describeMigrationMismatch, loadExpectedMigrations, type RecordedMigration } from "../tests/integration/migrationState";
import { resolveTestTarget, TestTargetError } from "../tests/integration/targetConfig";
import { enforceLiveTradingGuard, evaluateLiveGuard } from "../packages/config/src/liveGuard";
import { installNetworkGuard } from "../tests/support/networkGuard";

export const API_PORT = 4010;
export const VIEWER_PORT = 4020;
export const HYPOTHETICAL_MESSAGE = "BUY NIFTY 24500 CE 26 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANUAL_REFERENCE = join(REPO_ROOT, "data/options-reference/manual-reference.v1.json");
const GUARD_PRELOAD = join(REPO_ROOT, "tests/support/networkGuardSetup.ts");

export class PreflightError extends Error {
  constructor(message: string) {
    super(`demo refused: ${message}`);
    this.name = "PreflightError";
  }
}

// ---------------------------------------------------------------------------------------------------- preflight
export interface PreflightDeps {
  env: Record<string, string | undefined>;
  apiPort: number;
  viewerPort: number;
  isPortFree(port: number): Promise<boolean>;
  /** Recorded migrations of the target database, or throws with a safe code. Read-only. */
  readMigrations(databaseUrl: string): Promise<RecordedMigration[]>;
  expectedMigrations: ReturnType<typeof loadExpectedMigrations>;
  /** Pending jobs in signal_queue / market_queue that a worker could consume. Read-only. */
  pendingQueueJobs(redisUrl: string): Promise<number>;
}

export interface PreflightResult {
  database: string;
  migrations: number;
}

export async function preflight(deps: PreflightDeps): Promise<PreflightResult> {
  const { env } = deps;
  if (!evaluateLiveGuard(env).ok) throw new PreflightError("LIVE_TRADING must be unset or exactly 'false' (and TRADING_MODE paper or shadow)");
  if (!env["TWINS_API_KEY"] || env["TWINS_API_KEY"].trim().length < 8) throw new PreflightError("TWINS_API_KEY must be set in your environment (it is never printed; you type it into the viewer)");
  let target: ReturnType<typeof resolveTestTarget>;
  try {
    // The demo is a rehearsal-context use: the existing exact-target rules apply unchanged (loopback, user, allowlisted database, test Redis).
    target = resolveTestTarget({ ...env, TWINS_REHEARSAL: "1", LIVE_TRADING: "false" } as NodeJS.ProcessEnv);
  } catch (e) {
    throw new PreflightError(e instanceof TestTargetError ? (e as Error).message.replace("integration test target refused: ", "") : "invalid target configuration");
  }
  const databaseUrl = env["DATABASE_URL"] ?? "";
  const redisUrl = env["REDIS_URL"] ?? "";

  for (const [name, port] of [["API", deps.apiPort], ["viewer", deps.viewerPort]] as const) {
    if (!(await deps.isPortFree(port))) throw new PreflightError(`the ${name} port ${port} is already in use (an existing process is not touched)`);
  }

  let recorded: RecordedMigration[];
  try {
    recorded = await deps.readMigrations(databaseUrl);
  } catch (e) {
    throw new PreflightError(`cannot read the migration state of '${target.database}' (${(e as { code?: string }).code ?? "connection error"})`);
  }
  const mismatch = describeMigrationMismatch(deps.expectedMigrations, recorded);
  if (mismatch) throw new PreflightError(`'${target.database}' is not at the repository migration state: ${mismatch}. Nothing was migrated.`);

  let pending: number;
  try {
    pending = await deps.pendingQueueJobs(redisUrl);
  } catch (e) {
    throw new PreflightError(`cannot reach the test Redis (${(e as { code?: string }).code ?? "connection error"})`);
  }
  if (pending > 0) throw new PreflightError(`${pending} job(s) are already pending in signal_queue/market_queue; a demo worker would consume unrelated work. Nothing was touched.`);

  return { database: target.database, migrations: recorded.length };
}

export const realDeps = (env: Record<string, string | undefined>, apiPort = API_PORT, viewerPort = VIEWER_PORT): PreflightDeps => ({
  env,
  apiPort,
  viewerPort,
  isPortFree: (port) =>
    new Promise((resolveFree) => {
      const s = net.createServer();
      s.once("error", () => resolveFree(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolveFree(true)));
    }),
  async readMigrations(databaseUrl) {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const exists = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as ok");
      if (!exists.rows[0]?.ok) return [];
      const { rows } = await client.query("select hash, created_at from drizzle.__drizzle_migrations order by id");
      return rows as RecordedMigration[];
    } finally {
      await client.end().catch(() => undefined);
    }
  },
  expectedMigrations: loadExpectedMigrations(),
  async pendingQueueJobs(redisUrl) {
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 3000 });
    try {
      await redis.connect();
      let n = 0;
      for (const q of ["signal_queue", "market_queue"]) {
        for (const k of ["wait", "paused", "active"]) n += await redis.llen(`bull:${q}:${k}`);
        for (const k of ["delayed", "prioritized", "waiting-children"]) n += await redis.zcard(`bull:${q}:${k}`);
      }
      return n;
    } finally {
      redis.disconnect();
    }
  },
});

// ---------------------------------------------------------------------------------------------------- child environments
const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG"];
function baseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (env[k]) out[k] = env[k] as string;
  out["LIVE_TRADING"] = "false";
  out["TRADING_MODE"] = "paper";
  out["APP_ENV"] = "development";
  return out;
}

/** Minimal per-process environments: each child gets only what it needs. The webhook secret exists in the API's only. */
export function buildChildEnvs(env: Record<string, string | undefined>, webhookSecret: string, approvedChatId: number, apiPort = API_PORT) {
  const db = { DATABASE_URL: env["DATABASE_URL"] ?? "", REDIS_URL: env["REDIS_URL"] ?? "" };
  // Telegram intake is deny-by-default: the demo approves exactly the one chat it generated, and runs options-only.
  const intake = { TWINS_TELEGRAM_ALLOWED_CHAT_IDS: String(approvedChatId), TWINS_TELEGRAM_OPTIONS_ONLY: "true" };
  return {
    api: { ...baseEnv(env), ...db, ...intake, HOST: "127.0.0.1", PORT: String(apiPort), TWINS_API_KEY: env["TWINS_API_KEY"] ?? "", TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_SIGNAL_EXCHANGE: "NSE" },
    // The manual reference is attached EXPLICITLY for the demo (and is printed as such); the worker never attaches one otherwise.
    worker: { ...baseEnv(env), ...db, ...intake, TELEGRAM_SIGNAL_EXCHANGE: "NSE", TWINS_OPTIONS_MANUAL_REFERENCE: MANUAL_REFERENCE },
    viewer: { ...baseEnv(env) },
  };
}

// ---------------------------------------------------------------------------------------------------- owned processes
export interface OwnedProcess {
  name: string;
  /** Process-group leader pid (children are spawned detached, so the group contains only what WE started). */
  pid: number;
  child: ChildProcess;
}

export class ProcessSet {
  private readonly owned: OwnedProcess[] = [];

  start(name: string, command: string, args: string[], env: Record<string, string>, logFile: string, cwd = REPO_ROOT): OwnedProcess {
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
      if (child.pid === undefined) throw new Error(`failed to start ${name}`);
      const p = { name, pid: child.pid, child };
      this.owned.push(p);
      child.unref();
      return p;
    } finally {
      closeSync(fd);
    }
  }

  get names(): string[] {
    return this.owned.map((p) => p.name);
  }

  private groupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Stops ONLY the process groups this set started: SIGTERM, then SIGKILL after the grace period. Idempotent. */
  async stopAll(graceMs = 5000): Promise<void> {
    for (const p of [...this.owned].reverse()) {
      if (!this.groupAlive(p.pid)) continue;
      try { process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.owned.some((p) => this.groupAlive(p.pid))) await new Promise((r) => setTimeout(r, 100));
    for (const p of this.owned) if (this.groupAlive(p.pid)) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
    this.owned.length = 0;
  }
}

export const childArgs = (entry: string, extra: string[] = []) => ["--import", "tsx", "--import", GUARD_PRELOAD, join(REPO_ROOT, entry), ...extra];

// ---------------------------------------------------------------------------------------------------- submit + discover
export function buildWebhookPayload(seed: number = Date.now(), random: () => number = Math.random) {
  const messageId = (seed % 1_000_000_000) + Math.floor(random() * 1000);
  const chatId = -(1_000_000_000_000 + Math.floor(random() * 1_000_000_000));
  return {
    chatId,
    messageId,
    channelIdentifier: `tg_chat_${chatId}`,
    body: { update_id: messageId, channel_post: { message_id: messageId, date: Math.floor(seed / 1000), chat: { id: chatId, type: "channel", username: "twins_offline_demo" }, text: HYPOTHETICAL_MESSAGE } },
  };
}

export interface ClaimLookup {
  /** Returns the internal telegram_messages id and the number of options_claims rows for it, or null if the message is not stored yet. */
  find(channelIdentifier: string, externalMessageId: string): Promise<{ messageId: string; claimRows: number } | null>;
}

export async function waitForClaim(lookup: ClaimLookup, channelIdentifier: string, externalMessageId: string, timeoutMs = 60_000, pollMs = 500): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await lookup.find(channelIdentifier, externalMessageId);
    if (hit && hit.claimRows > 0) return hit.messageId;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the options claim record (check the worker log)");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function pgClaimLookup(databaseUrl: string): { lookup: ClaimLookup; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  return {
    lookup: {
      async find(channelIdentifier, externalMessageId) {
        const r = await pool.query(
          `select m.id as id, (select count(*)::int from options_claims c where c.telegram_message_id = m.id) as n
             from telegram_messages m join telegram_sources s on s.id = m.telegram_source_id
            where s.channel_identifier = $1 and m.external_message_id = $2`,
          [channelIdentifier, externalMessageId],
        );
        const row = r.rows[0] as { id: string; n: number } | undefined;
        return row ? { messageId: row.id, claimRows: row.n } : null;
      },
    },
    close: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------------------------------- orchestration
async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not become ready in time`);
}

export async function runDemo(env: Record<string, string | undefined>, out: (l: string) => void = console.log): Promise<number> {
  const deps = realDeps(env);
  const pre = await preflight(deps);
  out(`Preflight OK: database '${pre.database}' (${pre.migrations} migrations, matches the repository), test Redis idle, ports ${API_PORT}/${VIEWER_PORT} free.`);

  const webhookSecret = randomBytes(24).toString("hex"); // in memory only
  const payload = buildWebhookPayload(); // generated first: its chat id is the only chat the children approve
  const envs = buildChildEnvs(env, webhookSecret, payload.chatId);
  const runDir = join(tmpdir(), `twins-options-demo-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const procs = new ProcessSet();
  const claimDb = pgClaimLookup(env["DATABASE_URL"] ?? "");
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    out("Stopping the demo-owned processes (database records are retained)...");
    await procs.stopAll();
    await claimDb.close().catch(() => undefined);
  };
  const onSignal = () => { void shutdown().then(() => process.exit(0)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const apiLog = join(runDir, "api.log"), workerLog = join(runDir, "worker.log"), viewerLog = join(runDir, "viewer.log");
    procs.start("api", process.execPath, childArgs("apps/api/src/index.ts"), envs.api, apiLog);
    procs.start("worker", process.execPath, childArgs("services/worker/src/index.ts"), envs.worker, workerLog);
    procs.start("viewer", process.execPath, childArgs("apps/web/src/server.ts", ["--api", `http://127.0.0.1:${API_PORT}`, "--port", String(VIEWER_PORT)]), envs.viewer, viewerLog);
    await waitUntil("API", async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok);
    await waitUntil("viewer", async () => (await fetch(`http://127.0.0.1:${VIEWER_PORT}/`)).ok);
    await waitUntil("worker", async () => readFileSync(workerLog, "utf8").includes("[worker] listening"));
    out(`Started (owned by this demo): ${procs.names.join(", ")}. Logs: ${runDir}`);
    out("Worker options reference: the MANUAL reference file is attached explicitly for this demo (not live entitlement; does not prove tradability).");

    out(`Submitting ONE hypothetical message (not a recommendation): ${HYPOTHETICAL_MESSAGE}`);
    const res = await fetch(`http://127.0.0.1:${API_PORT}/webhooks/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhookSecret },
      body: JSON.stringify(payload.body),
    });
    if (res.status !== 202) throw new Error(`the webhook answered ${res.status}, expected 202`);
    const messageId = await waitForClaim(claimDb.lookup, payload.channelIdentifier, String(payload.messageId));

    out("");
    out(`Message id : ${messageId}`);
    out(`Viewer     : http://127.0.0.1:${VIEWER_PORT}   (enter the message id and your TWINS_API_KEY; nothing is stored)`);
    out("Press Ctrl+C to stop the API, worker and viewer started by this demo. Database records are kept.");
    await new Promise<void>(() => undefined);
    return 0;
  } catch (e) {
    out(`Demo failed: ${e instanceof Error ? e.message : "error"}`);
    await shutdown();
    return 1;
  }
}


// ---------------------------------------------------------------------------------------------------- --verify mode
export interface VerifyCounts {
  instruments: number;
  signals: number;
  orders: number;
  optionsClaims: number;
  telegramMessages: number;
  migrations: number;
}

export interface OwnedHandle {
  names: string[];
  stop(): Promise<void>;
}

/** Everything --verify touches in the outside world, injectable so the verification logic is unit-testable without services. */
export interface VerifyOps {
  preflight(env: Record<string, string | undefined>): Promise<PreflightResult>;
  /** Starts the three owned processes with the given per-child environments; returns a handle that stops only them. */
  start(envs: ReturnType<typeof buildChildEnvs>, runDir: string): OwnedHandle;
  /** Resolves which services answered within the readiness window. */
  waitReady(runDir: string): Promise<{ api: boolean; viewer: boolean; worker: boolean }>;
  fetch: typeof fetch;
  lookup: ClaimLookup;
  counts(): Promise<VerifyCounts>;
  /** "result_kind|assessment_outcome|approval_possible|parser_version" of the stored row. */
  storedRow(messageId: string): Promise<string>;
  /** Concatenated child logs. */
  readLogs(runDir: string): string;
  portsFree(): Promise<boolean>;
  close(): Promise<void>;
  newKey(): string;
  now(): number;
  /** Bounded wait for the claim row (default 60 s); tests shorten it. */
  claimTimeoutMs?: number;
}

export interface VerifyReport {
  ok: boolean;
  results: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function runVerify(env: Record<string, string | undefined>, ops: VerifyOps, out: (l: string) => void = console.log): Promise<number> {
  // Fresh throwaway credentials, in memory only. Any TWINS_API_KEY in the caller's environment is neither used nor inherited.
  const apiKey = ops.newKey();
  const webhookSecret = ops.newKey();
  const verifyEnv: Record<string, string | undefined> = { ...env, TWINS_API_KEY: apiKey };
  const redact = (t: string) => t.split(apiKey).join("<key>").split(webhookSecret).join("<secret>");
  const say = (l: string) => out(redact(l));
  const results: VerifyReport["results"] = [];
  const step = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  };

  let pre: PreflightResult;
  try {
    pre = await ops.preflight(verifyEnv);
  } catch (e) {
    if (e instanceof PreflightError) { say(e.message); return 2; }
    say("verify failed during preflight");
    return 1;
  }
  step("preflight (database, migrations, ports, queues)", true, `'${pre.database}', ${pre.migrations} migrations`);

  const runDir = join(tmpdir(), `twins-options-demo-verify-${ops.now()}`);
  mkdirSync(runDir, { recursive: true });
  let owned: OwnedHandle | undefined;
  try {
    const before = await ops.counts();
    const payload = buildWebhookPayload(ops.now()); // generated first: its chat id is the only chat the children approve
    owned = ops.start(buildChildEnvs(verifyEnv, webhookSecret, payload.chatId), runDir);
    const ready = await ops.waitReady(runDir);
    step("start only demo-owned API, worker, viewer", ready.api && ready.viewer && ready.worker && owned.names.join() === "api,worker,viewer", owned.names.join(","));
    if (!(ready.api && ready.viewer && ready.worker)) throw new Error("a service did not become ready");

    const res = await ops.fetch(`http://127.0.0.1:${API_PORT}/webhooks/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhookSecret },
      body: JSON.stringify(payload.body),
    });
    step("exactly one hypothetical message accepted by the local webhook", res.status === 202, `HTTP ${res.status}`);
    if (res.status !== 202) throw new Error("the webhook did not accept the message");

    const messageId = await waitForClaim(ops.lookup, payload.channelIdentifier, String(payload.messageId), ops.claimTimeoutMs ?? 60_000, ops.claimTimeoutMs === undefined ? 500 : 5);
    step("message reached a stored options-claim row", /^[0-9a-f-]{36}$/i.test(messageId), `message id ${messageId}`);
    const row = await ops.storedRow(messageId);
    step("stored row: claim, INSUFFICIENT_EVIDENCE, approval_possible=false", row.startsWith("claim|INSUFFICIENT_EVIDENCE|false|"), row);

    const apiUrl = `http://127.0.0.1:${API_PORT}/options-claims/${messageId}`;
    const [noTok, wrongTok, okTok] = [await ops.fetch(apiUrl), await ops.fetch(apiUrl, { headers: { authorization: "Bearer not-the-key" } }), await ops.fetch(apiUrl, { headers: { authorization: `Bearer ${apiKey}` } })];
    const apiBody = (await okTok.json()) as { versionCount?: number; claims?: Array<{ resultKind?: string; approvalPossible?: boolean }> };
    step(
      "authenticated API returns the row (401 without / wrong token)",
      okTok.status === 200 && noTok.status === 401 && wrongTok.status === 401 && apiBody.versionCount === 1 && apiBody.claims?.[0]?.resultKind === "claim" && apiBody.claims?.[0]?.approvalPossible === false,
      `${okTok.status}/${noTok.status}/${wrongTok.status}`,
    );

    const viewUrl = `http://127.0.0.1:${VIEWER_PORT}/view/options-claims/${messageId}`;
    const [vNo, vOk] = [await ops.fetch(viewUrl), await ops.fetch(viewUrl, { headers: { authorization: `Bearer ${apiKey}` } })];
    const view = (await vOk.json()) as { versions?: Array<{ kind?: string; banner?: string; approvalPossible?: boolean }> };
    const v0 = view.versions?.[0];
    step(
      "viewer stored-result response (401 without token)",
      vOk.status === 200 && vNo.status === 401 && v0?.kind === "claim" && v0.banner === "Stored assessment — not an order" && v0.approvalPossible === false,
      `${vOk.status}/${vNo.status}`,
    );
    const page = await ops.fetch(`http://127.0.0.1:${VIEWER_PORT}/`);
    step("viewer page served (HTTP only; NOT a browser rendering check)", page.status === 200, `HTTP ${page.status}`);

    const after = await ops.counts();
    const d = { signals: after.signals - before.signals, instruments: after.instruments - before.instruments, orders: after.orders - before.orders, optionsClaims: after.optionsClaims - before.optionsClaims, messages: after.telegramMessages - before.telegramMessages, migrations: after.migrations - before.migrations };
    step("no signal, instrument or order created; only the expected writes", d.signals === 0 && d.instruments === 0 && d.orders === 0 && d.migrations === 0 && d.optionsClaims === 1 && d.messages === 1, JSON.stringify(d));

    const logs = ops.readLogs(runDir);
    step("no secret in any child log; no external-request attempt logged", !logs.includes(apiKey) && !logs.includes(webhookSecret) && !logs.includes("EXTERNAL_NETWORK_BLOCKED"), `logs in ${runDir}`);
  } catch (e) {
    step("run", false, e instanceof Error ? e.message : "error");
  } finally {
    let stopped = true;
    try {
      await owned?.stop();
    } catch {
      stopped = false;
    }
    const free = stopped && (await ops.portsFree().catch(() => false));
    step("demo-owned processes stopped, ports free, records retained", free, `ports ${API_PORT}/${VIEWER_PORT} free: ${free}`);
    await ops.close().catch(() => undefined);
  }
  const ok = results.every((r) => r.ok);
  say(`RESULT: ${ok ? "PASS" : "FAIL"}   (browser rendering: NOT INSPECTED)`);
  return ok ? 0 : 1;
}

export function realVerifyOps(env: Record<string, string | undefined>): VerifyOps {
  const databaseUrl = env["DATABASE_URL"] ?? "";
  const claimDb = pgClaimLookup(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const count = async (table: string) => Number((await pool.query(`select count(*)::int as n from ${table}`)).rows[0]?.n ?? 0);
  let procs: ProcessSet | undefined;
  const waitUntil = async (probe: () => Promise<boolean>, ms = 45_000) => {
    const d = Date.now() + ms;
    while (Date.now() < d) {
      if (await probe().catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  return {
    preflight: (e) => preflight(realDeps(e)),
    start(envs, runDir) {
      procs = new ProcessSet();
      procs.start("api", process.execPath, childArgs("apps/api/src/index.ts"), envs.api, join(runDir, "api.log"));
      procs.start("worker", process.execPath, childArgs("services/worker/src/index.ts"), envs.worker, join(runDir, "worker.log"));
      procs.start("viewer", process.execPath, childArgs("apps/web/src/server.ts", ["--api", `http://127.0.0.1:${API_PORT}`, "--port", String(VIEWER_PORT)]), envs.viewer, join(runDir, "viewer.log"));
      const set = procs;
      return { names: set.names, stop: () => set.stopAll() };
    },
    async waitReady(runDir) {
      const [api, viewer, worker] = await Promise.all([
        waitUntil(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok),
        waitUntil(async () => (await fetch(`http://127.0.0.1:${VIEWER_PORT}/`)).ok),
        waitUntil(async () => readFileSync(join(runDir, "worker.log"), "utf8").includes("[worker] listening")),
      ]);
      return { api, viewer, worker };
    },
    fetch: (input, init) => fetch(input, init),
    lookup: claimDb.lookup,
    async counts() {
      return {
        instruments: await count("instruments"), signals: await count("signals"), orders: await count("orders"),
        optionsClaims: await count("options_claims"), telegramMessages: await count("telegram_messages"), migrations: await count("drizzle.__drizzle_migrations"),
      };
    },
    async storedRow(messageId) {
      const r = await pool.query("select result_kind || '|' || coalesce(assessment_outcome, '-') || '|' || approval_possible || '|' || parser_version as row from options_claims where telegram_message_id = $1", [messageId]);
      return String(r.rows[0]?.row ?? "no row");
    },
    readLogs: (runDir) => readdirSync(runDir).map((f) => readFileSync(join(runDir, f), "utf8")).join("\n"),
    portsFree: async () => {
      const d = realDeps(env);
      return (await d.isPortFree(API_PORT)) && (await d.isPortFree(VIEWER_PORT));
    },
    async close() {
      await claimDb.close();
      await pool.end();
    },
    newKey: () => randomBytes(24).toString("hex"),
    now: () => Date.now(),
  };
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (l: string) => void = console.log): Promise<number> {
  installNetworkGuard();
  try {
    if (argv.includes("--verify")) return await runVerify(env, realVerifyOps(env), out);
    if (argv.includes("--check")) {
      const pre = await preflight(realDeps(env));
      out(`Preflight OK: database '${pre.database}' (${pre.migrations} migrations match the repository), test Redis idle, ports ${API_PORT}/${VIEWER_PORT} free. Nothing was started.`);
      return 0;
    }
    return await runDemo(env, out);
  } catch (e) {
    if (e instanceof PreflightError) {
      out(e.message);
      return 2;
    }
    out(`Demo failed: ${e instanceof Error ? e.name : "error"}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("scripts/options-demo.ts")) {
  enforceLiveTradingGuard("options-demo");
  void main(process.argv.slice(2), process.env).then((c) => process.exit(c));
}
