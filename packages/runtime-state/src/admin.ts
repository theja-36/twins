import type { StructuredLogger } from "@twins/shared";
import { ControlChangeInvalidError, ControlChangeRefusedError, StaleControlVersionError } from "./errors";
import { emergencyActions, type EmergencyActionRegistry } from "./emergency";
import { CONTROL_NAMES, type ControlName } from "./types";

/**
 * Administrative changes to the safety controls. This is a LIBRARY used by the operations CLI (scripts/ops/safety-control.ts); there is
 * deliberately NO HTTP endpoint. The authorization boundary is the database credential: only a role that can UPDATE system_controls
 * (the schema owner; the approval-bot role is read-only on it) can change a control, and the CLI is run on the host / one-shot compose job.
 * `changedBy` is a self-declared identity recorded for accountability, NOT an authenticated one (see docs/twins).
 *
 * Every change is one transaction: lock all three rows in a fixed order (so concurrent changes serialize and cannot deadlock), apply the
 * rules, UPDATE with version+1. The AFTER UPDATE trigger in migration 0009 writes the immutable event (previous value, new value, reason,
 * changed_by, changed_at); the application cannot skip it.
 */
export interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  release(error?: Error | boolean): void;
}
export interface PoolLike {
  connect(): Promise<ClientLike>;
}

/**
 * Operator identity convention (no authentication system yet; this makes the declared identity unambiguous and machine-checkable):
 *   mechanism "cli"     -> changedBy must be `operator:<name>`  (a person using scripts/ops/safety-control.ts)
 *   mechanism "service" -> changedBy must be `service:<name>`   (an automated component, e.g. a future circuit breaker)
 * The database repeats this rule as a CHECK on system_control_events and records, next to the declared identity, the source process, the
 * declared operator context (os user, host, pid...) and what the DATABASE observed (session user, client address, application name).
 * A change made with raw SQL has mechanism "sql" and source "raw_sql" and is therefore distinguishable from a CLI or service change.
 */
export type ChangeMechanism = "cli" | "service";
export type OperatorContext = Record<string, string | number | boolean>;

export interface ChangeControlInput {
  control: ControlName;
  value: boolean;
  reason: string;
  changedBy: string;
  mechanism: ChangeMechanism;
  /** The process making the change, e.g. "safety-control". */
  sourceProcess: string;
  /** Declared context (not authenticated): os_user, host, pid... Bounded to 1500 characters of JSON. */
  operatorContext?: OperatorContext;
  /** Optional compare-and-set: refuse if the control's version is not exactly this. */
  expectedVersion?: number;
}

export interface ChangeControlResult {
  changed: boolean;
  control: ControlName;
  previousValue: boolean;
  newValue: boolean;
  /** Version after the call (unchanged version when changed === false). */
  version: number;
}

export interface ControlStatus {
  control: ControlName;
  value: boolean;
  version: number;
  reason: string;
  changedBy: string;
  changedAt: Date;
}

const IDENTITY: Record<ChangeMechanism, RegExp> = {
  cli: /^operator:[a-z0-9][a-z0-9._-]{1,40}$/,
  service: /^service:[a-z0-9][a-z0-9._-]{1,40}$/,
};
const SOURCE_PROCESS = /^[A-Za-z0-9._:-]{2,64}$/;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

export function validateChange(input: ChangeControlInput): void {
  if (!CONTROL_NAMES.includes(input.control)) throw new ControlChangeInvalidError("unknown control name");
  if (typeof input.value !== "boolean") throw new ControlChangeInvalidError("the target state must be an explicit boolean");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 8 || reason.length > 500 || CONTROL_CHARS.test(reason)) throw new ControlChangeInvalidError("a reason of 8-500 printable characters is required");
  if (input.mechanism !== "cli" && input.mechanism !== "service") throw new ControlChangeInvalidError("mechanism must be cli or service");
  if (typeof input.changedBy !== "string" || !IDENTITY[input.mechanism].test(input.changedBy)) {
    throw new ControlChangeInvalidError(`changed_by must be ${input.mechanism === "cli" ? "operator:<name>" : "service:<name>"} (lower-case letters, digits, . _ -; 2-41 characters after the prefix)`);
  }
  if (typeof input.sourceProcess !== "string" || !SOURCE_PROCESS.test(input.sourceProcess)) throw new ControlChangeInvalidError("sourceProcess must be 2-64 characters of A-Za-z0-9._:-");
  if (input.operatorContext !== undefined) {
    const ctx = input.operatorContext as Record<string, unknown>;
    if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx) || Object.values(ctx).some((v) => typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") || JSON.stringify(ctx).length > 1500) {
      throw new ControlChangeInvalidError("operatorContext must be a flat object of strings, numbers and booleans, at most 1500 characters as JSON");
    }
  }
  if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) throw new ControlChangeInvalidError("expectedVersion must be a positive integer");
}

export interface AdminDeps {
  logger?: StructuredLogger;
  emergency?: EmergencyActionRegistry;
}

