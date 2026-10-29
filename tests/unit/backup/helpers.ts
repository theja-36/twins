import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { createDirStore, DEFAULT_RETENTION, type BackupDeps, type DrillDeps, type ObjectStore, type ScratchDatabase, type SnapshotFacts } from "../../../packages/backup/src/index";

export const CANARY = "PLAINTEXT-CANARY-8f3a91";
export const FACTS: SnapshotFacts = {
  migrations: 13,
  tableCounts: { audit_events: 3, telegram_messages: 5 },
  chainHeads: { audit_events: { lastIndex: 3, lastHash: "a".repeat(64) }, telegram_messages: { lastIndex: 5, lastHash: "b".repeat(64) } },
};

export async function tmp(prefix = "twins-backup-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Generates a throwaway age keypair for a test; the identity is written to a file exactly as `age-keygen` does. */
export async function keypair(dir: string): Promise<{ recipient: string; identityFile: string }> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const identityFile = join(dir, "test-identity.txt");
  await writeFile(identityFile, `# created: test\n# public key: ${recipient}\n${identity}\n`, { mode: 0o600 });
  return { recipient, identityFile };
}

export async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out;
}

export interface Rig {
  root: string;
  store: ObjectStore;
  storeDir: string;
  recipient: string;
  identityFile: string;
  logs: Array<Record<string, unknown>>;
  clock: { now: Date };
  backupDeps: (over?: Partial<BackupDeps>) => BackupDeps;
  drillDeps: (scratch: ScratchDatabase, over?: Partial<DrillDeps>) => DrillDeps;
}

export async function rig(startAt = new Date("2031-03-12T02:30:00.000Z")): Promise<Rig> {
  const root = await tmp();
  const storeDir = join(root, "bucket");
  await mkdir(storeDir, { recursive: true });
  const store = createDirStore(storeDir);
  const { recipient, identityFile } = await keypair(root);
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: startAt };
  const log = (event: string, fields: Record<string, unknown> = {}): void => { logs.push({ event, ...fields }); };
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "staging.env.example"), "POSTGRES_PASSWORD=CHANGE_ME\n");
  await writeFile(join(configDir, "docker-compose.staging.yml"), "services: {}\n");
  await writeFile(join(configDir, "staging.env"), "POSTGRES_PASSWORD=real-looking-secret-value\n"); // a real env file must never travel
  await writeFile(join(configDir, "backup.key"), "AGE-SECRET-KEY-1NOTREALNOTREALNOTREAL\n");
  const anchor = join(root, "audit-anchor.json");
  await writeFile(anchor, JSON.stringify({ heads: { audit_events: 3 } }));
  let n = 0;
  return {
    root, store, storeDir, recipient, identityFile, logs, clock,
    backupDeps: (over = {}) => ({
      store, environment: "staging", recipient, spoolDir: join(root, "spool"), statusDir: join(root, "status"), manifestLog: join(root, "manifest.jsonl"),
      retention: DEFAULT_RETENTION, hostFingerprint: "hostA", log, now: () => clock.now, anchorPath: anchor,
      configFiles: [join(configDir, "staging.env.example"), join(configDir, "docker-compose.staging.yml"), join(configDir, "staging.env"), join(configDir, "backup.key")],
      dump: async (work) => {
        n += 1;
        const dumpPath = join(work, "database.dump");
        await writeFile(dumpPath, `PGDMP-fake-dump-${n} ${CANARY}\n`);
        return { dumpPath, facts: FACTS };
      },
      ...over,
    }),
    drillDeps: (scratch, over = {}) => ({
      store, environment: "staging", identityFile, statusDir: join(root, "status"), workDir: join(root, "drill"), log, now: () => clock.now,
      hostFingerprint: "hostB", runnerLabel: "test-recovery-host", createScratch: async () => scratch, ...over,
    }),
  };
}

export function fakeScratch(over: Partial<ScratchDatabase> & { facts?: () => Promise<SnapshotFacts> } = {}): ScratchDatabase & { restored: string[]; destroyed: number } {
  const state = { restored: [] as string[], destroyed: 0 };
  return Object.assign(state, {
    label: "fake-scratch",
    restore: async (p: string) => { state.restored.push(p); },
    facts: async () => FACTS,
    verifyAudit: async () => ({ ok: true, detail: "PASS" }),
    verifyMigrations: async () => ({ ok: true, detail: "13 migrations" }),
    destroy: async () => { state.destroyed += 1; },
    ...over,
  }) as ScratchDatabase & { restored: string[]; destroyed: number };
}
