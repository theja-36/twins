import type { FastifyInstance } from "fastify";
import type { Db } from "@twins/database";
import { evaluateLiveGuard } from "@twins/config";
import { loadAgentEngineConfig } from "@twins/agents";
import { getPaperSwitch, loadPaperConfig } from "@twins/paper";
import { loadBreakerConfig, loadExpiryConfig, loadPortfolioConfig, loadSizingConfig } from "@twins/risk";
import { failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * System configuration API: INTERNAL, bearer-protected, READ-ONLY. A safe snapshot of how the system is configured AS THE API PROCESS SEES IT (the worker is a separate process that is given
 * the same host settings by compose). It contains limits, switches and modes only: never a credential, a token, a connection string or a message.
 */
const attempt = <T>(f: () => T): { ok: true; value: T } | { ok: false } => { try { return { ok: true, value: f() }; } catch { return { ok: false }; } };

export function registerSystemRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer; readSafety: () => Promise<unknown> | unknown }): void {
  const guard = guardWith(deps.authorized);
  app.get("/system/config", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    try {
      const guardVerdict = evaluateLiveGuard(process.env);
      const paperCfg = attempt(() => loadPaperConfig());
      const sw = await getPaperSwitch(deps.db).catch(() => null);
      const engine = attempt(() => loadAgentEngineConfig());
      const section = <T>(a: { ok: true; value: T } | { ok: false }) => (a.ok ? { valid: true, ...a.value } : { valid: false });
      return {
        source: "api process environment",
        environment: { appEnv: process.env["APP_ENV"] ?? null, tradingMode: process.env["TRADING_MODE"] ?? null, liveTradingGuardPasses: guardVerdict.ok, liveTradingEnabled: false, brokerOrders: false },
        runtimeControls: await Promise.resolve(deps.readSafety()).catch(() => null),
        agentEngine: engine.ok ? { valid: true, enabled: engine.value.enabled, shadow: engine.value.shadow, requiredAgents: engine.value.requiredAgents, disabledAgents: engine.value.disabledAgents, haltOn: engine.value.haltOn, maxConcurrency: engine.value.maxConcurrency, thresholds: engine.value.thresholds, weights: engine.value.weights } : { valid: false },
        paperTrading: { armedByHost: paperCfg.ok ? paperCfg.value.enabled : false, switch: sw, effective: Boolean(paperCfg.ok && paperCfg.value.enabled && sw?.enabled), config: paperCfg.ok ? { slippageBps: paperCfg.value.slippageBps, entryExpiryMinutes: paperCfg.value.entryExpiryMinutes, trail: paperCfg.value.trail, trailAfterTargets: paperCfg.value.trailAfterTargets, breakevenAfterTarget1: paperCfg.value.breakevenAfterTarget1, exitFractions: paperCfg.value.exitFractions, squareOffIstMinutes: paperCfg.value.squareOffIstMinutes, maxPriceAgeSeconds: paperCfg.value.maxPriceAgeSeconds } : null },
        risk: { sizing: section(attempt(() => loadSizingConfig())), portfolio: section(attempt(() => loadPortfolioConfig())), circuitBreakers: section(attempt(() => loadBreakerConfig())), expiry: section(attempt(() => loadExpiryConfig())) },
      };
    } catch (error) { return failRoute(request, reply, error); }
  });
}
