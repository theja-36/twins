import type { LogSink } from "@twins/shared";
import type { Alerter } from "./alerter";
import type { AlertInput } from "./payload";

type Fields = Record<string, unknown>;
interface Rule {
  /** Structured-log event name that triggers the rule. */
  on: string;
  when?: (f: Fields) => boolean;
  to: (f: Fields) => (AlertInput & { dedupeKey?: string }) | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * Severity policy as data. Every rule maps a structured log event that the code ALREADY emits (with sanitised fields) to an alert built from a fixed
 * template. Message content never reaches this layer (the logger strips it) and the alert builder only keeps allow-listed detail keys.
 */
export const ALERT_RULES: readonly Rule[] = [
  // ── CRITICAL ──
  { on: "safety.outbox.dead_lettered", to: (f) => ({ event: "outbox.dead_lettered", severity: "CRITICAL", code: str(f["errorCode"]) || "dead_lettered", summary: "An intake message could not be processed and was dead-lettered; operator action required.", correlationId: str(f["correlationId"]) || undefined, details: f, dedupeKey: str(f["outboxId"]) }) },
  { on: "safety.outbox.stuck", to: (f) => ({ event: "outbox.stuck", severity: "CRITICAL", code: "reconciler_cannot_recover", summary: "The outbox reconciler cannot get one or more intake rows moving.", details: f, dedupeKey: "stuck" }) },
  { on: "safety.kill_switch.activated", to: (f) => ({ event: "safety.kill_switch_activated", severity: "CRITICAL", code: "kill_switch_active", summary: "The kill switch was activated: intake, approvals and order intents are blocked.", details: { ...f, control: "KILL_SWITCH_ACTIVE" }, dedupeKey: str(f["version"]) }) },
  { on: "safety.control.changed", when: (f) => f["control"] === "TRADING_ENABLED" && f["newValue"] === true, to: (f) => ({ event: "safety.trading_enabled", severity: "CRITICAL", code: "trading_enabled", summary: "TRADING_ENABLED was switched on.", details: f, dedupeKey: str(f["version"]) }) },
  { on: "safety.state_unavailable", to: (f) => ({ event: "runtime_state.unavailable", severity: "CRITICAL", code: str(f["cause"]) || "state_unavailable", summary: "The runtime safety state cannot be read: the process is failing closed.", details: f, dedupeKey: "state" }) },
  { on: "backup.failed", to: (f) => backupFailure("backup", f) },
  { on: "verify.failed", to: (f) => ({ event: "backup.verification_failed", severity: "CRITICAL", code: "verification_problems", summary: "Off-host backup verification found problems (checksum mismatch, missing or stale backup).", details: f, dedupeKey: "verify" }) },
  { on: "drill.failed", to: (f) => ({ event: "backup.restore_drill_failed", severity: "CRITICAL", code: str(f["failure"]) || "drill_failed", summary: "The restore drill failed.", details: f, dedupeKey: "drill" }) },
  { on: "audit.verification.failed", to: (f) => ({ event: str(f["protection"]) === "true" ? "audit.protection_failed" : "audit.verification_failed", severity: "CRITICAL", code: str(f["firstFailure"]) || "verification_failed", summary: "Audit-chain verification failed.", details: f, dedupeKey: "audit" }) },
  { on: "migration.failed", to: (f) => ({ event: "migration.failed", severity: "CRITICAL", code: str(f["errorCode"]) || "migration_failed", summary: "A database migration failed.", details: f, dedupeKey: "migration" }) },
  { on: "process.restart_loop", to: (f) => ({ event: "process.restart_loop", severity: "CRITICAL", code: "restart_loop", summary: "A service is restarting repeatedly.", details: f, dedupeKey: str(f["service"]) }) },
  { on: "telegram.capture.gap", to: (f) => ({ event: "telegram.capture_gap", severity: "CRITICAL", code: "capture_gap", summary: "No Telegram update has been durably captured for longer than the configured threshold; the capture client may be down.", details: { ageSeconds: num(f["ageSeconds"]), windowSeconds: num(f["windowSeconds"]) }, dedupeKey: "capture_gap" }) },
  { on: "agent_engine.config.invalid", to: (f) => ({ event: "agent_engine.config_invalid", severity: "CRITICAL", code: str(f["errorCode"]) || "engine_config_invalid", summary: "The agent engine configuration is invalid: the process cannot start with it.", details: f, dedupeKey: "engine_config" }) },
  { on: "agent_engine.run.failed", to: (f) => ({ event: "agent_engine.run_failed", severity: "CRITICAL", code: str(f["errorCode"]) || "engine_run_failed", summary: "An enforcing agent-engine run failed: the risk flow fails closed for that decision.", details: f, dedupeKey: "engine_run" }) },
  { on: "kite.session.invalidated", to: (f) => ({ event: "kite.session_invalidated", severity: "CRITICAL", code: str(f["reason"]) || "session_invalid", summary: "The Kite session is no longer valid (daily token expiry or server rejection); a new login is needed before any Kite read works.", details: { reason: str(f["reason"]) }, dedupeKey: "kite_session" }) },
  { on: "worker.queue.job_failed", when: (f) => num(f["maxAttempts"]) > 0 && num(f["attemptsMade"]) >= num(f["maxAttempts"]), to: (f) => ({ event: "queue.job_exhausted", severity: "CRITICAL", code: "attempts_exhausted", summary: "A queue job failed its last attempt and will not be retried.", details: { name: str(f["queue"]), attempt: num(f["attemptsMade"]), maxAttempts: num(f["maxAttempts"]) }, dedupeKey: `${str(f["queue"])}:${str(f["jobId"])}` }) },
  // ── WARNING ──
  { on: "outbox.reconciled", when: (f) => f["action"] === "lease_expired", to: (f) => ({ event: "outbox.stale_job_recovered", severity: "WARNING", code: "lease_expired", summary: "The reconciler recovered a stale processing row (a worker likely died mid-job).", details: f, dedupeKey: str(f["outboxId"]) }) },
  { on: "outbox.retry_scheduled", when: (f) => num(f["maxAttempts"]) > 0 && num(f["attempt"]) >= num(f["maxAttempts"]) - 2, to: (f) => ({ event: "outbox.retry_threshold", severity: "WARNING", code: str(f["errorCode"]) || "retrying", summary: "An intake row is close to its retry limit and will be dead-lettered if it keeps failing.", details: f, dedupeKey: str(f["outboxId"]) }) },
  { on: "backup.delayed", to: (f) => ({ event: "backup.delayed", severity: "WARNING", code: "backup_delayed", summary: "The last successful backup is older than expected.", details: f, dedupeKey: "delayed" }) },
  { on: "safety.control.changed", when: (f) => f["control"] === "INTAKE_ENABLED" && f["newValue"] === false, to: (f) => ({ event: "safety.intake_disabled", severity: "WARNING", code: "intake_disabled", summary: "INTAKE_ENABLED was switched off.", details: f, dedupeKey: str(f["version"]) }) },
  { on: "agent_engine.shadow.failed", to: (f) => ({ event: "agent_engine.shadow_failed", severity: "WARNING", code: str(f["errorCode"]) || "shadow_failed", summary: "A shadow-mode agent evaluation could not run (the live flow is unaffected).", details: f, dedupeKey: `shadow:${str(f["reason"])}` }) },
  // ── INFO ──
  { on: "safety.control.changed", when: (f) => f["control"] === "KILL_SWITCH_ACTIVE" && f["newValue"] === false, to: (f) => ({ event: "safety.kill_switch_cleared", severity: "INFO", code: "kill_switch_cleared", summary: "The kill switch was cleared.", details: f, dedupeKey: str(f["version"]) }) },
];

function backupFailure(kind: string, f: Fields): AlertInput & { dedupeKey?: string } {
  const failure = str(f["failure"]);
  const step = str(f["step"]);
  if (failure === "checksum_mismatch") return { event: `${kind}.checksum_mismatch`, severity: "CRITICAL", code: failure, summary: "A backup checksum did not match: the stored artifact is not the one that was created.", details: f, dedupeKey: "checksum" };
  if (step === "upload" || step === "verify_upload" || step === "upload_manifest" || failure === "upload_failed") return { event: `${kind}.upload_failed`, severity: "CRITICAL", code: failure || "upload_failed", summary: "The off-host upload failed; the encrypted artifact is kept locally and will be retried.", details: f, dedupeKey: "upload" };
  return { event: `${kind}.failed`, severity: "CRITICAL", code: failure || "backup_failed", summary: "The backup failed.", details: f, dedupeKey: "backup" };
}

/** Wraps a log sink: every record is still written, and records that match a rule also raise an alert. Alert logs (`alert.*`) never trigger rules. */
export function alertingSink(inner: LogSink, alerter: Alerter, rules: readonly Rule[] = ALERT_RULES): LogSink {
  return (record) => {
    inner(record);
    if (record.event.startsWith("alert.")) return;
    for (const rule of rules) {
      if (rule.on !== record.event) continue;
      const fields = record as unknown as Fields;
      try {
        if (rule.when && !rule.when(fields)) continue;
        const input = rule.to(fields);
        if (input) alerter.alert(input);
      } catch {
        /* an alerting problem must never break the process */
      }
    }
  };
}
