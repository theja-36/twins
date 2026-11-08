/**
 * Off-host backup against REAL PostgreSQL (disposable twins_ci target): real pg_dump at an exported snapshot, real age encryption, a directory object store
 * (clearly NOT off-host: this proves the pipeline; the real-provider upload and the cross-host drill are recorded separately in the docs), real pg_restore into a scratch
 * database, exact row-count / chain-head comparison and the real audit-chain verifier on the restored copy.
 * PostgreSQL client tools: local `pg_dump`/`pg_restore` (CI installs postgresql-client), or `docker exec` into the named container when TWINS_BACKUP_TEST_PG_CONTAINER is set.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDirStore, databaseScratch, dockerPgTools, dumpWithFacts, localPgTools, readStatus, runBackup, runDrill, DEFAULT_RETENTION, type PgTools,
} from "../../../packages/backup/src/index";
import { restoreHooks } from "../../../scripts/ops/offhost-backup";
import { files, keypair, tmp } from "../../unit/backup/helpers";
import { DATABASE_URL } from "../runtime/harness";

const container = process.env["TWINS_BACKUP_TEST_PG_CONTAINER"];
const tools: PgTools = container ? dockerPgTools(container) : localPgTools(DATABASE_URL);
let root: string;
let pool: pg.Pool;

beforeAll(async () => {
  root = await tmp("twins-backup-it-");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  // make sure there is chain data to protect
  await pool.query("insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), 'backup.test.seed', 'test', NULL, 'system', 'backup-it', '{}')");
});
afterAll(async () => { await pool?.end(); });

describe("real database -> encrypted bundle -> object store -> scratch restore", () => {
  it("backs up with a consistent snapshot, uploads, restores into an isolated scratch database, matches counts and chain heads, verifies the audit chain, and cleans up", async () => {
    const { recipient, identityFile } = await keypair(root);
    const store = createDirStore(join(root, "bucket"));
    const logs: Array<Record<string, unknown>> = [];
    const log = (event: string, fields: Record<string, unknown> = {}) => { logs.push({ event, ...fields }); };
    const statusDir = join(root, "status");
    const result = await runBackup({
      store, environment: "ci", recipient, spoolDir: join(root, "spool"), statusDir, manifestLog: join(root, "manifest.jsonl"),
      retention: DEFAULT_RETENTION, hostFingerprint: "ci-source-host", log, now: () => new Date(),
      configFiles: [], anchorPath: undefined,
      dump: async (work) => { const dumpPath = join(work, "database.dump"); return { dumpPath, facts: await dumpWithFacts(DATABASE_URL, tools, dumpPath) }; },
      recordAudit: async (m) => {
        await pool.query("insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), 'backup.created', 'backup', NULL, 'system', 'offhost-backup', $1)", [JSON.stringify({ name: m.name, sha256: m.sha256 })]);
      },
    });
    expect(result.auditRecorded).toBe(true);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(JSON.stringify(logs)).not.toMatch(/postgresql:\/\/|AGE-SECRET-KEY/);
    // nothing in the store is plaintext SQL / dump
    for (const f of await files(join(root, "bucket"))) {
      if (f.endsWith(".manifest.json")) continue;
      const head = (await readFile(f)).subarray(0, 21).toString("latin1");
      expect(head).toBe("age-encryption.org/v1");
    }
    const manifest = JSON.parse(await readFile(join(root, "manifest.jsonl"), "utf8")) as { snapshot: { migrations: number; tableCounts: Record<string, number>; chainHeads: Record<string, unknown> } };
    expect(manifest.snapshot.migrations).toBe(38);
    expect(Object.keys(manifest.snapshot.chainHeads).sort()).toEqual(["agent_definitions", "agent_evidence_references", "agent_findings", "agent_orchestrator_runs", "agent_orchestrator_syntheses", "agent_runs", "audit_events", "circuit_breaker_events", "event_blackout_windows", "historical_confidence_estimates", "historical_confidence_runs", "historical_datasets", "historical_evaluation_events", "historical_evaluation_runs", "historical_outcome_labels", "historical_pattern_definitions", "historical_pattern_runs", "historical_pattern_snapshots", "historical_scorecard_events", "historical_scorecard_metrics", "historical_scorecard_runs", "historical_source_records", "historical_source_registry", "historical_trust_tiers", "loss_events", "options_claims", "risk_approvals", "risk_decisions", "signal_validations", "stop_loss_validations", "system_control_events", "telegram_messages"]);
    expect(manifest.snapshot.tableCounts["audit_events"]).toBeGreaterThan(0);

    const hooks = restoreHooks(process.cwd());
    const drill = await runDrill({
      store, environment: "ci", identityFile, statusDir, workDir: join(root, "drill"), log, now: () => new Date(), hostFingerprint: "ci-recovery-host", runnerLabel: "ci-runner-scratch-database",
      createScratch: databaseScratch(DATABASE_URL, hooks, container ? { dockerContainer: container } : {}),
    });
    expect(drill.checks).toMatchObject({ encrypted_sha256: "match", decrypt: "ok", dump_sha256: "match", restore: "ok", migrations: "38" });
    expect(drill.checks["row_counts"]).toMatch(/tables match/);
    expect(drill.checks["chain_heads"]).toBe("32 chains match");
    expect(drill.checks["audit_chain"]).toMatch(/PASS/);
    expect(drill.checks["verify_migrations"]).toMatch(/38 migrations/);
    expect(drill.crossHost).toBe(true);
    expect((await readStatus(statusDir, "drill", new Date(), 100)).ok).toBe(true);
    // the scratch database is gone and no plaintext is left behind
    const left = await pool.query("select datname from pg_database where datname like 'twins_drill_%'");
    expect(left.rows).toEqual([]);
    expect(await files(join(root, "drill"))).toEqual([]);
  }, 180_000);
});
