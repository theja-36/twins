import type { FastifyInstance } from "fastify";
import type { Db } from "@twins/database";
import { evaluateLiveGuard } from "@twins/config";
import { getPaperSwitch, loadPaperConfig, setPaperSwitch } from "@twins/paper";
import { failRoute, type Authorizer } from "./apiSupport.js";

/**
 * ADMIN API (paper trading switch). Registered ONLY when a separate admin token (TWINS_ADMIN_API_KEY, at least 32 characters, different from the read token) is configured; otherwise the
 * route does not exist (404). It can do exactly one thing: turn the audited paper-trading switch on or off. It cannot place, change or cancel anything, and turning the switch on has no
 * effect unless the host has also armed paper trading (TWINS_PAPER_TRADING_ENABLED=true). Enabling is refused while the live-trading guard fails.
 */
const ACTOR = /^(operator|service):[A-Za-z0-9._-]{1,64}$/;

export function registerAdminRoutes(app: FastifyInstance, deps: { db: Db; adminAuthorized: Authorizer }): void {
  app.post<{ Body: { enabled?: unknown; actor?: unknown; reason?: unknown } }>("/admin/paper/switch", async (request, reply) => {
    if (!deps.adminAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
    const { enabled, actor, reason } = request.body ?? {};
    if (typeof enabled !== "boolean" || typeof actor !== "string" || !ACTOR.test(actor) || typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) return reply.code(400).send({ error: "invalid_input" });
    try {
      if (enabled && !evaluateLiveGuard(process.env).ok) return reply.code(409).send({ error: "live_trading_guard_failed" });
      const outcome = await setPaperSwitch(deps.db, { enabled, actor, reason });
      const sw = await getPaperSwitch(deps.db);
      const armed = (() => { try { return loadPaperConfig().enabled; } catch { return false; } })();
      return reply.code(outcome === "unchanged" ? 200 : 201).send({ outcome, switch: sw, armedByHost: armed, effective: armed && sw.enabled });
    } catch (error) { return failRoute(request, reply, error); }
  });
}
