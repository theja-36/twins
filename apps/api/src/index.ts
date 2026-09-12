import Fastify from "fastify";
import { loadConfig } from "@twins/config";

const config = loadConfig();
const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok",
  service: "api",
  appEnv: config.appEnv,
  tradingMode: config.tradingMode,
  liveTradingEnabled: config.liveTradingEnabled,
}));

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
