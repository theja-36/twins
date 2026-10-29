import type { ControlRow, StateSource } from "./types";

/** The only thing the reader needs from a database handle (pg.Pool, pg.Client or a restricted-role wrapper all satisfy it). */
export interface Queryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export const READ_CONTROLS_SQL = "select control_name, value, version from system_controls";

/** Reads the three controls from PostgreSQL. A failure propagates (the core turns it into fail-closed); nothing is caught here. */
export function pgStateSource(db: Queryable): StateSource {
  return {
    async read(): Promise<ControlRow[]> {
      const result = await db.query(READ_CONTROLS_SQL);
      return result.rows as ControlRow[];
    },
  };
}
