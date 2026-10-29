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

main().catch((err) => {
  console.error("[database] migration failed", err);
  process.exit(1);
});
