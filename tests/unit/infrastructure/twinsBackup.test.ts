import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "infrastructure/staging/twins-backup.sh";
const script = readFileSync(SCRIPT, "utf8");
const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/** A sandbox with stub `docker`, `flock`, `sha256sum` and an encryption tool, so the real script logic runs without Docker, root or the real key. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "twins-backup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const backups = join(dir, "backups");
  const status = join(dir, "status");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("docker", `case "$*" in
  *pg_dump*) [ "\${STUB_DUMP_FAIL:-0}" = 1 ] && exit 1; [ "\${STUB_DUMP_EMPTY:-0}" = 1 ] && exit 0; printf 'PGDMP-fake-dump-bytes'; ;;
  *pg_restore*--list*) cat >/dev/null; case "\${STUB_TOC:-ok}" in ok) printf '; header\\n1; 1 2 TABLE DATA public telegram_messages x\\n2; 1 2 TABLE DATA drizzle __drizzle_migrations x\\n';; missing) printf '1; 1 2 TABLE DATA public other x\\n';; esac;;
esac`);
  stub("flock", `[ "\${STUB_LOCKED:-0}" = 1 ] && exit 1; exit 0`);
  stub("sha256sum", `shasum -a 256 "$@"`);
  writeFileSync(join(dir, "twinsenc.py"), `import base64, os, sys
mode, key, src, dst = sys.argv[1:5]
if os.path.exists(dst): sys.exit("refusing to overwrite")
data = open(src, "rb").read()
out = base64.b64encode(data) if mode == "encrypt" else base64.b64decode(data)
if mode == "decrypt" and os.environ.get("STUB_CORRUPT") == "1": out = out + b"x"
open(dst, "wb").write(out)
`);
  writeFileSync(join(dir, "key"), "00".repeat(32), { mode: 0o600 });
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    BACKUP_DIR: backups, STATUS_DIR: status, LOCK_FILE: join(dir, "lock"), KEY_FILE: join(dir, "key"), ENC_TOOL: join(dir, "twinsenc.py"),
    MIN_FREE_KB: "1", ...extra,
  });
  const run = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync("bash", [SCRIPT, ...args], { env: env(extra), encoding: "utf8" });
  const files = () => (existsSync(backups) ? readdirSync(backups).sort() : []);
  const readStatus = () => JSON.parse(readFileSync(join(status, "backup.json"), "utf8")) as Record<string, unknown>;
  return { dir, backups, status, run, files, readStatus };
}

describe("twins-backup.sh (stubbed docker/encryption)", () => {
  it("a successful run leaves exactly one encrypted file + its checksum, no plaintext, and a private status file", () => {
    const sb = sandbox();
    const r = sb.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^BACKUP OK twins-staging-daily-[0-9]{8}T[0-9]{6}Z\.dump\.enc /);
    const files = sb.files();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^twins-staging-daily-[0-9]{8}T[0-9]{6}Z\.dump\.enc$/);
    expect(files[1]).toBe(`${files[0]}.sha256`);
    for (const f of files) expect(f).not.toMatch(/\.dump$|\.partial$|\.tmp$/); // no plaintext, partial or verify leftovers
    const st = sb.readStatus();
    expect(st).toMatchObject({ ok: true, toc_entries: 2, pruned: 0, offhost: "not configured (local only)" });
    expect(String(st["plain_sha256"])).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(sb.status, "backup.json")).mode & 0o777).toBe(0o600);
    expect(statSync(sb.backups).mode & 0o777).toBe(0o700);
  });

  const failures: Array<[string, Record<string, string>, string]> = [
    ["a failing pg_dump", { STUB_DUMP_FAIL: "1" }, "pg_dump"],
    ["an empty dump", { STUB_DUMP_EMPTY: "1" }, "pg_dump"],
    ["decrypted content that differs from the original", { STUB_CORRUPT: "1" }, "verify: decrypted == original"],
    ["a restore list without the expected tables", { STUB_TOC: "missing" }, "verify: pg_restore --list"],
    ["too little free disk space", { MIN_FREE_KB: "999999999999" }, "disk space"],
    ["a missing key file", { KEY_FILE: "/nonexistent/key" }, "key/tool present"],
  ];
  for (const [name, extra, step] of failures) {
    it(`fails closed on ${name}: non-zero exit, nothing left behind, status says which step`, () => {
      const sb = sandbox();
      const r = sb.run(extra);
      expect(r.status).not.toBe(0);
      expect(sb.files(), `${sb.files()}`).toEqual([]); // no encrypted file, no plaintext, no partial
      const st = sb.readStatus();
      expect(st["ok"]).toBe(false);
      expect(String(st["detail"])).toContain(step);
      expect(sb.run({}, ["--status"]).status).toBe(1);
    });
  }

  it("a second backup while one holds the lock exits 75 and writes nothing", () => {
    const sb = sandbox();
    const r = sb.run({ STUB_LOCKED: "1" });
    expect(r.status).toBe(75);
    expect(sb.files()).toEqual([]);
  });

  it("prunes only its own old encrypted dailies beyond the newest 7, never touches other files, and never goes below the floor", () => {
    const sb = sandbox();
    mkdirSync(sb.backups, { recursive: true });
    const old = Array.from({ length: 9 }, (_, i) => `twins-staging-daily-2026010${i + 1}T023000Z.dump.enc`);
    for (const f of old) { writeFileSync(join(sb.backups, f), "x"); writeFileSync(join(sb.backups, `${f}.sha256`), "x"); }
    const others = ["twins-staging-pre-0007-20261022T150405Z.dump", "twins-staging-pre-0007-20261022T150405Z.dump.sha256", "notes.txt"];
    for (const f of others) writeFileSync(join(sb.backups, f), "keep me");
    const r = sb.run();
    expect(r.status, r.stderr).toBe(0);
    const dailies = sb.files().filter((f) => /^twins-staging-daily-.*\.dump\.enc$/.test(f));
    expect(dailies).toHaveLength(7); // the new one + the 6 newest old ones
    expect(dailies).not.toContain(old[0]);
    expect(dailies).not.toContain(old[2]);
    expect(dailies).toContain(old[8]);
    for (const f of others) expect(sb.files()).toContain(f);
    expect(sb.readStatus()).toMatchObject({ ok: true, pruned: 3, kept: 7 });
    // floor: KEEP below FLOOR prunes nothing
    const sb2 = sandbox();
    mkdirSync(sb2.backups, { recursive: true });
    for (const f of old) writeFileSync(join(sb2.backups, f), "x");
    expect(sb2.run({ KEEP: "2", FLOOR: "3" }).status).toBe(0);
    expect(sb2.files().filter((f) => f.endsWith(".dump.enc"))).toHaveLength(10);
  });

  it("--status passes only for a successful run younger than 26 hours", () => {
    const sb = sandbox();
    expect(sb.run({}, ["--status"]).status).toBe(1); // nothing has run
    expect(sb.run().status).toBe(0);
    expect(sb.run({}, ["--status"]).status).toBe(0);
    const stale = readFileSync(join(sb.status, "backup.json"), "utf8").replace(/"epoch":[0-9]+/, `"epoch":${Math.floor(Date.now() / 1000) - 27 * 3600}`);
    writeFileSync(join(sb.status, "backup.json"), stale);
    expect(sb.run({}, ["--status"]).status).toBe(1);
  });
});

describe("backup schedule units and script safety", () => {
  const timer = readFileSync("infrastructure/staging/twins-backup.timer", "utf8");
  const service = readFileSync("infrastructure/staging/twins-backup.service", "utf8");
  it("the timer is daily 02:30 UTC, persistent and slightly randomised; the service runs the installed script after Docker", () => {
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 02:30:00 UTC$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=300$/m);
    expect(timer).toMatch(/^Unit=twins-backup\.service$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/local\/sbin\/twins-backup$/m);
    expect(service).toMatch(/^After=docker\.service$/m);
    expect(service).toMatch(/^Requires=docker\.service$/m);
  });
  it("the script never reads or prints the key, has no network or remote-copy command, and prunes only its own file pattern", () => {
    expect(code).not.toMatch(/cat "\$KEY_FILE"|echo "\$KEY|<\s*"\$KEY_FILE"|printf[^\n]*KEY_FILE/);
    expect(code).not.toMatch(/\b(curl|wget|rclone|scp|rsync|ssh|nc)\b/);
    expect(code.match(/rm -f "\$f" "\$f\.sha256"/g)?.length).toBe(1);
    expect(code).toContain('"$BACKUP_DIR"/twins-staging-daily-*.dump.enc');
    expect(code).toMatch(/"\$KEY_FILE" "\$PLAIN" "\$ENC"/); // the key is only ever passed as a path
    expect(code).toMatch(/verify: decrypted == original/);
    expect(code.indexOf("verify: pg_restore --list")).toBeLessThan(code.indexOf("remove plaintext")); // the plaintext is removed only after verification
    expect(code.indexOf("remove plaintext")).toBeLessThan(code.indexOf('STEP="prune"')); // pruning only after a verified success
  });
});
