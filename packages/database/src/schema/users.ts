import { boolean, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";

/**
 * Authenticated users of the system. Password/credential material is
 * expected to live in a hashed form here at most (never plaintext, never
 * broker/provider secrets - those stay in environment/secret management
 * per spec section 10).
 */
export const users = pgTable(
  "users",
  {
    id: idColumn(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
  }),
);
