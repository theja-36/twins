/**
 * Runtime safety state (Stage 1 / Task 2). Three database-backed controls, one row each in `system_controls`:
 *
 *   TRADING_ENABLED     default false  - nothing may act on trade state (order intent, broker calls) unless true
 *   INTAKE_ENABLED      default true   - new Telegram signals are accepted and processed only while true
 *   KILL_SWITCH_ACTIVE  default false  - when true, new intake, new proposals and approvals stop and no order intent is allowed;
 *                                        it dominates the other two controls
 *
 * Every change is recorded with previous value, new value, reason, changed_by and changed_at in the append-only
 * `system_control_events` table, written by a database trigger so no code path (or raw SQL) can change a control without an event.
 */
export const CONTROL_NAMES = ["TRADING_ENABLED", "INTAKE_ENABLED", "KILL_SWITCH_ACTIVE"] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];

/** The values the migration seeds. Used by documentation and tests; the running system always reads the database, never these. */
export const CONTROL_DEFAULTS: Readonly<Record<ControlName, boolean>> = {
  TRADING_ENABLED: false,
  INTAKE_ENABLED: true,
  KILL_SWITCH_ACTIVE: false,
};

/** One raw row as read from `system_controls`. Validated by the core, never trusted from a source. */
export interface ControlRow {
  control_name: unknown;
  value: unknown;
  version: unknown;
}

/** Where the controls come from. Any rejection, hang or malformed result is treated as "state unavailable" (fail closed). */
export interface StateSource {
  read(): Promise<ControlRow[]>;
}

export interface SafetySnapshot {
  tradingEnabled: boolean;
  intakeEnabled: boolean;
  killSwitchActive: boolean;
  versions: Readonly<Record<ControlName, number>>;
}

export type SafetyRequirement = "intake" | "trading" | "kill_switch_inactive";

export type RefusalReason = "kill_switch_active" | "intake_disabled" | "trading_disabled" | "state_unavailable";
export type UnavailableReason = "not_configured" | "query_failed" | "timeout" | "missing_row" | "invalid_row";
