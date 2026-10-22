import { getTableName } from "drizzle-orm";
import type { Db } from "../../packages/ingestion/src/db";

/**
 * A recording stand-in for the Drizzle database used by UNIT tests only (no connection, no SQL). It records every statement
 * with its table name, answers selects/inserts from the provided handlers, and records (but never performs) updates and
 * deletes, so a test can assert exactly which statements a code path issued.
 */
export interface DbCall {
  op: "select" | "insert" | "update" | "delete";
  table: string;
  values?: unknown;
  /** How the insert resolves a unique conflict, as issued: DO NOTHING (idempotent) or DO UPDATE (would overwrite). */
  onConflict?: "nothing" | "update";
}

export interface RecordingDbHandlers {
  /** Rows returned for the n-th (0-based) select on `table`. Default: none. */
  select?: (table: string, n: number) => unknown[];
  /** Rows returned by `.returning()` for an insert into `table`. Default: one row `{ id: "row-<n>" }`. */
  insert?: (table: string, values: unknown, n: number) => unknown[];
}

export function createRecordingDb(handlers: RecordingDbHandlers = {}): { db: Db; calls: DbCall[]; callsOn: (table: string) => DbCall[] } {
  const calls: DbCall[] = [];
  const selectCount = new Map<string, number>();
  const insertCount = new Map<string, number>();
  const thenable = <T,>(rows: T[]) => ({
    limit: () => thenable(rows),
    orderBy: () => thenable(rows),
    then: (resolve: (v: T[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  });
  const fake = {
    select: () => ({
      from: (table: never) => {
        const name = getTableName(table);
        const n = selectCount.get(name) ?? 0;
        selectCount.set(name, n + 1);
        calls.push({ op: "select", table: name });
        const rows = handlers.select ? handlers.select(name, n) : [];
        return { where: () => thenable(rows), ...thenable(rows) };
      },
    }),
    insert: (table: never) => {
      const name = getTableName(table);
      return {
        values: (values: unknown) => {
          const n = insertCount.get(name) ?? 0;
          insertCount.set(name, n + 1);
          const call: DbCall = { op: "insert", table: name, values };
          calls.push(call);
          const rows = handlers.insert ? handlers.insert(name, values, n) : [{ id: `row-${n}` }];
          const chain = {
            onConflictDoNothing: () => { call.onConflict = "nothing"; return chain; },
            onConflictDoUpdate: () => { call.onConflict = "update"; return chain; },
            returning: () => thenable(rows), ...thenable(rows) };
          return chain;
        },
      };
    },
    update: (table: never) => {
      calls.push({ op: "update", table: getTableName(table) });
      const chain = { set: () => chain, where: () => thenable([]), ...thenable([]) };
      return chain;
    },
    delete: (table: never) => {
      calls.push({ op: "delete", table: getTableName(table) });
      return { where: () => thenable([]), ...thenable([]) };
    },
  };
  return { db: fake as unknown as Db, calls, callsOn: (table) => calls.filter((c) => c.table === table) };
}
