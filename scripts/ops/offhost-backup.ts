/**
 * Off-host encrypted backups and restore drill (Stage 2 / Task 3). Design: docs/twins/OFF_HOST_BACKUP_AND_RECOVERY.md.
 *
 *   offhost-backup backup                 snapshot + dump, bundle, encrypt (public age recipient), upload, re-download and re-checksum   [backup host]
 *   offhost-backup verify                 weekly: re-checksum recent off-host objects against their manifests (NO key needed)           [backup host or anywhere]
 *   offhost-backup drill [--key <k>]      monthly: download, verify, decrypt, restore into a scratch database, compare, audit-verify   [RECOVERY host; needs the private key]
 *   offhost-backup prune [--apply]        apply the retention policy (dry-run by default); needs a credential that can delete         [operator workstation, NOT the backup host]
 *   offhost-backup status <backup|verify|drill>   exit 0 only if the last run succeeded and is young enough (for monitoring)
 *
 * Exit codes: 0 ok, 1 the operation failed (details in the structured log and offhost-<kind>.json), 2 usage / configuration error.
 * Credentials are read from the environment only (systemd EnvironmentFile on the host); nothing secret is ever logged.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  type BackupLogger,
  createDirStore, createS3Store, databaseScratch, dockerPgTools, dockerScratch, dumpWithFacts, isAgeRecipient, jsonLogger, localPgTools,
  pruneBackups, readStatus, resolveRetention, runBackup, runDrill, StepError, verifyRemote,
  type BackupManifest, type ObjectStore, type ScratchHooks, type StatusKind,
} from "../../packages/backup/src/index";
import { alerterFromEnv, alertingSink, createAlerter, type Alerter } from "../../packages/alerting/src/index";
import { main as verifyAuditMain } from "./verify-audit-chain";
// @ts-expect-error plain ESM script without types
import { scanText } from "../ci/secret-scan.mjs";

const execFileP = promisify(execFile);
type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

/** Non-secret fingerprint of this host (hostname + machine id when readable). */
export function hostFingerprint(env: Env = process.env): string {
  let machine = "";
  try { machine = readFileSync("/etc/machine-id", "utf8").trim(); } catch { /* not Linux */ }
  return createHash("sha256").update(`${env["TWINS_BACKUP_HOST_ID"] ?? hostname()}|${machine}`).digest("hex").slice(0, 16);
}

export function buildStore(env: Env): ObjectStore {
  const dir = env["TWINS_BACKUP_DIR_STORE"];
  if (dir) {
    if (env["TWINS_BACKUP_ALLOW_DIR_STORE"] !== "1") throw new ConfigError("TWINS_BACKUP_DIR_STORE is a local directory, NOT off-host; set TWINS_BACKUP_ALLOW_DIR_STORE=1 to use it for rehearsal");
    return createDirStore(dir);
  }
  const endpoint = need(env, "TWINS_BACKUP_S3_ENDPOINT");
  if (!/^https:\/\/|^http:\/\/127\.0\.0\.1[:/]|^http:\/\/localhost[:/]/.test(endpoint)) throw new ConfigError("TWINS_BACKUP_S3_ENDPOINT must be https (plain http only for loopback)");
  return createS3Store({
    endpoint, bucket: need(env, "TWINS_BACKUP_S3_BUCKET"), accessKeyId: need(env, "TWINS_BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: need(env, "TWINS_BACKUP_S3_SECRET_ACCESS_KEY"), ...(env["TWINS_BACKUP_S3_REGION"] ? { region: env["TWINS_BACKUP_S3_REGION"] } : {}),
  });
}

const environmentName = (env: Env): string => {
  const v = env["TWINS_BACKUP_ENV_NAME"] ?? "staging";
  if (!/^[a-z0-9-]{1,30}$/.test(v)) throw new ConfigError("TWINS_BACKUP_ENV_NAME must be 1-30 characters of a-z 0-9 -");
  return v;
};
const statusDir = (env: Env): string => env["TWINS_BACKUP_STATUS_DIR"] ?? "/var/lib/twins-monitor";

async function listConfigFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => join(dir, e.name));
}

