import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTar, extractTar, stageBundle, wipeDir, wipeFile, type BundleInput } from "./bundle";
import { BackupCryptoError, decryptFile, encryptFile, recipientFingerprint } from "./crypto";
import {
  appendManifestLog, artifactName, timestampFromKey, ENCRYPTION_METHOD, MANIFEST_VERSION, parseManifest, sha256File,
  type BackupManifest, type SnapshotFacts,
} from "./manifest";
import { classesForNewBackup, planPrune, RETENTION_CLASSES, type ExistingObject, type RetentionClass, type RetentionPolicy } from "./retention";
import { StepError, writeStatus, type BackupLogger } from "./status";
import { StoreError, type ObjectStore } from "./store";

const AGE_HEADER = "age-encryption.org/v1";
export const objectKey = (cls: RetentionClass, env: string, name: string): string => `${cls}/${env}/${name}`;
/** Artifacts under a class prefix, newest first, by the time encoded in their NAME (not the provider's modification time). */
async function listArtifacts(store: ObjectStore, cls: RetentionClass, env: string): Promise<Array<ExistingObject & { bytes: number }>> {
  const out: Array<ExistingObject & { bytes: number }> = [];
  for (const o of await store.list(prefixFor(cls, env))) {
    const createdAt = o.key.endsWith(".tar.age") ? timestampFromKey(o.key) : undefined;
    if (createdAt) out.push({ key: o.key, createdAt, bytes: o.bytes });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
const prefixFor = (cls: RetentionClass, env: string): string => `${cls}/${env}/`;

/** What the database side hands to the pipeline: a dump file and the facts read at the SAME exported snapshot. */
export interface DumpResult {
  dumpPath: string;
  facts: SnapshotFacts;
}

export interface BackupDeps {
  store: ObjectStore;
  environment: string;
  /** age recipient (public). */
  recipient: string;
  spoolDir: string;
  statusDir: string;
  manifestLog: string;
  retention: RetentionPolicy;
  /** Non-secret fingerprint of THIS host (see hostFingerprint in the CLI). */
  hostFingerprint: string;
  log: BackupLogger;
  now: () => Date;
  dump: (workDir: string) => Promise<DumpResult>;
  anchorPath?: string | undefined;
  configFiles: string[];
  acceptContent?: BundleInput["acceptContent"];
  /** Optional append-only audit hook (e.g. an audit_events row). A failure here is logged and flagged but does not fail the backup. */
  recordAudit?: (m: BackupManifest) => Promise<void>;
  /** Number of verified artifacts kept in spool/done (local convenience copies). */
  localKeep?: number;
}

interface PendingRecord {
  manifest: BackupManifest;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Uploads `artifact` to every key and PROVES each upload by downloading it back and comparing SHA-256. An existing key is accepted only if it already holds the same bytes. */
async function uploadAndVerify(deps: BackupDeps, artifactPath: string, m: BackupManifest, workDir: string): Promise<void> {
  for (const key of m.keys) {
    try {
      await deps.store.putFile(key, artifactPath, { sha256: m.sha256 });
    } catch (error) {
      if (!(error instanceof StoreError && error.code === "exists")) throw new StepError("upload", "upload_failed");
      deps.log("backup.upload.key_exists", { key });
    }
    const probe = join(workDir, `verify-${m.sha256.slice(0, 8)}.bin`);
    try {
      await deps.store.getFile(key, probe);
    } catch {
      throw new StepError("verify_upload", "download_failed");
    }
    const got = await sha256File(probe);
    await wipeFile(probe);
    if (got !== m.sha256) throw new StepError("verify_upload", "checksum_mismatch");
    deps.log("backup.upload.verified", { key, bytes: m.bytes, sha256: m.sha256 });
  }
  m.uploadVerifiedAt = deps.now().toISOString();
  for (const key of m.keys) {
    try {
      await deps.store.putText(`${key}.manifest.json`, `${JSON.stringify(m)}\n`);
    } catch (error) {
      if (!(error instanceof StoreError && error.code === "exists")) throw new StepError("upload_manifest", "upload_failed");
    }
  }
}

async function finish(deps: BackupDeps, m: BackupManifest, artifactPath: string): Promise<{ audit: boolean }> {
  await appendManifestLog(deps.manifestLog, m);
  let audit = true;
  if (deps.recordAudit) {
    try {
      await deps.recordAudit(m);
    } catch {
      audit = false;
      deps.log("backup.audit.record_failed", { name: m.name });
    }
  }
  const done = join(deps.spoolDir, "done");
  await mkdir(done, { recursive: true, mode: 0o700 });
  await rename(artifactPath, join(done, m.name));
  const keep = deps.localKeep ?? 2;
  const files = (await readdir(done)).filter((f) => f.endsWith(".tar.age")).sort().reverse();
  for (const f of files.slice(keep)) await rm(join(done, f), { force: true });
  return { audit };
}

/** Retries artifacts a previous run could not upload (kept encrypted in spool/pending). */
export async function flushPending(deps: BackupDeps): Promise<number> {
  const dir = join(deps.spoolDir, "pending");
  if (!(await exists(dir))) return 0;
  let flushed = 0;
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".pending.json")).sort()) {
    const rec = JSON.parse(await readFile(join(dir, f), "utf8")) as PendingRecord;
    const m = parseManifest(JSON.stringify(rec.manifest));
    const artifact = join(dir, m.name);
    if (!(await exists(artifact))) continue;
    if ((await sha256File(artifact)) !== m.sha256) throw new StepError("flush_pending", "pending_artifact_corrupt");
    const work = join(deps.spoolDir, "work");
    await mkdir(work, { recursive: true, mode: 0o700 });
    await uploadAndVerify(deps, artifact, m, work);
    await finish(deps, m, artifact);
    await rm(join(dir, f), { force: true });
    deps.log("backup.pending.flushed", { name: m.name });
    flushed += 1;
  }
  return flushed;
}

