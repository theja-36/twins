import type { FastifyInstance } from "fastify";
import type { Db } from "@twins/database";
import { getPaperSwitch, listPaperEvents, listPaperOutcomes, listPaperPositions, listPaperSwitchEvents, loadPaperConfig, paperOutcomeStats, paperSummary, type PriceSource } from "@twins/paper";
import { failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * Paper trading API: INTERNAL, bearer-protected (the same TWINS_API_KEY), READ-ONLY. There is no route that creates, modifies or cancels a paper trade or any order; the simulation is driven
 * only by the worker's paper cycle from human-approved risk decisions. The API has no price feed of its own: it reports the last price the worker stored with each trade.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ["PENDING_ENTRY", "OPEN", "CLOSED", "CANCELLED"] as const;
const noPrices: PriceSource = { last: async () => null };

export function registerPaperRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer }): void {
  const { db } = deps;
  const guard = guardWith(deps.authorized);
  const limitOf = (raw: string | undefined, def: number): number | null => { const n = raw === undefined ? def : Number(raw); return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null; };

  app.get("/paper/status", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    try {
      const c = loadPaperConfig();
      const sw = await getPaperSwitch(db).catch(() => null);
      return { mode: "paper", enabled: c.enabled && Boolean(sw?.enabled), armedByHost: c.enabled, switch: sw, switchHistory: await listPaperSwitchEvents(db, 10).catch(() => []), liveTradingEnabled: false, brokerOrders: false, slippageBps: c.slippageBps, entryExpiryMinutes: c.entryExpiryMinutes, trail: c.trail, breakevenAfterTarget1: c.breakevenAfterTarget1, exitFractions: c.exitFractions, squareOffIstMinutes: c.squareOffIstMinutes, summary: await paperSummary(db, noPrices) };
    } catch (e) { return failRoute(request, reply, e); }
  });
  app.get("/paper/summary", async (request, reply) => { if (!guard(request, reply)) return reply; try { return await paperSummary(db, noPrices); } catch (e) { return failRoute(request, reply, e); } });
  app.get<{ Querystring: { state?: string; limit?: string } }>("/paper/positions", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = limitOf(request.query.limit, 100), state = request.query.state;
    if (limit === null || (state !== undefined && !(STATES as readonly string[]).includes(state))) return reply.code(400).send({ error: "invalid_input" });
    try { return { positions: await listPaperPositions(db, noPrices, { limit, ...(state ? { state: state as (typeof STATES)[number] } : {}) }) }; } catch (e) { return failRoute(request, reply, e); }
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/paper/trades/:id/events", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = limitOf(request.query.limit, 200);
    if (!UUID.test(request.params.id) || limit === null) return reply.code(400).send({ error: "invalid_input" });
    try { return { events: await listPaperEvents(db, request.params.id, limit) }; } catch (e) { return failRoute(request, reply, e); }
  });
  app.get<{ Querystring: { limit?: string } }>("/paper/outcomes", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = limitOf(request.query.limit, 100);
    if (limit === null) return reply.code(400).send({ error: "invalid_input" });
    try { return { outcomes: await listPaperOutcomes(db, limit) }; } catch (e) { return failRoute(request, reply, e); }
  });
  app.get("/paper/outcomes/stats", async (request, reply) => { if (!guard(request, reply)) return reply; try { return await paperOutcomeStats(db); } catch (e) { return failRoute(request, reply, e); } });
}
