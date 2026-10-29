import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactName, parseManifest, pruneBackups, readStatus, runBackup, runDrill, sha256File, StepError, verifyRemote, DEFAULT_RETENTION, type BackupManifest, type ObjectStore,
} from "../../../packages/backup/src/index";
import { CANARY, FACTS, fakeScratch, files, rig } from "./helpers";

const manifestOf = async (r: Awaited<ReturnType<typeof rig>>, key: string): Promise<BackupManifest> => parseManifest(await r.store.getText(`${key}.manifest.json`));

describe("backup artifact, manifest and upload", () => {
  it("creates one encrypted artifact, stores it under each due class, verifies the upload by re-download, and writes manifests", async () => {
    const r = await rig();
    const res = await runBackup(r.backupDeps());
    expect(res.name).toBe(artifactName("staging", new Date("2031-03-12T02:30:00.000Z")));
    expect(res.name).toBe("twins-staging-20310312T023000Z.tar.age");
    expect(res.retentionClasses).toEqual(["daily", "weekly", "monthly"]);
    expect(res.keys).toEqual([`daily/staging/${res.name}`, `weekly/staging/${res.name}`, `monthly/staging/${res.name}`]);
    for (const key of res.keys) {
      expect(await r.store.head(key)).toEqual({ bytes: res.bytes });
      const m = await manifestOf(r, key);
      expect(m).toMatchObject({ name: res.name, sha256: res.sha256, bytes: res.bytes, environment: "staging", sourceHost: "hostA", retentionClasses: ["daily", "weekly", "monthly"], snapshot: FACTS });
      expect(m.encryption).toMatch(/age v1.*client-side/);
      expect(m.uploadVerifiedAt).toBeDefined();
      expect(m.bundle.anchorIncluded).toBe(true);
    }
    // checksum is of the stored encrypted bytes and is deterministic
    const stored = join(r.storeDir, res.keys[0] as string);
    expect(await sha256File(stored)).toBe(res.sha256);
    // local append-only manifest log
    const log = (await readFile(r.backupDeps().manifestLog, "utf8")).trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] as string)).toMatchObject({ name: res.name, sha256: res.sha256 });
    // status file
    const s = await readStatus(r.backupDeps().statusDir, "backup", r.clock.now, 26 * 3600);
    expect(s).toMatchObject({ ok: true, record: { name: res.name, sha256: res.sha256, provider: "dir" } });
  });

  it("nothing in the store, the manifest log, the logs or the spool contains plaintext, a private key, or an environment file", async () => {
    const r = await rig();
    await runBackup(r.backupDeps());
    const everything = [...(await files(r.storeDir)), ...(await files(join(r.root, "spool")))];
    for (const f of everything) {
      const bytes = await readFile(f);
      expect(bytes.includes(Buffer.from(CANARY)), f).toBe(false);
      expect(bytes.includes(Buffer.from("real-looking-secret-value")), f).toBe(false);
      expect(bytes.includes(Buffer.from("AGE-SECRET-KEY")), f).toBe(false);
    }
    expect(JSON.stringify(r.logs)).not.toMatch(/AGE-SECRET-KEY|real-looking-secret|PLAINTEXT-CANARY/);
    expect(await readdir(join(r.root, "spool", "pending"))).toEqual([]); // nothing left in pending after a successful run
  });

  it("the bundle carries templates and unit files but never staging.env or key files (checked by decrypting it in the drill)", async () => {
    const r = await rig();
    let seen: string[] = [];
    await runBackup(r.backupDeps());
    const res = await runDrill(r.drillDeps(fakeScratch()));
    const m = await manifestOf(r, res.key);
    seen = m.bundle.files;
    expect(seen).toEqual(expect.arrayContaining(["database.dump", "audit-anchor.json", "config/staging.env.example", "config/docker-compose.staging.yml", "bundle-info.json"]));
    expect(seen.join(" ")).not.toMatch(/staging\.env$|backup\.key/);
  });

  it("a config file with secret-shaped content is refused and the backup fails closed (nothing uploaded)", async () => {
    const r = await rig();
    await writeFile(join(r.root, "config", "leaky.example"), "token=1\n");
    const deps = r.backupDeps({ configFiles: [join(r.root, "config", "leaky.example")], acceptContent: (name) => (name === "leaky.example" ? "secret-shaped content" : undefined) });
    await expect(runBackup(deps)).rejects.toBeInstanceOf(StepError);
    expect(await r.store.list("")).toEqual([]);
    expect((await readStatus(deps.statusDir, "backup", r.clock.now, 100)).ok).toBe(false);
  });

  it("only the first backup of a week/month goes to weekly/monthly; later ones in the same period are daily only", async () => {
    const r = await rig();
    await runBackup(r.backupDeps());
    r.clock.now = new Date("2031-03-13T02:30:00.000Z");
    const second = await runBackup(r.backupDeps());
    expect(second.retentionClasses).toEqual(["daily"]);
    r.clock.now = new Date("2031-03-17T02:30:00.000Z"); // next ISO week, same month
    const third = await runBackup(r.backupDeps());
    expect(third.retentionClasses).toEqual(["daily", "weekly"]);
    // fs mtime of the dir store is real time, so classes above came from the injected clock, not from object ages
  });

  it("refuses to overwrite: an object that exists with different content fails the run", async () => {
    const r = await rig();
    const first = await runBackup(r.backupDeps());
    await writeFile(join(r.storeDir, first.keys[0] as string), "corrupted by someone else");
    r.clock.now = new Date("2031-03-12T02:30:00.000Z"); // same name again
    await expect(runBackup(r.backupDeps())).rejects.toMatchObject({ failure: "checksum_mismatch" });
  });
});

