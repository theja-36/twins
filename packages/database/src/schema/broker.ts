import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { providerHealthStatusEnum } from "./enums";
import { users } from "./users";

/**
 * A connection to a broker adapter (spec section 12/43: BrokerProvider
 * interface, adapter-per-provider). This table records connection identity
 * and health only - actual API keys/secrets are never stored here, only in
 * environment/secret management (spec section 10). `providerAccountId` is
 * the broker's own account identifier, which is not a secret.
 */
export const brokerConnections = pgTable("broker_connections", {
  id: idColumn(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id"),
  status: providerHealthStatusEnum("status").notNull().default("down"),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
