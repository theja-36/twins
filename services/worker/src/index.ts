import { loadConfig } from "@twins/config";

const config = loadConfig();

/**
 * Foundation-phase placeholder. Queue consumers (signal_queue, news_queue,
 * market_queue, ai_queue, backtest_queue, analytics_queue, notification_queue)
 * are added only when their owning phase requires them (spec section 46).
 */
function main(): void {
  console.log(
    `[worker] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
  );
}

main();
