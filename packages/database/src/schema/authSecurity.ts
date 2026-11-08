import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { idColumn } from "./_columns";

/**
 * Failed-login log for rate limiting (Stage 01). The key is a SHA-256 of the normalised email, so no address is stored here. Rows are short-lived: the service clears a key on success and old rows are ignored by the window.
 */
export const authLoginFailures = pgTable("auth_login_failures", {
  id: idColumn(),
  keyHash: text("key_hash").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ keyIdx: index("auth_login_failures_key_idx").on(t.keyHash, t.at) }));
