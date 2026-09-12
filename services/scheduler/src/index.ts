import { loadConfig } from "@twins/config";

const config = loadConfig();

/**
 * Foundation-phase placeholder. Scheduled jobs (data ingestion cadence,
 * provider health checks, etc.) are added starting Phase 4 (Data ingestion).
 */
function main(): void {
  console.log(
    `[scheduler] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
  );
}

main();
