import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Runtime safety controls (Stage 1 / Task 2). Exactly three rows, one per control, seeded by migration 0009:
 *   TRADING_ENABLED (false), INTAKE_ENABLED (true), KILL_SWITCH_ACTIVE (false).
 * The rows are never inserted or deleted by application code (a trigger refuses DELETE/TRUNCATE; the primary key refuses duplicates).
 * A change is an UPDATE that must carry version = old.version + 1, a reason and changed_by (CHECK constraints + BEFORE UPDATE trigger);
 * the AFTER UPDATE trigger then writes the immutable `system_control_events` row, so a control cannot change without an audit event.
 * The triggers are hand-written in migration 0009 (drizzle cannot represent them).
 */
export const systemControls = pgTable(
  "system_controls",
  {
    controlName: text("control_name").primaryKey(),
    value: boolean("value").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameCheck: check("system_controls_name_check", sql`${table.controlName} in ('TRADING_ENABLED', 'INTAKE_ENABLED', 'KILL_SWITCH_ACTIVE')`),
    versionCheck: check("system_controls_version_check", sql`${table.version} >= 1`),
    reasonCheck: check("system_controls_reason_check", sql`char_length(btrim(${table.reason})) between 8 and 500`),
    changedByCheck: check("system_controls_changed_by_check", sql`${table.changedBy} ~ '^[A-Za-z0-9._@:-]{2,64}$'`),
  }),
);

/**
 * APPEND-ONLY audit of every change to a control (UPDATE/DELETE/TRUNCATE are rejected by trigger, SQLSTATE 23001). `previous_value` is
 * NULL only for the seed event. Written by database triggers on system_controls, never by application code.
 */
export const systemControlEvents = pgTable(
  "system_control_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    controlName: text("control_name").notNull(),
    previousValue: boolean("previous_value"),
    newValue: boolean("new_value").notNull(),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(), // seed | change
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    controlVersionUnique: uniqueIndex("system_control_events_control_version_unique").on(table.controlName, table.version),
    controlTimeIdx: index("system_control_events_control_time_idx").on(table.controlName, table.changedAt),
    nameCheck: check("system_control_events_name_check", sql`${table.controlName} in ('TRADING_ENABLED', 'INTAKE_ENABLED', 'KILL_SWITCH_ACTIVE')`),
    typeCheck: check("system_control_events_type_check", sql`${table.eventType} in ('seed', 'change')`),
    previousCheck: check("system_control_events_previous_check", sql`(${table.eventType} = 'seed') = (${table.previousValue} is null)`),
  }),
);
