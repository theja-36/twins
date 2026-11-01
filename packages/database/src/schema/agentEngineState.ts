import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Agent-engine state visible to the database (P0 hardening / HB-03). One row (id = 1, seeded `false` by migration 0028). It records whether the OWNER has declared the agent engine
 * enabled, so that `twins_record_risk_approval` can refuse an approval that has no research assessment WHEN the engine is enabled - the function cannot read the worker's environment.
 * Like `system_controls`: a change is an UPDATE that bumps `version` by 1, flips the value and states a new reason; an AFTER trigger writes the append-only
 * `agent_engine_state_events` row. Changed only by the owner-run `agent-engine-control` CLI (the runtime role has SELECT only). The worker's `TWINS_AGENT_ENGINE_ENABLED` must agree with it
 * (start-up probe), so neither can quietly enable the engine without the other.
 */
export const agentEngineState = pgTable(
  "agent_engine_state",
  {
    id: smallint("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleRow: check("agent_engine_state_single_row_check", sql`${table.id} = 1`),
    versionCheck: check("agent_engine_state_version_check", sql`${table.version} >= 1`),
    reasonCheck: check("agent_engine_state_reason_check", sql`char_length(btrim(${table.reason})) between 8 and 500`),
    changedByCheck: check("agent_engine_state_changed_by_check", sql`${table.changedBy} ~ '^[A-Za-z0-9._@:-]{2,64}$'`),
  }),
);

/** APPEND-ONLY audit of every change to `agent_engine_state` (UPDATE / DELETE / TRUNCATE rejected by trigger). Written by the trigger, never by application code. */
export const agentEngineStateEvents = pgTable(
  "agent_engine_state_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    previousValue: boolean("previous_value"),
    newValue: boolean("new_value").notNull(),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionUnique: uniqueIndex("agent_engine_state_events_version_unique").on(table.version),
    timeIdx: index("agent_engine_state_events_time_idx").on(table.changedAt),
    typeCheck: check("agent_engine_state_events_type_check", sql`${table.eventType} in ('seed', 'change')`),
    previousCheck: check("agent_engine_state_events_previous_check", sql`(${table.eventType} = 'seed') = (${table.previousValue} is null)`),
  }),
);
