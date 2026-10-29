import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import pg from "pg";
import { collectFacts, type Queryable } from "./facts";
import type { SnapshotFacts } from "./manifest";
import type { ScratchDatabase } from "./pipeline";

const exec = promisify(execFile);
const SNAPSHOT = /^[0-9A-F]{1,16}(?:-[0-9A-F]{1,16}){1,2}$/;

/** Runs PostgreSQL client tools either locally or inside a container (`docker exec`). Credentials travel in the environment / container, never on argv. */
export interface PgTools {
  /** Writes a custom-format dump of the CONFIGURED source database at the exported snapshot to `outPath`. */
  dump(snapshot: string, outPath: string): Promise<void>;
}

function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
}

async function streamTo(child: ReturnType<typeof spawn>, outPath: string): Promise<void> {
  const out = createWriteStream(outPath, { mode: 0o600 });
  let stderr = 0;
  child.stderr?.on("data", (d: Buffer) => { stderr += d.length; });
  const exit = new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve(code ?? -1)); });
  await pipeline(child.stdout as NodeJS.ReadableStream, out);
  if ((await exit) !== 0) throw new Error(`dump tool failed (stderr ${stderr} bytes)`); // tool output is never surfaced: it can contain object names
  await chmod(outPath, 0o600);
}

export function localPgTools(databaseUrl: string, bin = "pg_dump"): PgTools {
  return {
    async dump(snapshot, outPath) {
      if (!SNAPSHOT.test(snapshot)) throw new Error("bad snapshot id");
      await streamTo(spawn(bin, ["-Fc", `--snapshot=${snapshot}`], { env: { ...process.env, ...pgEnv(databaseUrl) }, stdio: ["ignore", "pipe", "pipe"] }), outPath);
    },
  };
}

/** pg_dump inside a running PostgreSQL container (the staging layout: the database is only reachable inside the compose network). */
export function dockerPgTools(container: string, docker = "docker"): PgTools {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(container)) throw new Error("bad container name");
  return {
    async dump(snapshot, outPath) {
      if (!SNAPSHOT.test(snapshot)) throw new Error("bad snapshot id");
      await streamTo(spawn(docker, ["exec", container, "sh", "-c", `exec pg_dump -Fc --snapshot=${snapshot} -U "$POSTGRES_USER" -d "$POSTGRES_DB"`], { stdio: ["ignore", "pipe", "pipe"] }), outPath);
    },
  };
}

/**
 * Takes ONE exported snapshot, reads the non-sensitive facts at it and dumps at the same snapshot, so counts and chain heads describe exactly the data in the dump.
 * `databaseUrl` is used only for the snapshot session; the dump tool uses its own connection (container env or PG* env).
 */
export async function dumpWithFacts(databaseUrl: string, tools: PgTools, outPath: string): Promise<SnapshotFacts> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "twins-offhost-backup", connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = String(((await client.query("select pg_export_snapshot() as s")).rows[0] ?? {})["s"]);
    const facts = await collectFacts(client as Queryable);
    await tools.dump(snapshot, outPath);
    await client.query("COMMIT");
    return facts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ───────────────────────────── scratch databases for the restore drill ─────────────────────────────

export interface ScratchHooks {
  verifyAudit(url: string, anchorCopy: string | undefined): Promise<{ ok: boolean; detail: string }>;
  verifyMigrations(url: string): Promise<{ ok: boolean; detail: string }>;
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
    c.on("error", () => undefined);
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch {
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("scratch database did not become ready");
}

/** A throwaway PostgreSQL container on loopback: works on any host with Docker (this is the "recovery host" path). Destroyed afterwards. */
export function dockerScratch(hooks: ScratchHooks, options: { image?: string; docker?: string } = {}): () => Promise<ScratchDatabase> {
  const image = options.image ?? "postgres:16-alpine";
  const docker = options.docker ?? "docker";
  return async () => {
    const name = `twins-drill-${randomBytes(4).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    await exec(docker, ["run", "-d", "--rm", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=twins_drill", "-p", "127.0.0.1::5432", image]);
    const destroy = async (): Promise<void> => { if (name.startsWith("twins-drill-")) await exec(docker, ["rm", "-f", name]).catch(() => undefined); };
    try {
      const portLine = (await exec(docker, ["port", name, "5432/tcp"])).stdout.trim().split("\n")[0] ?? "";
      const port = portLine.split(":").pop();
      if (!port || !/^[0-9]+$/.test(port)) throw new Error("no mapped port");
      const url = `postgresql://postgres:${password}@127.0.0.1:${port}/twins_drill`;
      await waitReady(url);
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      pool.on("error", () => undefined);
      return {
        label: `docker:${image}`,
        async restore(dumpPath) {
          const child = spawn(docker, ["exec", "-i", name, "pg_restore", "--no-owner", "--no-privileges", "-U", "postgres", "-d", "twins_drill"], { stdio: ["pipe", "ignore", "ignore"] });
          const exit = new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", (c) => resolve(c ?? -1)); });
          await pipeline(createReadStream(dumpPath), child.stdin);
          if ((await exit) !== 0) throw new Error("pg_restore failed");
        },
        facts: () => collectFacts(pool as unknown as Queryable),
        verifyAudit: (anchor) => hooks.verifyAudit(url, anchor),
        verifyMigrations: () => hooks.verifyMigrations(url),
        async destroy() { await pool.end().catch(() => undefined); await destroy(); },
      };
    } catch (error) {
      await destroy();
      throw error;
    }
  };
}

/** A scratch DATABASE (name must start `twins_drill_`) on an existing server, restored with local pg_restore. For rehearsal and CI. */
export function databaseScratch(adminUrl: string, hooks: ScratchHooks, options: { restoreBin?: string; dockerContainer?: string } = {}): () => Promise<ScratchDatabase> {
  const restoreBin = options.restoreBin ?? "pg_restore";
  return async () => {
    const name = `twins_drill_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", () => undefined);
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    const url = u.toString();
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    pool.on("error", () => undefined);
    return {
      label: `database:${name}`,
      async restore(dumpPath) {
        const container = options.dockerContainer;
        const child = container
          ? spawn("docker", ["exec", "-i", container, "sh", "-c", `exec pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d ${name}`], { stdio: ["pipe", "ignore", "ignore"] })
          : spawn(restoreBin, ["--no-owner", "--no-privileges", "-d", name, dumpPath], { env: { ...process.env, ...pgEnv(adminUrl) }, stdio: ["ignore", "ignore", "ignore"] });
        const code = new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", (c) => resolve(c ?? -1)); });
        if (container) await pipeline(createReadStream(dumpPath), child.stdin as NodeJS.WritableStream);
        if ((await code) !== 0) throw new Error("pg_restore failed");
      },
      facts: () => collectFacts(pool as unknown as Queryable),
      verifyAudit: (anchor) => hooks.verifyAudit(url, anchor),
      verifyMigrations: () => hooks.verifyMigrations(url),
      async destroy() {
        await pool.end().catch(() => undefined);
        if (name.startsWith("twins_drill_")) await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      },
    };
  };
}