describe("failure handling", () => {
  it("upload fails after the local backup succeeded: the run fails visibly, the encrypted artifact is kept, and the next run uploads it", async () => {
    const r = await rig();
    let broken = true;
    const flaky: ObjectStore = { ...r.store, putFile: async (k, p, m) => { if (broken) throw new Error("network down with secret=abc"); return r.store.putFile(k, p, m); } };
    const deps = r.backupDeps({ store: flaky });
    await expect(runBackup(deps)).rejects.toMatchObject({ step: "upload", failure: "upload_failed" });
    const status = await readStatus(deps.statusDir, "backup", r.clock.now, 100);
    expect(status.ok).toBe(false);
    expect(status.record).toMatchObject({ ok: false, step: "upload", failure: "upload_failed", pendingKept: true });
    expect(JSON.stringify(r.logs)).not.toContain("secret=abc");
    const pending = await readdir(join(r.root, "spool", "pending"));
    expect(pending.some((f) => f.endsWith(".tar.age"))).toBe(true);
    expect(await r.store.list("")).toEqual([]);

    broken = false;
    r.clock.now = new Date("2031-03-13T02:30:00.000Z");
    const ok = await runBackup(r.backupDeps({ store: flaky }));
    expect(ok.retentionClasses).toContain("daily");
    expect(r.logs.some((l) => l["event"] === "backup.pending.flushed")).toBe(true);
    const daily = (await r.store.list("daily/staging/")).filter((o) => o.key.endsWith(".tar.age"));
    expect(daily).toHaveLength(2); // the one that failed last night AND today's
    expect(await readdir(join(r.root, "spool", "pending"))).toEqual([]);
  });

  it("checksum mismatch after upload (the store returns different bytes) fails the run", async () => {
    const r = await rig();
    const lying: ObjectStore = { ...r.store, getFile: async (k, p) => { await r.store.getFile(k, p); await writeFile(p, "different bytes"); } };
    await expect(runBackup(r.backupDeps({ store: lying }))).rejects.toMatchObject({ step: "verify_upload", failure: "checksum_mismatch" });
    expect((await readStatus(r.backupDeps().statusDir, "backup", r.clock.now, 100)).record).toMatchObject({ ok: false, failure: "checksum_mismatch" });
  });

  it("an empty dump fails before anything is encrypted or uploaded", async () => {
    const r = await rig();
    await expect(runBackup(r.backupDeps({ dump: async (w) => { const p = join(w, "d"); await writeFile(p, ""); return { dumpPath: p, facts: FACTS }; } }))).rejects.toMatchObject({ failure: "empty_dump" });
    expect(await r.store.list("")).toEqual([]);
  });

  it("a failure of the audit hook is flagged but does not fail the backup", async () => {
    const r = await rig();
    const res = await runBackup(r.backupDeps({ recordAudit: async () => { throw new Error("db down"); } }));
    expect(res.auditRecorded).toBe(false);
    expect(r.logs.some((l) => l["event"] === "backup.audit.record_failed")).toBe(true);
  });

  it("a bad recipient (private key pasted by mistake) fails closed", async () => {
    const r = await rig();
    await expect(runBackup(r.backupDeps({ recipient: "AGE-SECRET-KEY-1ABC" }))).rejects.toMatchObject({ failure: "bad_recipient" });
    expect(await r.store.list("")).toEqual([]);
  });
});

