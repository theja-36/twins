import type { StructuredLogger } from "@twins/shared";
import { emergencyActions, type EmergencyActionRegistry } from "./emergency";
import { RuntimeStateUnavailableError, SafetyRefusalError } from "./errors";
import { CONTROL_NAMES, type ControlName, type ControlRow, type RefusalReason, type SafetyRequirement, type SafetySnapshot, type StateSource } from "./types";

export const DEFAULT_TTL_MS = 3000;
export const MIN_TTL_MS = 0;
export const MAX_TTL_MS = 5000;
export const DEFAULT_FAILURE_TTL_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 2000;
const LOG_INTERVAL_MS = 10_000;

export interface RuntimeStateOptions {
  source: StateSource;
  /** How long a successful read is trusted. 0-5000 ms (default 3000); anything else throws at construction. */
  ttlMs?: number;
  /** How long a FAILED read is remembered, so an outage does not hammer the database (default 1000). Failures always fail closed. */
  failureTtlMs?: number;
  /** A read that has not finished in this time counts as failed (default 2000). */
  timeoutMs?: number;
  logger?: StructuredLogger;
  /** Monotonic millisecond clock. Injected by tests. A clock that goes backwards makes the cache expire (fail closed). */
  clock?: () => number;
  emergency?: EmergencyActionRegistry;
}

type Cached = { kind: "ok"; snapshot: SafetySnapshot; at: number } | { kind: "fail"; error: RuntimeStateUnavailableError; at: number };

/**
 * The process-local view of the database-backed safety controls.
 *
 * FAIL CLOSED: if the source rejects, hangs past the timeout, returns no row for any of the three controls, returns a malformed row or
 * a non-boolean value, EVERY assertion refuses and every boolean accessor returns the safe value (trading false, intake false,
 * kill switch TRUE). A stale "enabled" value is never served after a failed refresh: the previous snapshot is dropped on failure.
 * Nothing defaults to enabled and no database error is swallowed (it is logged as `safety.state_unavailable` with a reason code and
 * surfaces as SafetyRefusalError(state_unavailable) / RuntimeStateUnavailableError).
 *
 * CACHE POLICY: successful reads are cached for ttlMs (default 3 s, max 5 s), so a control change made elsewhere takes effect here
 * within one TTL. Concurrent callers share a single in-flight read. forceRefresh() bypasses and replaces the cache.
 */
export class RuntimeState {
  private readonly source: StateSource;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly logger: StructuredLogger | undefined;
  private readonly clock: () => number;
  private readonly emergency: EmergencyActionRegistry;
  private cached: Cached | null = null;
  private inflight: Promise<SafetySnapshot> | null = null;
  private generation = 0;
  private lastKill: boolean | null = null;
  private readonly lastLogged = new Map<string, { at: number; suppressed: number }>();

