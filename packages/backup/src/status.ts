import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Structured, content-free log line. Keys are fixed by the callers; values are ids, counts and codes. */
export type BackupLogger = (event: string, fields?: Record<string, unknown>) => void;
export const jsonLogger = (write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), base: Record<string, unknown> = { service: "offhost-backup" }): BackupLogger =>
  (event, fields = {}) => write(JSON.stringify({ ts: new Date().toISOString(), level: event.endsWith(".failed") ? "error" : "info", event, ...base, ...fields }));

export type StatusKind = "backup" | "verify" | "drill" | "prune";
export interface StatusRecord {
  ok: boolean;
  ts: string;
  epoch: number;
  kind: StatusKind;
  /** Last step reached; on failure, the step that failed. */
  step: string;
  /** Fixed failure code (never an error message). */
  failure?: string;
  [extra: string]: unknown;
}

/** Atomically (re)writes `<dir>/offhost-<kind>.json` (0600). A failed run overwrites an earlier "ok" so staleness/failure is always visible. */
export async function writeStatus(dir: string, kind: StatusKind, ok: boolean, step: string, now: Date, extra: Record<string, unknown> = {}): Promise<StatusRecord> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record: StatusRecord = { ok, ts: now.toISOString(), epoch: Math.floor(now.getTime() / 1000), kind, step, ...extra };
  const tmp = join(dir, `.offhost-${kind}.json.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, join(dir, `offhost-${kind}.json`));
  return record;
}

/** For monitoring: exit-code semantics of `--status`: ok only if the last run succeeded AND is younger than `maxAgeSeconds`. */
export async function readStatus(dir: string, kind: StatusKind, now: Date, maxAgeSeconds: number): Promise<{ ok: boolean; reason: string; record?: StatusRecord }> {
  let record: StatusRecord;
  try {
    record = JSON.parse(await readFile(join(dir, `offhost-${kind}.json`), "utf8")) as StatusRecord;
  } catch {
    return { ok: false, reason: "no status file: this job has never run" };
  }
  if (!record.ok) return { ok: false, reason: `last run failed at step ${record.step}`, record };
  const age = Math.floor(now.getTime() / 1000) - record.epoch;
  if (age > maxAgeSeconds) return { ok: false, reason: `stale: last success ${age}s ago (limit ${maxAgeSeconds}s)`, record };
  return { ok: true, reason: "ok", record };
}

export class StepError extends Error {
  constructor(readonly step: string, readonly failure: string) {
    super(`${step}: ${failure}`);
    this.name = "StepError";
  }
}