describe("weekly integrity verification (no key needed)", () => {
  it("passes for intact objects, and names the object when one is corrupted or its manifest is missing", async () => {
    const r = await rig();
    const res = await runBackup(r.backupDeps());
    const base = { store: r.store, environment: "staging", statusDir: join(r.root, "status"), workDir: join(r.root, "vw"), log: (e: string, f?: Record<string, unknown>) => { r.logs.push({ event: e, ...f }); }, now: () => new Date(r.clock.now.getTime() + 3600_000) };
    const good = await verifyRemote(base);
    expect(good).toEqual({ checked: 3, problems: [] });
    expect((await readStatus(base.statusDir, "verify", base.now(), 100)).ok).toBe(true);

    await writeFile(join(r.storeDir, res.keys[1] as string), "bit rot");
    const bad = await verifyRemote(base);
    expect(bad.problems).toEqual([`${res.keys[1]}: checksum mismatch`]);
    expect((await readStatus(base.statusDir, "verify", base.now(), 100)).ok).toBe(false);

    await writeFile(join(r.storeDir, res.keys[1] as string), await readFile(join(r.storeDir, res.keys[0] as string)));
    await writeFile(join(r.storeDir, `${res.keys[2]}.manifest.json`), "{}");
    expect((await verifyRemote(base)).problems).toEqual([`${res.keys[2]}: manifest missing or invalid`]);
  });
  it("reports a missing or stale newest daily backup", async () => {
    const r = await rig();
    const base = { store: r.store, environment: "staging", statusDir: join(r.root, "status"), workDir: join(r.root, "vw"), log: () => undefined, now: () => r.clock.now };
    expect((await verifyRemote(base)).problems).toEqual(["daily: no backups exist"]);
    await runBackup(r.backupDeps());
    const stale = await verifyRemote({ ...base, now: () => new Date(r.clock.now.getTime() + 5 * 86_400_000) });
    expect(stale.problems).toEqual(["daily: newest backup is too old"]);
  });
});

