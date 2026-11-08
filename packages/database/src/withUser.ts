import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** Minimal shape of a drizzle transaction handle (kept structural so tests can use a fake). */
export interface UserTx { execute(query: unknown): Promise<unknown> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside one transaction whose `twins.user_id` setting is `userId`, so the row-level security policies of migration 0033 match only that user's rows.
 * The setting is transaction-local (`set_config(..., true)`): it cannot leak to another request on the same pooled connection. The id must be a UUID (checked here, and bound as a parameter).
 */
export async function withUser<T>(db: Pick<Db, "transaction">, userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new TypeError("withUser needs a user UUID");
  return db.transaction(async (tx) => {
    await (tx as unknown as UserTx).execute(sql`select set_config('twins.user_id', ${userId}, true)`);
    return fn(tx as unknown as UserTx);
  });
}
