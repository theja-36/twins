import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { actorTypeEnum } from "./enums";

/**
 * Append-only audit trail for security/trading-sensitive state changes
 * (spec section 42): auth, credential changes, risk config changes, live
 * mode changes, kill switch changes, signal ingestion, decisions, orders,
 * cancellations, fills, reconciliation failures, admin actions.
 *
 * Deliberately generic (entityType/entityId + before/after jsonb) rather
 * than one table per event type - the set of audited entities will grow
 * across later phases and shouldn't require a schema migration each time.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: idColumn(),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    metadata: jsonb("metadata"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    entityIdx: index("audit_events_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
    createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt),
  }),
);