  constructor(options: RuntimeStateOptions) {
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) throw new Error(`runtime state ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error("runtime state timeoutMs must be a positive number");
    this.source = options.source;
    this.ttlMs = ttl;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.timeoutMs = timeout;
    this.logger = options.logger;
    this.clock = options.clock ?? (() => performance.now());
    this.emergency = options.emergency ?? emergencyActions;
  }

  /** The current validated state. Throws RuntimeStateUnavailableError when it cannot be established. */
  async snapshot(): Promise<SafetySnapshot> {
    const now = this.clock();
    const c = this.cached;
    if (c) {
      const age = now - c.at;
      // age < 0 = the clock went backwards: not trustworthy, so refresh instead of serving the cache.
      if (age >= 0 && age < (c.kind === "ok" ? this.ttlMs : this.failureTtlMs)) {
        if (c.kind === "ok") return c.snapshot;
        throw new RuntimeStateUnavailableError(c.error.reason, c.error.detail);
      }
    }
    return this.refresh();
  }

  /** Reads the database now, bypassing and replacing the cache (tests, operational tooling, after an admin change). */
  async forceRefresh(): Promise<SafetySnapshot> {
    this.cached = null;
    this.inflight = null; // a read that started before this call may predate the change being checked: start a new one (the old result is ignored)
    return this.refresh();
  }

  /** Drops the cache without reading; the next call reads the database. */
  invalidate(): void {
    this.cached = null;
  }

  private refresh(): Promise<SafetySnapshot> {
    if (this.inflight) return this.inflight;
    const generation = ++this.generation;
    const attempt = this.readOnce().then(
      (snapshot) => {
        if (generation === this.generation) {
          this.cached = { kind: "ok", snapshot, at: this.clock() };
          this.observe(snapshot);
        }
        return snapshot;
      },
      (error: unknown) => {
        const failure = error instanceof RuntimeStateUnavailableError ? error : new RuntimeStateUnavailableError("query_failed", errorCode(error));
        if (generation === this.generation) this.cached = { kind: "fail", error: failure, at: this.clock() }; // the old snapshot is dropped: no stale "enabled"
        this.logRateLimited("state_unavailable", "safety.state_unavailable", { cause: failure.reason, detail: failure.detail });
        throw failure;
      },
    );
    const tracked = attempt.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    this.inflight = tracked;
    return tracked;
  }

  private async readOnce(): Promise<SafetySnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RuntimeStateUnavailableError("timeout")), this.timeoutMs);
    });
    let rows: ControlRow[];
    try {
      rows = await Promise.race([Promise.resolve().then(() => this.source.read()), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return validateRows(rows);
  }

  /** Detects kill-switch transitions seen by this process, emits the structured safety event and triggers registered emergency actions. */
  private observe(snapshot: SafetySnapshot): void {
    const previous = this.lastKill;
    this.lastKill = snapshot.killSwitchActive;
    if (snapshot.killSwitchActive && previous !== true) {
      this.logger?.error("safety.kill_switch.observed", { version: snapshot.versions.KILL_SWITCH_ACTIVE, firstObservation: previous === null });
      this.runEmergencyActions({ origin: "observed", version: snapshot.versions.KILL_SWITCH_ACTIVE });
    } else if (!snapshot.killSwitchActive && previous === true) {
      this.logger?.warn("safety.kill_switch.cleared_observed", { version: snapshot.versions.KILL_SWITCH_ACTIVE });
    }
  }

  runEmergencyActions(event: { origin: "observed" | "admin"; version?: number }): void {
    for (const action of this.emergency.list()) {
      void Promise.resolve()
        .then(() => action.run(event))
        .catch((error: unknown) => this.logger?.error("safety.emergency_action.failed", { action: action.name, errorName: error instanceof Error ? error.name : "Error" }));
    }
  }

  // ── boolean accessors: always return the SAFE value when the state is unavailable ──────────────────────────────────

  async isTradingEnabled(): Promise<boolean> {
    try {
      const s = await this.snapshot();
      return s.tradingEnabled && !s.killSwitchActive;
    } catch {
      return false; // already logged by refresh(); fail closed
    }
  }

  async isIntakeEnabled(): Promise<boolean> {
    try {
      const s = await this.snapshot();
      return s.intakeEnabled && !s.killSwitchActive;
    } catch {
      return false;
    }
  }

  async isKillSwitchActive(): Promise<boolean> {
    try {
      return (await this.snapshot()).killSwitchActive;
    } catch {
      return true; // unknown = treated as active
    }
  }

  // ── assertions ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Non-throwing form for gating code that must answer (HTTP 503, delay a job): null = allowed, otherwise the refusal. */
  async evaluate(requirement: SafetyRequirement, operation: string): Promise<SafetyRefusalError | null> {
    let s: SafetySnapshot;
    try {
      s = await this.snapshot();
    } catch (error) {
      const cause = error instanceof RuntimeStateUnavailableError ? error : new RuntimeStateUnavailableError("query_failed");
      return this.refusal(operation, "state_unavailable", cause);
    }
    if (s.killSwitchActive) return this.refusal(operation, "kill_switch_active");
    if (requirement === "intake" && !s.intakeEnabled) return this.refusal(operation, "intake_disabled");
    if (requirement === "trading" && !s.tradingEnabled) return this.refusal(operation, "trading_disabled");
    return null;
  }

  private refusal(operation: string, reason: RefusalReason, cause?: RuntimeStateUnavailableError): SafetyRefusalError {
    this.logRateLimited(`${operation}|${reason}`, "safety.refused", { operation, reason });
    return new SafetyRefusalError(operation, reason, cause ? { cause } : undefined);
  }

  async assertTradingEnabled(operation: string): Promise<void> {
    const r = await this.evaluate("trading", operation);
    if (r) throw r;
  }

  async assertIntakeEnabled(operation: string): Promise<void> {
    const r = await this.evaluate("intake", operation);
    if (r) throw r;
  }

  async assertKillSwitchInactive(operation: string): Promise<void> {
    const r = await this.evaluate("kill_switch_inactive", operation);
    if (r) throw r;
  }

  private logRateLimited(key: string, event: string, fields: Record<string, unknown>): void {
    if (!this.logger) return;
    const now = this.clock();
    const prev = this.lastLogged.get(key);
    if (prev && now - prev.at >= 0 && now - prev.at < LOG_INTERVAL_MS) {
      prev.suppressed += 1;
      return;
    }
    this.lastLogged.set(key, { at: now, suppressed: 0 });
    if (this.lastLogged.size > 500) this.lastLogged.clear(); // bounded: operation names are a finite set, this is only a backstop
    this.logger.warn(event, { ...fields, suppressedSinceLast: prev?.suppressed ?? 0 });
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : "unknown";
}

/** Strict validation: all three controls present exactly once with boolean values and a positive integer version, or the state is invalid. */
function validateRows(rows: unknown): SafetySnapshot {
  if (!Array.isArray(rows)) throw new RuntimeStateUnavailableError("invalid_row", "not_an_array");
  const found = new Map<ControlName, { value: boolean; version: number }>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) throw new RuntimeStateUnavailableError("invalid_row", "not_an_object");
    const row = raw as ControlRow;
    const name = CONTROL_NAMES.find((n) => n === row.control_name);
    if (!name) continue; // unknown extra rows are ignored
    if (found.has(name)) throw new RuntimeStateUnavailableError("invalid_row", `duplicate:${name}`);
    if (typeof row.value !== "boolean") throw new RuntimeStateUnavailableError("invalid_row", `non_boolean:${name}`);
    const version = typeof row.version === "string" && /^[0-9]{1,15}$/.test(row.version) ? Number(row.version) : row.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new RuntimeStateUnavailableError("invalid_row", `bad_version:${name}`);
    found.set(name, { value: row.value, version });
  }
  for (const name of CONTROL_NAMES) if (!found.has(name)) throw new RuntimeStateUnavailableError("missing_row", name);
  const get = (n: ControlName) => found.get(n) as { value: boolean; version: number };
  return {
    tradingEnabled: get("TRADING_ENABLED").value,
    intakeEnabled: get("INTAKE_ENABLED").value,
    killSwitchActive: get("KILL_SWITCH_ACTIVE").value,
    versions: { TRADING_ENABLED: get("TRADING_ENABLED").version, INTAKE_ENABLED: get("INTAKE_ENABLED").version, KILL_SWITCH_ACTIVE: get("KILL_SWITCH_ACTIVE").version },
  };
}