export interface BackupResult {
  name: string;
  keys: string[];
  bytes: number;
  sha256: string;
  createdAt: string;
  retentionClasses: RetentionClass[];
  auditRecorded: boolean;
  provider: string;
}

/**
 * One backup: snapshot+dump -> bundle -> encrypt (client-side, public recipient) -> checksum -> upload to every due retention class ->
 * download and re-checksum each object -> manifests (object sidecar, local append-only log, optional audit event) -> status.
 * If the upload fails the encrypted artifact is kept in spool/pending and retried by the next run; the failure is recorded in the status file.
 */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const started = deps.now();
  let step = "start";
  const work = join(deps.spoolDir, `work-${started.getTime()}`);
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    step = "flush_pending";
    await flushPending(deps);

    step = "dump";
    const dump = await deps.dump(work);
    const dumpSha = await sha256File(dump.dumpPath);
    const dumpBytes = (await stat(dump.dumpPath)).size;
    if (dumpBytes === 0) throw new StepError("dump", "empty_dump");

    step = "bundle";
    const stage = join(work, "stage");
    const layout = await stageBundle({
      stageDir: stage, dumpPath: dump.dumpPath, anchorPath: deps.anchorPath, configFiles: deps.configFiles,
      ...(deps.acceptContent ? { acceptContent: deps.acceptContent } : {}),
      info: { bundleVersion: 1, createdAt: started.toISOString(), environment: deps.environment, dumpSha256: dumpSha, dumpBytes, snapshot: dump.facts },
    });
    const tar = join(work, "bundle.tar");
    await createTar(stage, tar);
    const plainSha = await sha256File(tar);
    await wipeDir(stage);
    await wipeFile(dump.dumpPath);

    step = "encrypt";
    const name = artifactName(deps.environment, started);
    const pending = join(deps.spoolDir, "pending");
    await mkdir(pending, { recursive: true, mode: 0o700 });
    const artifact = join(pending, name);
    await encryptFile(tar, artifact, deps.recipient);
    await wipeFile(tar);
    const head = (await readFile(artifact)).subarray(0, AGE_HEADER.length).toString("latin1");
    if (head !== AGE_HEADER) throw new StepError("encrypt", "not_an_age_file");
    const sha256 = await sha256File(artifact);
    const bytes = (await stat(artifact)).size;

    step = "plan_classes";
    const listClass = (cls: RetentionClass): Promise<ExistingObject[]> => listArtifacts(deps.store, cls, deps.environment);
    let classes: RetentionClass[];
    try {
      classes = classesForNewBackup(started, { weekly: await listClass("weekly"), monthly: await listClass("monthly") });
    } catch {
      throw new StepError("plan_classes", "list_failed");
    }
    const manifest: BackupManifest = {
      manifestVersion: MANIFEST_VERSION, name, keys: classes.map((c) => objectKey(c, deps.environment, name)), retentionClasses: classes,
      environment: deps.environment, createdAt: started.toISOString(), bytes, sha256, plainSha256: plainSha,
      encryption: ENCRYPTION_METHOD, recipientFingerprint: await recipientFingerprint(deps.recipient),
      bundle: { dumpSha256: dumpSha, dumpBytes, files: [layout.dump, ...(layout.anchor ? [layout.anchor] : []), ...layout.config, layout.info], anchorIncluded: layout.anchor !== undefined },
      snapshot: dump.facts, sourceHost: deps.hostFingerprint, tool: { name: "twins-offhost-backup", version: 1 },
    };
    await writeFile(join(pending, `${name}.pending.json`), `${JSON.stringify({ manifest } satisfies PendingRecord)}\n`, { mode: 0o600 });
    deps.log("backup.artifact.created", { name, bytes, sha256, classes });

    step = "upload";
    await uploadAndVerify(deps, artifact, manifest, work);
    step = "finish";
    const { audit } = await finish(deps, manifest, artifact);
    await rm(join(pending, `${name}.pending.json`), { force: true });
    await rm(work, { recursive: true, force: true });
    const result: BackupResult = { name, keys: manifest.keys, bytes, sha256, createdAt: manifest.createdAt, retentionClasses: classes, auditRecorded: audit, provider: deps.store.label };
    await writeStatus(deps.statusDir, "backup", true, "done", deps.now(), { name, bytes, sha256, classes, provider: deps.store.kind, auditRecorded: audit });
    deps.log("backup.completed", { name, bytes, sha256, classes, provider: deps.store.label });
    return result;
  } catch (error) {
    const failure = error instanceof StepError ? error.failure : error instanceof BackupCryptoError ? error.code : "unexpected_error";
    const failedStep = error instanceof StepError ? error.step : step;
    await writeStatus(deps.statusDir, "backup", false, failedStep, deps.now(), { failure, pendingKept: await exists(join(deps.spoolDir, "pending")) }).catch(() => undefined);
    deps.log("backup.failed", { step: failedStep, failure });
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw new StepError(failedStep, failure);
  }
}

