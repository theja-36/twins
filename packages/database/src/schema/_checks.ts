import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** `column in ('A', 'B', ...)` for a closed vocabulary. Values are code constants (never user input). */
export const oneOf = (col: AnyPgColumn, values: readonly string[]) => sql`${col} in (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "))})`;