describe("restore drill", () => {
  it("downloads the latest backup, verifies, decrypts, restores into the scratch database, compares and cleans up; reports cross-host when the host differs", async () => {
    const r = await rig();
    await runBackup(r.backupDeps());
    const scratch = fakeScratch();
    const res = await runDrill(r.drillDeps(scratch));
    expect(res.checks).toMatchObject({ encrypted_sha256: "match", decrypt: "ok", dump_sha256: "match", restore: "ok", migrations: "13", row_counts: "2 tables match", chain_heads: "2 chains match", audit_chain: "PASS" });
    expect(res.crossHost).toBe(true); // backup host "hostA", drill host "hostB"
    expect(scratch.restored).toHaveLength(1);
    expect(scratch.destroyed).toBe(1);
    expect(await readdir(join(r.root, "drill"))).toEqual([]); // no plaintext left behind
    expect((await readStatus(join(r.root, "status"), "drill", r.clock.now, 100)).record).toMatchObject({ ok: true, crossHost: true, runner: "test-recovery-host" });
    const same = await runDrill(r.drillDeps(fakeScratch(), { hostFingerprint: "hostA" }));
    expect(same.crossHost).toBe(false); // same-host evidence is labelled as such
  });

  it("checksum mismatch: stops before decrypting or restoring, records the failure, still cleans up", async () => {
    const r = await rig();
    const res = await runBackup(r.backupDeps());
    await writeFile(join(r.storeDir, res.keys[0] as string), "tampered");
    const scratch = fakeScratch();
    await expect(runDrill(r.drillDeps(scratch))).rejects.toMatchObject({ step: "checksum", failure: "checksum_mismatch" });
    expect(scratch.restored).toEqual([]);
    expect((await readStatus(join(r.root, "status"), "drill", r.clock.now, 100)).record).toMatchObject({ ok: false, step: "checksum", failure: "checksum_mismatch" });
    expect(await readdir(join(r.root, "drill"))).toEqual([]);
  });

  it("decryption failure (wrong recovery key): no restore, fixed failure code, nothing leaked, plaintext absent", async () => {
    const r = await rig();
    await runBackup(r.backupDeps());
    const { keypair } = await import("./helpers");
    const wrong = await keypair(join(r.root));
    const wrongFile = join(r.root, "wrong-identity.txt");
    await writeFile(wrongFile, await readFile(wrong.identityFile));
    const scratch = fakeScratch();
    await expect(runDrill(r.drillDeps(scratch, { identityFile: wrongFile }))).rejects.toMatchObject({ step: "decrypt", failure: "decrypt_failed" });
    expect(scratch.restored).toEqual([]);
    expect(JSON.stringify(r.logs)).not.toMatch(/AGE-SECRET-KEY/);
    expect(await readdir(join(r.root, "drill"))).toEqual([]);
  });

  it("a restored copy whose row counts or chain heads differ from the snapshot fails the drill and still destroys the scratch database", async () => {
    const r = await rig();
    await runBackup(r.backupDeps());
    const fewer = fakeScratch({ facts: async () => ({ ...FACTS, tableCounts: { ...FACTS.tableCounts, telegram_messages: 4 } }) });
    await expect(runDrill(r.drillDeps(fewer))).rejects.toMatchObject({ failure: "row_count_differs:telegram_messages" });
    expect(fewer.destroyed).toBe(1);
    const fork = fakeScratch({ facts: async () => ({ ...FACTS, chainHeads: { ...FACTS.chainHeads, audit_events: { lastIndex: 3, lastHash: "c".repeat(64) } } }) });
    await expect(runDrill(r.drillDeps(fork))).rejects.toMatchObject({ failure: "chain_head_differs:audit_events" });
    const badAudit = fakeScratch({ verifyAudit: async () => ({ ok: false, detail: "FAIL" }) });
    await expect(runDrill(r.drillDeps(badAudit))).rejects.toMatchObject({ step: "verify_audit" });
    const badRestore = fakeScratch({ restore: async () => { throw new Error("pg_restore: boom"); } });
    await expect(runDrill(r.drillDeps(badRestore))).rejects.toMatchObject({ step: "restore", failure: "pg_restore_failed" });
    expect(badRestore.destroyed).toBe(1);
  });

  it("restores a specific object by key; reports when none exists", async () => {
    const r = await rig();
    await expect(runDrill(r.drillDeps(fakeScratch()))).rejects.toMatchObject({ failure: "no_backup_found" });
    const res = await runBackup(r.backupDeps());
    const out = await runDrill(r.drillDeps(fakeScratch(), { key: res.keys[2] as string }));
    expect(out.key).toBe(res.keys[2]);
  });
});

describe("prune", () => {
  it("is a dry run unless --apply, and applies the per-class policy (by the time in the object name)", async () => {
    const r = await rig();
    for (let i = 0; i < 10; i++) {
      const key = `daily/staging/twins-staging-203101${String(i + 1).padStart(2, "0")}T023000Z.tar.age`;
      await writeFile(join(r.storeDir, "tmp"), "x");
      await r.store.putFile(key, join(r.storeDir, "tmp"), { sha256: "x" });
      await r.store.putText(`${key}.manifest.json`, "{}");
    }
    const deps = { store: r.store, environment: "staging", retention: DEFAULT_RETENTION, statusDir: join(r.root, "status"), log: () => undefined, now: () => new Date("2031-02-15T00:00:00Z"), apply: false };
    const dry = await pruneBackups(deps);
    expect(dry.deleted).toEqual(["daily/staging/twins-staging-20310103T023000Z.tar.age", "daily/staging/twins-staging-20310102T023000Z.tar.age", "daily/staging/twins-staging-20310101T023000Z.tar.age"]);
    expect((await r.store.list("daily/")).filter((o) => o.key.endsWith(".tar.age"))).toHaveLength(10);
    const applied = await pruneBackups({ ...deps, apply: true });
    expect(applied.deleted).toEqual(dry.deleted);
    expect((await r.store.list("daily/")).filter((o) => o.key.endsWith(".tar.age"))).toHaveLength(7);
    expect(await r.store.head(`${dry.deleted[0]}.manifest.json`)).toBeUndefined();
    expect(await r.store.head(`${dry.deleted[0]}`)).toBeUndefined();
  });
});
