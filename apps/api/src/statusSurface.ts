import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SafetySnapshot } from "@twins/runtime-state";

/**
 * Operational status for GET /health/status (authenticated; the unauthenticated /health stays minimal). Everything here is a boolean, a count, a
 * timestamp or a fixed code: no credentials, no message content, no file paths, no error text or stack.
 */
export interface StatusDeps {
  now: () => Date;
  startedAt: Date;
  pingDatabase: () => Promise<void>;
  pingRedis: (() => Promise<void>) | undefined;
  readSafety: () => Promise<SafetySnapshot>;
  outboxCounts: () => Promise<Record<string, number>>;
  /** Directory holding the monitor status files (backup.json, offhost-backup.json, audit-verify.json), or undefined when not mounted. */
  statusDir: string | undefined;
  /** Each check is bounded. */
  timeoutMs?: number;
}

type Check = { ok: true; latencyMs: number } | { ok: false; code: "timeout" | "unavailable" } | { ok: "unknown" };

async function timed(fn: (() => Promise<void>) | undefined, ms: number, now: () => Date): Promise<Check> {
  if (!fn) return { ok: "unknown" };
  const t0 = now().getTime();
  try {
    await Promise.race([fn(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
    return { ok: true, latencyMs: now().getTime() - t0 };
  } catch (error) {
    return { ok: false, code: (error as Error)?.message === "timeout" ? "timeout" : "unavailable" };
  }
}

async function lastOk(dir: string | undefined, file: string): Promise<number | null> {
  if (!dir) return null;
  try {
    const j = JSON.parse(await readFile(join(dir, file), "utf8")) as { ok?: unknown; epoch?: unknown; last_ok_epoch?: unknown };
    const lastOkEpoch = typeof j.last_ok_epoch === "number" ? j.last_ok_epoch : j.ok === true && typeof j.epoch === "number" ? j.epoch : null;
    return lastOkEpoch;
  } catch {
    return null;
  }
}

const iso = (epoch: number | null): string | null => (epoch === null ? null : new Date(epoch * 1000).toISOString());

export async function buildStatus(deps: StatusDeps): Promise<Record<string, unknown>> {
  const ms = deps.timeoutMs ?? 2000;
  const [database, redis] = await Promise.all([timed(deps.pingDatabase, ms, deps.now), timed(deps.pingRedis, ms, deps.now)]);
  let runtimeState: Record<string, unknown>;
  try {
    const s = await Promise.race([deps.readSafety(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
    runtimeState = { available: true, TRADING_ENABLED: s.tradingEnabled, INTAKE_ENABLED: s.intakeEnabled, KILL_SWITCH_ACTIVE: s.killSwitchActive };
  } catch {
    // fail closed in the report too: the values the processes will act on while the state is unreadable
    runtimeState = { available: false, TRADING_ENABLED: false, INTAKE_ENABLED: false, KILL_SWITCH_ACTIVE: true };
  }
  let outbox: Record<string, unknown>;
  try {
    const c = await Promise.race([deps.outboxCounts(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
    outbox = { available: true, pending: (c["PENDING"] ?? 0) + (c["FAILED"] ?? 0), processing: c["PROCESSING"] ?? 0, deadLetter: c["DEAD_LETTER"] ?? 0, completed: c["COMPLETED"] ?? 0 };
  } catch {
    outbox = { available: false };
  }
  const backups = [await lastOk(deps.statusDir, "backup.json"), await lastOk(deps.statusDir, "offhost-backup.json")].filter((x): x is number => x !== null);
  const audit = (await lastOk(deps.statusDir, "audit-verify.json")) ?? (await lastOk(deps.statusDir, "audit/audit-verify.json"));
  const healthy = database.ok === true && runtimeState["available"] === true && (outbox["available"] === true);
  return {
    status: healthy ? "ok" : "degraded",
    service: "api",
    uptimeSeconds: Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000),
    database,
    redis,
    runtimeState,
    outbox,
    lastSuccessfulBackupAt: iso(backups.length ? Math.max(...backups) : null),
    lastSuccessfulAuditVerificationAt: iso(audit),
  };
}
