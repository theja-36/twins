import type { createDb } from "@twins/database";

/** The concrete Drizzle db handle type, shared across ingestion modules. */
export type Db = ReturnType<typeof createDb>;