// ───────────────────────────── weekly integrity verification ─────────────────────────────

export interface VerifyDeps {
  store: ObjectStore;
  environment: string;
  statusDir: string;
  workDir: string;
  log: BackupLogger;
  now: () => Date;
  /** Newest objects verified per class (default 10). */
  perClass?: number;
  /** The newest daily backup must be younger than this (default 30 h). */
  maxAgeHours?: number;
}

export interface VerifyResult {
  checked: number;
  problems: string[];
}

/** Needs NO decryption key: downloads each recent encrypted object, recomputes SHA-256 and compares with its manifest (and size). */
export async function verifyRemote(deps: VerifyDeps): Promise<VerifyResult> {
  const problems: string[] = [];
  let checked = 0;
  try {
    await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
    for (const cls of RETENTION_CLASSES) {
      const objs = await listArtifacts(deps.store, cls, deps.environment);
      if (cls === "daily") {
        const newest = objs[0];
        const maxAge = (deps.maxAgeHours ?? 30) * 3_600_000;
        if (!newest) problems.push("daily: no backups exist");
        else if (deps.now().getTime() - newest.createdAt.getTime() > maxAge) problems.push("daily: newest backup is too old");
      }
      for (const o of objs.slice(0, deps.perClass ?? 10)) {
        let manifest: BackupManifest;
        try {
          manifest = parseManifest(await deps.store.getText(`${o.key}.manifest.json`));
        } catch {
          problems.push(`${o.key}: manifest missing or invalid`);
          continue;
        }
        const tmp = join(deps.workDir, "verify.bin");
        try {
          await deps.store.getFile(o.key, tmp);
        } catch {
          problems.push(`${o.key}: download failed`);
          continue;
        }
        const sha = await sha256File(tmp);
        const size = (await stat(tmp)).size;
        await wipeFile(tmp);
        checked += 1;
        if (sha !== manifest.sha256) problems.push(`${o.key}: checksum mismatch`);
        else if (size !== manifest.bytes || o.bytes !== manifest.bytes) problems.push(`${o.key}: size differs from manifest`);
        else deps.log("verify.object.ok", { key: o.key, sha256: sha });
      }
    }
  } catch {
    problems.push("verification could not run");
  }
  const ok = problems.length === 0;
  await writeStatus(deps.statusDir, "verify", ok, ok ? "done" : "problems", deps.now(), { checked, problems: problems.slice(0, 20), problemCount: problems.length }).catch(() => undefined);
  deps.log(ok ? "verify.completed" : "verify.failed", { checked, problemCount: problems.length });
  return { checked, problems };
}

