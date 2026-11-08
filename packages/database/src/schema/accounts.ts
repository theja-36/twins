import { boolean, foreignKey, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { tradingModeEnum } from "./enums";
import { users } from "./users";
import { brokerConnections } from "./broker";

/**
 * A logical trading account. Every order/position/portfolio_snapshot is
 * scoped to one account, and every account is pinned to exactly one
 * trading mode - this is what makes it structurally impossible to mix
 * paper/shadow/live state (spec section 9).
 */
export const accounts = pgTable("accounts", {
  id: idColumn(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  tradingMode: tradingModeEnum("trading_mode").notNull(),
  brokerConnectionId: uuid("broker_connection_id").references(
    () => brokerConnections.id,
    { onDelete: "set null" },
  ),
  baseCurrency: text("base_currency").notNull().default("INR"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  /** Target of the composite (account_id, user_id) foreign keys of the master-build tables: a row can never name another user's account. */
  idUserUnique: uniqueIndex("accounts_id_user_unique").on(t.id, t.userId),
  /** An account can only point at a broker connection of the SAME user (no cross-user relationship). */
  brokerOwnerFk: foreignKey({ name: "accounts_broker_owner_fk", columns: [t.brokerConnectionId, t.userId], foreignColumns: [brokerConnections.id, brokerConnections.userId] }),
}));
