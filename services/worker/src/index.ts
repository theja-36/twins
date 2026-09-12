import { loadConfig } from "@twins/config";
import { dispatchIngestionJob } from "./ingestionDispatch";

const config = loadConfig();

/**
 * Phase 4 adds `dispatchIngestionJob` as the integration point between a
 * job payload and the ingestion pipelines in @twins/ingestion. No live
 * queue consumer loop exists yet - that requires a concrete provider
 * registered in one of the adapters/* registries, which no phase has
 * added yet (spec section 55: never invent provider capabilities). This
 * export exists so a future scheduler tick or manual trigger has
 * something real to call.
 */
export { dispatchIngestionJob };

function main(): void {
  console.log(
    `[worker] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
  );
}

main();
