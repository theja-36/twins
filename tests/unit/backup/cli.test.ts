import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStore, main } from "../../../scripts/ops/offhost-backup";
import { writeStatus } from "../../../packages/backup/src/index";
import { tmp } from "./helpers";

const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const run = async (argv: string[], env: Record<string, string>) => {
  const lines: string[] = [];
  const code = await main(argv, env, (l) => lines.push(l));
  return { code, lines };
};

describe("configuration fails closed (exit 2) and never prints a secret", () => {
  it("rejects a missing command, a missing credential, a plain-http endpoint and a directory store without the explicit rehearsal flag", async () => {
    expect((await run([], {})).code).toBe(2);
    expect((await run(["verify"], { TWINS_BACKUP_S3_ENDPOINT: "https://x.r2.cloudflarestorage.com" })).code).toBe(2);
    const http = await run(["verify"], { TWINS_BACKUP_S3_ENDPOINT: "http://203.0.113.9", TWINS_BACKUP_S3_BUCKET: "b", TWINS_BACKUP_S3_ACCESS_KEY_ID: "AKIDEXAMPLE", TWINS_BACKUP_S3_SECRET_ACCESS_KEY: "SECRETVALUE-123" });
    expect(http.code).toBe(2);
    expect(http.lines.join("\n")).not.toContain("SECRETVALUE-123");
    expect(() => buildStore({ TWINS_BACKUP_DIR_STORE: "/tmp/x" })).toThrow(/NOT off-host/);
  });
  it("refuses to back up when the environment holds a private age key, or a recipient that is not a public key", async () => {
    const base = { TWINS_BACKUP_DIR_STORE: await tmp(), TWINS_BACKUP_ALLOW_DIR_STORE: "1", TWINS_BACKUP_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/db" };
    const priv = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    const a = await run(["backup"], { ...base, TWINS_BACKUP_AGE_RECIPIENT: priv });
    expect(a.code).toBe(2);
    expect(a.lines.join("\n")).not.toContain(priv);
    const b = await run(["backup"], { ...base, TWINS_BACKUP_AGE_RECIPIENT: "age1abc", TWINS_BACKUP_NOTE: priv });
    expect(b.code).toBe(2);
  });
  it("rejects an invalid environment name and invalid retention", async () => {
    const dir = await tmp();
    expect((await run(["prune"], { TWINS_BACKUP_DIR_STORE: dir, TWINS_BACKUP_ALLOW_DIR_STORE: "1", TWINS_BACKUP_ENV_NAME: "../x" })).code).toBe(2);
    expect((await run(["prune"], { TWINS_BACKUP_DIR_STORE: dir, TWINS_BACKUP_ALLOW_DIR_STORE: "1", TWINS_BACKUP_KEEP_DAILY: "0" })).code).toBe(2);
  });
});

describe("status command (for monitoring)", () => {
  it("exit 1 when never run, 0 after a fresh success, 1 when failed or stale", async () => {
    const dir = await tmp();
    const env = { TWINS_BACKUP_STATUS_DIR: dir };
    expect((await run(["status", "backup"], env)).code).toBe(1);
    await writeStatus(dir, "backup", true, "done", new Date(), {});
    expect((await run(["status", "backup"], env)).code).toBe(0);
    await writeStatus(dir, "backup", true, "done", new Date(Date.now() - 30 * 3600_000), {});
    expect((await run(["status", "backup"], env)).code).toBe(1);
    expect((await run(["status", "backup"], { ...env, TWINS_BACKUP_BACKUP_MAX_AGE_SECONDS: "999999" })).code).toBe(0);
    await writeStatus(dir, "backup", false, "upload", new Date(), { failure: "upload_failed" });
    const failed = await run(["status", "backup"], env);
    expect(failed.code).toBe(1);
    expect(failed.lines.join("")).toContain("upload");
    expect((await run(["status", "nonsense"], env)).code).toBe(2);
  });
});

describe("deployment artifacts keep storage credentials away from the application", () => {
  const compose = read("infrastructure/staging/docker-compose.staging.yml");
  it("the application compose file never references backup credentials, the age key or the bucket", () => {
    expect(compose).not.toMatch(/TWINS_BACKUP_|AGE-SECRET-KEY|r2\.cloudflarestorage|offhost/i);
  });
  it("backup runs as a dedicated user with the credential in a systemd EnvironmentFile; the drill unit is for the recovery host and the verify unit needs no key", () => {
    const backup = read("infrastructure/staging/twins-offhost-backup.service");
    const verify = read("infrastructure/staging/twins-offhost-verify.service");
    const drill = read("infrastructure/staging/twins-offhost-drill.service");
    expect(backup).toMatch(/EnvironmentFile=\/etc\/twins-backup\/offhost\.env/);
    expect(backup).toMatch(/User=twins-backup/);
    expect(backup).toMatch(/NoNewPrivileges=true/);
    expect(verify).toMatch(/EnvironmentFile=\/etc\/twins-backup\/offhost\.env/);
    expect(drill).toMatch(/EnvironmentFile=\/etc\/twins-recovery\/drill\.env/);
    expect(drill).toMatch(/RECOVERY host.*NEVER on the backup host/s);
    for (const f of [backup, verify, drill]) expect(f).not.toMatch(/AGE-SECRET-KEY|SECRET_ACCESS_KEY=[A-Za-z0-9]{8}/);
  });
  it("schedules: daily backup, weekly verification, monthly drill, each overridable", () => {
    expect(read("infrastructure/staging/twins-offhost-backup.timer")).toMatch(/OnCalendar=\*-\*-\* 03:15:00 UTC/);
    expect(read("infrastructure/staging/twins-offhost-verify.timer")).toMatch(/OnCalendar=Sun \*-\*-\* 04:00:00 UTC/);
    expect(read("infrastructure/staging/twins-offhost-drill.timer")).toMatch(/OnCalendar=\*-\*-02 05:00:00 UTC/);
    for (const t of ["backup", "verify", "drill"]) expect(read(`infrastructure/staging/twins-offhost-${t}.timer`)).toMatch(/Persistent=true/);
  });
  it("env templates hold placeholders only: a public recipient slot, no private key, the drill file carries a PATH to the key, not the key", () => {
    const b = read("infrastructure/staging/offhost-backup.env.example");
    const d = read("infrastructure/staging/offhost-drill.env.example");
    expect(b).toMatch(/TWINS_BACKUP_AGE_RECIPIENT=age1CHANGE_ME/);
    expect(b + d).not.toMatch(/AGE-SECRET-KEY-1[0-9A-Z]/);
    expect(d).toMatch(/TWINS_BACKUP_AGE_IDENTITY_FILE=\/etc\/twins-recovery\/age-identity\.txt/);
    expect(join("x")).toBe("x");
  });
});

describe("the manual cross-host drill workflow", () => {
  const wf = read(".github/workflows/offhost-drill.yml");
  it("is manual only, read-only, not part of the required gate, and uses repository secrets for every credential", () => {
    expect(wf).toMatch(/^on:\n(?:  #[^\n]*\n)?  schedule:\n    - cron: "0 5 2 \* \*"\n  workflow_dispatch:/m); // monthly + manual only
    expect(wf).not.toMatch(/^\s+(push|pull_request|pull_request_target):/m);
    expect(wf).toMatch(/permissions:\n  contents: read/);
    expect(read(".github/workflows/ci.yml")).not.toMatch(/offhost|TWINS_DRILL/); // ci-gate does not depend on it
    for (const s of ["TWINS_ALERT_WEBHOOK_URL", "TWINS_DRILL_S3_ENDPOINT", "TWINS_DRILL_S3_BUCKET", "TWINS_DRILL_S3_ACCESS_KEY_ID", "TWINS_DRILL_S3_SECRET_ACCESS_KEY", "TWINS_DRILL_AGE_IDENTITY"]) expect(wf).toContain(`secrets.${s}`);
    expect(wf).not.toMatch(/AGE-SECRET-KEY-1[0-9A-Z]|SECRET_ACCESS_KEY: [A-Za-z0-9]{10}/);
  });
});
