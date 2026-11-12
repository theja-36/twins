import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** Minimal shape of a drizzle transaction handle (kept structural so tests can use a fake). */
export interface UserTx { execute(query: unknown): Promise<unknown> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * F5 (migration 0049): the acting user is not a setting the application names; it is bound by the DATABASE from a credential.
 *  - Inside an API request the caller's own raw session token travels in this request-scoped store (set by the API's onRequest hook). `withUser` hands it to `twins_bind_session`, which finds the live session and
 *    binds ITS user; the id the caller passes must equal that user or the call is refused. The API database role can bind nothing else.
 *  - Outside a request (the worker and scheduler cycles) there is no token: `withUser` calls `twins_bind_system_user`, executable only by the separate system role. Run under the API role it fails closed (42501).
 * The token lives only in this store for the request; it is never logged, persisted or sent anywhere but to the database over the existing connection.
 */
const credential = new AsyncLocalStorage<{ readonly token: string }>();
export const runWithSessionCredential = <T>(token: string, fn: () => T): T => credential.run({ token }, fn);
/** Test and diagnostics only: whether a request credential is in scope (never exposes the token). */
export const hasSessionCredential = (): boolean => credential.getStore() !== undefined;

const boundUser = (result: unknown): string | null => {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null | undefined)?.rows;
  const first = rows?.[0] as { uid?: unknown } | undefined;
  return typeof first?.uid === "string" ? first.uid : null;
};

/**
 * Runs `fn` inside one transaction bound to `userId` by the database (see above). The binding is transaction-scoped: it rolls back with the transaction and can never match a later one, so a pooled connection cannot
 * carry an identity from one request to the next. The id must be a UUID (checked here, and bound as a parameter).
 * Binding WRITES the identity row, so a transaction that must be READ ONLY cannot be opened read-only: open it with the isolation level you need, let `withUser` bind, then `set transaction read only` as the first statement of `fn`.
 */
export interface WithUserOptions { isolationLevel?: "read committed" | "repeatable read" | "serializable" }
export async function withUser<T>(db: Pick<Db, "transaction">, userId: string, fn: (tx: UserTx) => Promise<T>, options: WithUserOptions = {}): Promise<T> {
  if (!UUID.test(userId)) throw new TypeError("withUser needs a user UUID");
  const proof = credential.getStore();
  return db.transaction(async (tx) => {
    const t = tx as unknown as UserTx;
    const bound = proof
      ? boundUser(await t.execute(sql`select public.twins_bind_session(${proof.token}) as uid`))
      : boundUser(await t.execute(sql`select public.twins_bind_system_user(${userId}::uuid) as uid`));
    if (!bound || bound.toLowerCase() !== userId.toLowerCase()) throw new Error("withUser: the database-bound identity does not match the requested user");
    return fn(t);
  }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
}

/** Makes the CURRENT transaction read only (allowed at any point before the first write; call it right after `withUser` has bound the user). */
export const makeTransactionReadOnly = (tx: UserTx): Promise<unknown> => tx.execute(sql`set transaction read only`);
