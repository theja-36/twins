import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { jobStatusEnum, providerHealthStatusEnum, providerTypeEnum } from "./enums";

/**
 * Operational health snapshots for external providers (spec section 44).
 * This is operational information only - never a substitute for, or input
 * to, trading confidence (spec section 44).
 */
export const providerHealth = pgTable(
  "provider_health",
  {
    id: idColumn(),
    providerName: text("provider_name").notNull(),
    providerType: providerTypeEnum("provider_type").notNull(),
    status: providerHealthStatusEnum("status").notNull(),
    latencyMs: numeric("latency_ms"),
    errorRate: numeric("error_rate"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    providerIdx: index("provider_health_provider_idx").on(
      table.providerName,
      table.checkedAt,
    ),
  }),
);

/**
 * Durable record of background jobs (spec sections 46/47). Redis carries
 * the live queue transport; this table is the authoritative, queryable
 * record of what ran, so Redis never has to be treated as permanent
 * storage.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: idColumn(),
    jobType: text("job_type").notNull(),
    queueName: text("queue_name").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    payload: jsonb("payload"),
    result: jsonb("result"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    queueStatusIdx: index("jobs_queue_status_idx").on(
      table.queueName,
      table.status,
    ),
  }),
);