// ───────────────────────────── prune ─────────────────────────────

export interface PruneDeps {
  store: ObjectStore;
  environment: string;
  retention: RetentionPolicy;
  statusDir: string;
  log: BackupLogger;
  now: () => Date;
  apply: boolean;
}

/** Applies the retention policy per class. Dry-run by default. Needs a credential that can delete (NOT the one on the backup host). */
export async function pruneBackups(deps: PruneDeps): Promise<{ deleted: string[]; kept: number }> {
  const deleted: string[] = [];
  let kept = 0;
  for (const cls of RETENTION_CLASSES) {
    const objs = await listArtifacts(deps.store, cls, deps.environment);
    const plan = planPrune(cls, objs, deps.now(), deps.retention);
    kept += plan.keep.length;
    for (const key of plan.delete) {
      deps.log(deps.apply ? "prune.delete" : "prune.would_delete", { key, reason: plan.reasons[key] });
      if (deps.apply) {
        await deps.store.delete(key);
        await deps.store.delete(`${key}.manifest.json`);
      }
      deleted.push(key);
    }
  }
  await writeStatus(deps.statusDir, "prune", true, deps.apply ? "applied" : "dry_run", deps.now(), { deleted: deleted.length, kept }).catch(() => undefined);
  return { deleted, kept };
}

// ───────────────────────────── restore drill ─────────────────────────────

export interface ScratchDatabase {
  /** A label that is safe to log (never the password). */
  label: string;
  /** Restores the custom-format dump into the scratch database. */
  restore(dumpPath: string): Promise<void>;
  /** Reads facts in the restored database. */
  facts(): Promise<SnapshotFacts>;
  /** Runs the audit-chain verifier against the restored database (anchor copy may be undefined). */
  verifyAudit(anchorCopy: string | undefined): Promise<{ ok: boolean; detail: string }>;
  /** Runs the structural migration verification. */
  verifyMigrations(): Promise<{ ok: boolean; detail: string }>;
  destroy(): Promise<void>;
}

export interface DrillDeps {
  store: ObjectStore;
  environment: string;
  /** File holding the age identity (private key). Never read into a log. */
  identityFile: string;
  statusDir: string;
  workDir: string;
  log: BackupLogger;
  now: () => Date;
  createScratch: () => Promise<ScratchDatabase>;
  /** Object key to restore; default = the newest object under daily/. */
  key?: string;
  /** Label for the evidence record (e.g. "recovery-laptop"). Not secret. */
  runnerLabel?: string;
  /** Fingerprint of THIS host; compared with the backup's sourceHost to decide whether the restore is cross-host. */
  hostFingerprint: string;
}

export interface DrillResult {
  key: string;
  name: string;
  sha256: string;
  checks: Record<string, string>;
  runner: string;
  crossHost: boolean;
}

/**
 * Restore drill: download -> verify SHA-256 against the manifest -> decrypt -> verify the plaintext digest -> unpack (path-checked) -> verify the dump digest ->
 * restore into an isolated scratch database -> compare migrations, exact row counts and audit-chain heads with the snapshot facts in the manifest ->
 * run the audit-chain verifier and the migration verification on the restored copy -> remove every temporary resource (plaintext wiped, scratch destroyed).
 */
