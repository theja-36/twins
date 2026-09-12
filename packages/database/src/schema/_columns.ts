import { randomUUID } from "node:crypto";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/** UUID primary key generated in application code (no pgcrypto extension dependency). */
export function idColumn() {
  return uuid("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());
}

export function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

export function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}