export async function changeControl(pool: PoolLike, input: ChangeControlInput, deps: AdminDeps = {}): Promise<ChangeControlResult> {
  validateChange(input);
  const client = await pool.connect();
  let result: ChangeControlResult;
  try {
    await client.query("begin");
    try {
      const locked = (await client.query("select control_name, value, version from system_controls order by control_name for update")).rows;
      const byName = new Map(locked.map((r) => [String(r["control_name"]), r]));
      for (const name of CONTROL_NAMES) if (!byName.has(name)) throw new ControlChangeRefusedError("control_row_missing", `control row ${name} is missing (migration 0009 not applied or tampered)`);
      const row = byName.get(input.control) as Record<string, unknown>;
      const previous = row["value"] === true;
      const version = Number(row["version"]);
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) throw new StaleControlVersionError(input.expectedVersion, version);
      if (previous === input.value) {
        await client.query("rollback");
        return { changed: false, control: input.control, previousValue: previous, newValue: input.value, version };
      }
      if (input.control === "TRADING_ENABLED" && input.value && (byName.get("KILL_SWITCH_ACTIVE") as Record<string, unknown>)["value"] === true) {
        throw new ControlChangeRefusedError("kill_switch_active", "trading cannot be enabled while the kill switch is active");
      }
      // Declared operator context for the audit trigger (transaction-local). The trigger also records what the database itself observed.
      await client.query("select set_config('twins.change_mechanism', $1, true), set_config('twins.source_process', $2, true), set_config('twins.operator_context', $3, true)", [input.mechanism, input.sourceProcess, JSON.stringify(input.operatorContext ?? {})]);
      const updated = (
        await client.query("update system_controls set value = $2, version = version + 1, reason = $3, changed_by = $4 where control_name = $1 returning version", [input.control, input.value, input.reason.trim(), input.changedBy])
      ).rows[0] as Record<string, unknown>;
      await client.query("commit");
      result = { changed: true, control: input.control, previousValue: previous, newValue: input.value, version: Number(updated["version"]) };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
  deps.logger?.warn("safety.control.changed", { control: result.control, previousValue: result.previousValue, newValue: result.newValue, version: result.version, changedBy: input.changedBy, mechanism: input.mechanism, sourceProcess: input.sourceProcess });
  if (result.control === "KILL_SWITCH_ACTIVE" && result.newValue) {
    deps.logger?.error("safety.kill_switch.activated", { version: result.version, changedBy: input.changedBy });
    for (const action of (deps.emergency ?? emergencyActions).list()) {
      void Promise.resolve()
        .then(() => action.run({ origin: "admin", version: result.version }))
        .catch((e: unknown) => deps.logger?.error("safety.emergency_action.failed", { action: action.name, errorName: e instanceof Error ? e.name : "Error" }));
    }
  }
  return result;
}

export async function readControlStatus(pool: PoolLike): Promise<ControlStatus[]> {
  const client = await pool.connect();
  try {
    const rows = (await client.query("select control_name, value, version, reason, changed_by, changed_at from system_controls order by control_name")).rows;
    return rows.map((r) => ({
      control: r["control_name"] as ControlName,
      value: r["value"] === true,
      version: Number(r["version"]),
      reason: String(r["reason"]),
      changedBy: String(r["changed_by"]),
      changedAt: r["changed_at"] as Date,
    }));
  } finally {
    client.release();
  }
}

export interface ControlEvent {
  chainIndex: number;
  changeMechanism: string;
  sourceProcess: string;
  operatorContext: unknown;
  dbSessionUser: string | null;
  dbClientAddr: string | null;
  dbApplicationName: string | null;
  controlName: string;
  previousValue: boolean | null;
  newValue: boolean;
  reason: string;
  changedBy: string;
  changedAt: Date;
  version: number;
  eventType: string;
}

export async function readControlEvents(pool: PoolLike, limit = 20): Promise<ControlEvent[]> {
  const client = await pool.connect();
  try {
    const rows = (await client.query("select control_name, previous_value, new_value, reason, changed_by, changed_at, version, event_type, chain_index, change_mechanism, source_process, operator_context, db_session_user, db_client_addr, db_application_name from system_control_events order by chain_index desc limit $1", [Math.min(Math.max(limit, 1), 200)])).rows;
    return rows.map((r) => ({
      controlName: String(r["control_name"]),
      previousValue: r["previous_value"] === null ? null : r["previous_value"] === true,
      newValue: r["new_value"] === true,
      reason: String(r["reason"]),
      changedBy: String(r["changed_by"]),
      changedAt: r["changed_at"] as Date,
      version: Number(r["version"]),
      eventType: String(r["event_type"]),
      chainIndex: Number(r["chain_index"]),
      changeMechanism: String(r["change_mechanism"]),
      sourceProcess: String(r["source_process"]),
      operatorContext: r["operator_context"],
      dbSessionUser: (r["db_session_user"] as string | null) ?? null,
      dbClientAddr: (r["db_client_addr"] as string | null) ?? null,
      dbApplicationName: (r["db_application_name"] as string | null) ?? null,
    }));
  } finally {
    client.release();
  }
}
