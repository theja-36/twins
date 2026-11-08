import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  /** A REFERENCE to a secret held in secret management (`secretref:<name>`), never the secret itself. The format is enforced so a raw key cannot be stored here by mistake. */
  credentialRef: text("credential_ref"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  /** Target of the composite (broker_connection_id, user_id) foreign key of accounts: an account can only use its owner's connection. */
  idUserUnique: uniqueIndex("broker_connections_id_user_unique").on(t.id, t.userId),
  credentialRefCheck: check("broker_connections_credential_ref_check", sql`${t.credentialRef} is null or ${t.credentialRef} ~ '^secretref:[A-Za-z0-9_.-]{1,100}$'`),
}));
