import { sql } from "drizzle-orm";
import { check, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { riskDecisions } from "./riskDecisions";

/**
 * Loss events (Stage 3 / Task 4): the explicit, auditable source of REALIZED loss for the circuit breakers. APPEND-ONLY and HASH-CHAINED (the chain
 * columns and guards are added by hand in migration 0017, same convention as 0010/0011/0014). A row records a loss MAGNITUDE (> 0); no profit offsets
 * it. No broker fills or realized P&L exist yet: rows come from `synthetic` (tests / drills; refused in production), `manual_adjustment` (operator) or,
 * later, `broker_reconciliation`. Nothing derives a loss from a signal or a decision.
 */
export const lossEvents = pgTable(
  "loss_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    amount: numeric("amount").notNull(),
    currency: text("currency").notNull().default("INR"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    /** The external reference of the loss (a fill / reconciliation id, a test id). */
    sourceRef: text("source_ref").notNull(),
    riskDecisionId: uuid("risk_decision_id").references(() => riskDecisions.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    details: jsonb("details"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("loss_events_idempotency_unique").on(table.idempotencyKey),
    sourceRefUnique: uniqueIndex("loss_events_source_ref_unique").on(table.source, table.sourceRef),
    occurredIdx: index("loss_events_occurred_idx").on(table.occurredAt),
    amountCheck: check("loss_events_amount_check", sql`${table.amount} > 0`),
    sourceCheck: check("loss_events_source_check", sql`${table.source} in ('synthetic', 'manual_adjustment', 'broker_reconciliation')`),
    actorCheck: check("loss_events_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);

/**
 * Circuit-breaker events: the durable, append-only history of the daily and weekly loss circuit breakers. A breaker's state is DERIVED from these rows
 * (never updated): it is open while a BREACHED row exists whose `period_end` (the reset time) is in the future and no RESET row references it. It is
 * separate from the manual kill switch (system_controls) and cannot lift it.
 */
export const circuitBreakerEvents = pgTable(
  "circuit_breaker_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    eventType: text("event_type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    /** BREACHED: the reset time (next trading day / week). WARNED and RESET: the end of the period the row concerns. */
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    lossAmount: numeric("loss_amount").notNull(),
    limitAmount: numeric("limit_amount").notNull(),
    capital: numeric("capital").notNull(),
    lossPct: numeric("loss_pct").notNull(),
    plannedExposureAmount: numeric("planned_exposure_amount").notNull(),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason"),
    breachEventId: uuid("breach_event_id"),
    resetAuthorization: text("reset_authorization"),
    idempotencyKey: text("idempotency_key").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("circuit_breaker_events_idempotency_unique").on(table.idempotencyKey),
    breachUnique: uniqueIndex("circuit_breaker_events_breach_unique").on(table.breachEventId),
    scopeIdx: index("circuit_breaker_events_scope_idx").on(table.scope, table.eventType, table.periodEnd),
    scopeCheck: check("circuit_breaker_events_scope_check", sql`${table.scope} in ('DAILY', 'WEEKLY')`),
    typeCheck: check("circuit_breaker_events_type_check", sql`${table.eventType} in ('WARNED', 'BREACHED', 'RESET')`),
    numbersCheck: check("circuit_breaker_events_numbers_check", sql`${table.lossAmount} >= 0 and ${table.limitAmount} > 0 and ${table.capital} > 0 and ${table.lossPct} >= 0 and ${table.plannedExposureAmount} >= 0 and ${table.periodEnd} > ${table.periodStart}`),
    resetShapeCheck: check("circuit_breaker_events_reset_shape_check", sql`(${table.eventType} = 'RESET') = (${table.breachEventId} is not null) and (${table.eventType} = 'RESET') = (${table.resetAuthorization} is not null)`),
    actorCheck: check("circuit_breaker_events_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);
