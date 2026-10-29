import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Event blackout windows (Stage 3 / Task 5): admin-defined periods in which new approval-eligible decisions are blocked (CRITICAL) or only conditional
 * (WARNING). APPEND-ONLY and HASH-CHAINED (chain columns and guards are hand-written in migration 0018, same convention as 0010/0011/0014/0017). A window is
 * never edited or deleted: a CANCELLATION row references the WINDOW it withdraws. Nothing here fetches an external calendar or news feed; a future provider
 * implements the `EventWindowSource` interface in packages/risk.
 */
export const eventBlackoutWindows = pgTable(
  "event_blackout_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryType: text("entry_type").notNull(),
    /** Market code (NSE, NYSE, ...) or ALL. */
    market: text("market").notNull(),
    scope: text("scope").notNull(),
    /** The symbol for scope SYMBOL; null for scope MARKET. */
    scopeValue: text("scope_value"),
    severity: text("severity").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason"),
    cancelsId: uuid("cancels_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("event_blackout_windows_idempotency_unique").on(table.idempotencyKey),
    cancelsUnique: uniqueIndex("event_blackout_windows_cancels_unique").on(table.cancelsId),
    windowIdx: index("event_blackout_windows_window_idx").on(table.market, table.startsAt, table.endsAt),
    typeCheck: check("event_blackout_windows_type_check", sql`${table.entryType} in ('WINDOW', 'CANCELLATION')`),
    scopeCheck: check("event_blackout_windows_scope_check", sql`${table.scope} in ('MARKET', 'SYMBOL') and ((${table.scope} = 'SYMBOL') = (${table.scopeValue} is not null))`),
    severityCheck: check("event_blackout_windows_severity_check", sql`${table.severity} in ('WARNING', 'CRITICAL')`),
    timeCheck: check("event_blackout_windows_time_check", sql`${table.endsAt} > ${table.startsAt}`),
    cancelShapeCheck: check("event_blackout_windows_cancel_shape_check", sql`(${table.entryType} = 'CANCELLATION') = (${table.cancelsId} is not null)`),
    reasonCheck: check("event_blackout_windows_reason_check", sql`${table.reasonCode} ~ '^[a-z][a-z0-9_]{2,60}$' and ${table.market} ~ '^[A-Z0-9]{2,20}$'`),
    actorCheck: check("event_blackout_windows_actor_check", sql`${table.createdBy} ~ '^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$'`),
  }),
);