/** Content check for config files that travel in a bundle: the repository's secret scanner decides. */
const acceptContent = (name: string, content: string): string | undefined => {
  const findings = scanText(`infrastructure/staging/${name}`, content) as Array<{ pattern: string }>;
  return findings.length ? `secret-shaped content (${findings[0]?.pattern})` : undefined;
};

export function restoreHooks(repoRoot: string): ScratchHooks {
  return {
    async verifyAudit(url, anchorCopy) {
      const lines: string[] = [];
      const code = await verifyAuditMain(["--json", ...(anchorCopy ? ["--anchor-file", anchorCopy] : [])], { env: { DATABASE_URL: url }, out: (l) => lines.push(l), err: () => undefined });
      const summary = lines.join("").match(/"ok":(true|false)/)?.[1];
      return { ok: code === 0, detail: code === 0 ? `PASS (anchor ${anchorCopy ? "compared" : "not in bundle"}; ${summary ?? "ok"})` : `exit ${code}` };
    },
    async verifyMigrations(url) {
      const journal = JSON.parse(readFileSync(join(repoRoot, "packages/database/drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] };
      const c = new pg.Client({ connectionString: url });
      c.on("error", () => undefined);
      await c.connect();
      const n = Number(((await c.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0] ?? {})["n"]);
      await c.end();
      if (n !== journal.entries.length) return { ok: true, detail: `structure check skipped: backup is at migration level ${n}, this checkout at ${journal.entries.length}` };
      try {
        await execFileP("node", [join(repoRoot, "scripts/ci/verify-migrations.mjs")], { env: { ...process.env, DATABASE_URL: url, TWINS_VERIFY_RESTORED_COPY: "1" } }); // the scratch restore is --no-owner --no-privileges: ownership, ACLs and roles are not part of the dump
        return { ok: true, detail: `${n} migrations; structures verified` };
      } catch {
        return { ok: false, detail: "verify-migrations failed" };
      }
    },
  };
}

export async function main(argv: string[], env: Env = process.env, out: (l: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const command = argv[0];
  let alerter: Alerter;
  try { alerter = alerterFromEnv(env, "offhost-backup"); } catch { alerter = createAlerter({ context: { environment: env["TWINS_ENV_NAME"] ?? "unknown", service: "offhost-backup" } }); }
  const baseLog = jsonLogger(out);
  const raise = alertingSink(() => undefined, alerter);
  /** Structured log line, and an alert for the events in the alert policy (backup/verify/drill failures). */
  const log: BackupLogger = (event, fields = {}) => {
    baseLog(event, fields);
    raise({ ts: new Date().toISOString(), level: event.endsWith(".failed") ? "error" : "info", event, ...fields });
  };
  const repoRoot = resolve(env["TWINS_BACKUP_REPO_DIR"] ?? process.cwd());
  const now = (): Date => new Date();
  try {
    if (command === "status") {
      const kind = argv[1] as StatusKind;
      const limits: Record<string, number> = { backup: 26 * 3600, verify: 8 * 86400, drill: 35 * 86400 };
      if (!(kind in limits)) throw new ConfigError("usage: status <backup|verify|drill>");
      const envName = `TWINS_BACKUP_${kind.toUpperCase()}_MAX_AGE_SECONDS`;
      const r = await readStatus(statusDir(env), kind, now(), Number(env[envName] ?? limits[kind]));
      out(JSON.stringify({ kind, ok: r.ok, reason: r.reason, ...(r.record ? { last: r.record } : {}) }));
      return r.ok ? 0 : 1;
    }
    const store = buildStore(env);
    const envName = environmentName(env);
    let retention;
    try { retention = resolveRetention(env); } catch (e) { throw new ConfigError(e instanceof Error ? e.message : "invalid retention"); }
    if (command === "backup") {
      const recipient = need(env, "TWINS_BACKUP_AGE_RECIPIENT");
      if (!isAgeRecipient(recipient)) throw new ConfigError("TWINS_BACKUP_AGE_RECIPIENT must be an age public key (age1...); never put a private key here");
      if (/AGE-SECRET-KEY/.test(JSON.stringify(env))) throw new ConfigError("a private age key is present in the backup environment; remove it");
      const databaseUrl = need(env, "TWINS_BACKUP_DATABASE_URL");
      const tools = env["TWINS_BACKUP_PG_CONTAINER"] ? dockerPgTools(env["TWINS_BACKUP_PG_CONTAINER"]) : localPgTools(databaseUrl);
      const infra = resolve(repoRoot, env["TWINS_BACKUP_CONFIG_DIR"] ?? "infrastructure/staging");
      await runBackup({
        store, environment: envName, recipient, retention, log, now, hostFingerprint: hostFingerprint(env),
        spoolDir: env["TWINS_BACKUP_SPOOL_DIR"] ?? "/var/lib/twins-backup/spool", statusDir: statusDir(env),
        manifestLog: env["TWINS_BACKUP_MANIFEST_LOG"] ?? "/var/lib/twins-backup/manifest.jsonl",
        anchorPath: env["TWINS_BACKUP_ANCHOR_FILE"] ?? "/var/lib/twins-monitor/audit-anchor.json",
        configFiles: await listConfigFiles(infra), acceptContent,
        dump: async (work) => {
          const dumpPath = join(work, "database.dump");
          return { dumpPath, facts: await dumpWithFacts(databaseUrl, tools, dumpPath) };
        },
        recordAudit: async (m: BackupManifest) => {
          const c = new pg.Client({ connectionString: databaseUrl });
          c.on("error", () => undefined);
          await c.connect();
          try {
            await c.query(
              "insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), 'backup.created', 'backup', NULL, 'system', 'offhost-backup', $1)",
              [JSON.stringify({ name: m.name, sha256: m.sha256, bytes: m.bytes, classes: m.retentionClasses, encryption: m.encryption, provider: store.kind })],
            );
          } finally { await c.end(); }
        },
      });
      return 0;
    }
    if (command === "verify") {
      const r = await verifyRemote({ store, environment: envName, statusDir: statusDir(env), workDir: env["TWINS_BACKUP_SPOOL_DIR"] ? join(env["TWINS_BACKUP_SPOOL_DIR"], "verify") : "/var/lib/twins-backup/verify", log, now });
      return r.problems.length === 0 ? 0 : 1;
    }
    if (command === "drill") {
      const identityFile = need(env, "TWINS_BACKUP_AGE_IDENTITY_FILE");
      const hooks = restoreHooks(repoRoot);
      const scratchUrl = env["TWINS_BACKUP_DRILL_SCRATCH_URL"];
      const keyIdx = argv.indexOf("--key");
      await runDrill({
        store, environment: envName, identityFile, statusDir: statusDir(env), log, now, hostFingerprint: hostFingerprint(env),
        workDir: env["TWINS_BACKUP_DRILL_WORK_DIR"] ?? "/var/lib/twins-backup/drill",
        ...(env["TWINS_BACKUP_RUNNER_LABEL"] ? { runnerLabel: env["TWINS_BACKUP_RUNNER_LABEL"] } : {}),
        ...(keyIdx >= 0 && argv[keyIdx + 1] ? { key: argv[keyIdx + 1] as string } : {}),
        createScratch: scratchUrl ? databaseScratch(scratchUrl, hooks) : dockerScratch(hooks),
      });
      return 0;
    }
    if (command === "prune") {
      const apply = argv.includes("--apply");
      await pruneBackups({ store, environment: envName, retention, statusDir: statusDir(env), log, now, apply });
      return 0;
    }
    throw new ConfigError("usage: offhost-backup <backup|verify|drill|prune|status> [options]");
  } catch (error) {
    if (error instanceof ConfigError) {
      out(JSON.stringify({ ts: now().toISOString(), level: "error", event: "offhost.config_error", message: error.message }));
      // a job that cannot even start is a failed job: it must not fail silently
      const failedEvent = command === "backup" ? "backup.failed" : command === "verify" ? "verify.failed" : command === "drill" ? "drill.failed" : undefined;
      if (failedEvent) raise({ ts: new Date().toISOString(), level: "error", event: failedEvent, step: "config", failure: "config_error" });
      await alerter.flush();
      return 2;
    }
    if (error instanceof StepError) { await alerter.flush(); return 1; } // already logged and written to the status file by the pipeline
    out(JSON.stringify({ ts: now().toISOString(), level: "error", event: "offhost.failed", failure: "unexpected_error", errorName: error instanceof Error ? error.name : "Error" }));
    await alerter.flush();
    return 1;
  } finally {
    await alerter.flush();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
