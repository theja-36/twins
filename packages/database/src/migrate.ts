import { migrate } from "drizzle-orm/node-postgres/migrator";
import { enforceLiveTradingGuard, loadConfig } from "@twins/config";
import { createDb } from "./client";

async function main(): Promise<void> {
  enforceLiveTradingGuard("migrate");
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  console.log("[database] migrations applied");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[database] migration failed", err);
  // CRITICAL alert (best effort, never blocks the exit): only a fixed event and an error CODE leave the process.
  try {
    const { alerterFromEnv } = await import("@twins/alerting");
    const alerter = alerterFromEnv(process.env, "migrate");
    const code = typeof (err as { code?: unknown } | null)?.code === "string" ? String((err as { code: string }).code) : "migration_failed";
    alerter.alert({ event: "migration.failed", severity: "CRITICAL", code, summary: "A database migration failed.", dedupeKey: "migration" });
    await alerter.flush();
  } catch { /* alerting must never mask the migration failure */ }
  process.exit(1);
});