export async function runDrill(deps: DrillDeps): Promise<DrillResult> {
  const checks: Record<string, string> = {};
  let step = "select";
  let scratch: ScratchDatabase | undefined;
  const work = join(deps.workDir, `drill-${deps.now().getTime()}`);
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    let key = deps.key;
    if (!key) {
      key = (await listArtifacts(deps.store, "daily", deps.environment))[0]?.key;
      if (!key) throw new StepError("select", "no_backup_found");
    }
    step = "download";
    const manifest = parseManifest(await deps.store.getText(`${key}.manifest.json`).catch(() => { throw new StepError("download", "manifest_missing"); }));
    const enc = join(work, "artifact.age");
    await deps.store.getFile(key, enc).catch(() => { throw new StepError("download", "download_failed"); });
    step = "checksum";
    const sha = await sha256File(enc);
    if (sha !== manifest.sha256) throw new StepError("checksum", "checksum_mismatch");
    checks["encrypted_sha256"] = "match";
    step = "decrypt";
    const tar = join(work, "bundle.tar");
    await decryptFile(enc, tar, deps.identityFile);
    if ((await sha256File(tar)) !== manifest.plainSha256) throw new StepError("decrypt", "plaintext_digest_mismatch");
    checks["decrypt"] = "ok";
    step = "unpack";
    const out = join(work, "bundle");
    await extractTar(tar, out);
    await wipeFile(tar);
    const dumpPath = join(out, "database.dump");
    if ((await sha256File(dumpPath)) !== manifest.bundle.dumpSha256) throw new StepError("unpack", "dump_digest_mismatch");
    checks["dump_sha256"] = "match";
    const info = JSON.parse(await readFile(join(out, "bundle-info.json"), "utf8")) as { snapshot: SnapshotFacts };
    if (JSON.stringify(info.snapshot) !== JSON.stringify(manifest.snapshot)) throw new StepError("unpack", "bundle_info_mismatch");

    step = "restore";
    scratch = await deps.createScratch();
    checks["scratch"] = scratch.label;
    await scratch.restore(dumpPath).catch(() => { throw new StepError("restore", "pg_restore_failed"); });
    checks["restore"] = "ok";

    step = "compare";
    const restored = await scratch.facts();
    if (restored.migrations !== manifest.snapshot.migrations) throw new StepError("compare", "migration_count_differs");
    for (const [table, count] of Object.entries(manifest.snapshot.tableCounts)) {
      if (restored.tableCounts[table] !== count) throw new StepError("compare", `row_count_differs:${table}`);
    }
    for (const [chain, head] of Object.entries(manifest.snapshot.chainHeads)) {
      const r = restored.chainHeads[chain];
      if (!r || r.lastIndex !== head.lastIndex || r.lastHash !== head.lastHash) throw new StepError("compare", `chain_head_differs:${chain}`);
    }
    checks["migrations"] = String(restored.migrations);
    checks["row_counts"] = `${Object.keys(manifest.snapshot.tableCounts).length} tables match`;
    checks["chain_heads"] = `${Object.keys(manifest.snapshot.chainHeads).length} chains match`;

    step = "verify_migrations";
    const mig = await scratch.verifyMigrations();
    if (!mig.ok) throw new StepError("verify_migrations", "migration_verification_failed");
    checks["verify_migrations"] = mig.detail;

    step = "verify_audit";
    const anchor = manifest.bundle.anchorIncluded ? join(out, "audit-anchor.json") : undefined;
    const anchorCopy = anchor ? join(work, "anchor-copy.json") : undefined;
    if (anchor && anchorCopy) await writeFile(anchorCopy, await readFile(anchor));
    const audit = await scratch.verifyAudit(anchorCopy);
    if (!audit.ok) throw new StepError("verify_audit", "audit_chain_verification_failed");
    checks["audit_chain"] = audit.detail;

    const crossHost = manifest.sourceHost !== deps.hostFingerprint;
    const runnerLabel = deps.runnerLabel ?? "unlabelled";
    const result: DrillResult = { key, name: manifest.name, sha256: sha, checks, runner: runnerLabel, crossHost };
    await writeStatus(deps.statusDir, "drill", true, "done", deps.now(), { name: manifest.name, sha256: sha, runner: runnerLabel, crossHost, provider: deps.store.kind, storeKind: deps.store.kind, checks });
    deps.log("drill.completed", { name: manifest.name, runner: runnerLabel, crossHost, provider: deps.store.label, checks });
    return result;
  } catch (error) {
    const failure = error instanceof StepError ? error.failure : error instanceof BackupCryptoError ? error.code : "unexpected_error";
    const failedStep = error instanceof StepError ? error.step : step;
    await writeStatus(deps.statusDir, "drill", false, failedStep, deps.now(), { failure, checks }).catch(() => undefined);
    deps.log("drill.failed", { step: failedStep, failure });
    throw new StepError(failedStep, failure);
  } finally {
    // cleanup is unconditional: scratch destroyed, every plaintext artifact wiped
    if (scratch) await scratch.destroy().catch(() => deps.log("drill.cleanup_failed", { what: "scratch" }));
    await wipeDir(work);
  }
}
