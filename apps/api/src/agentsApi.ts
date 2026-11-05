import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { createProductionRegistry, loadAgentEngineConfig, loadAgentRulesConfig } from "@twins/agents";
import { clampLimit, failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * Agent status API: INTERNAL, bearer-protected, READ-ONLY. Shows which research agents exist (contract metadata only), how the engine is configured as this process sees it, and the
 * recent PERSISTED orchestrator runs. Shadow-mode evaluations are logged, not stored (HB-25), so they do not appear in `recentRuns`. No inputs, outputs or message text are returned.
 */
export function registerAgentsRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer }): void {
  const guard = guardWith(deps.authorized);
  app.get<{ Querystring: { limit?: string } }>("/agents/status", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = clampLimit(request.query.limit, 20, 100);
    if (limit === null) return reply.code(400).send({ error: "invalid_input" });
    try {
      let engine: { enabled: boolean; shadow: boolean; haltOn: string[]; requiredAgents: string[]; disabledAgents: string[]; configValid: boolean } = { enabled: false, shadow: false, haltOn: [], requiredAgents: [], disabledAgents: [], configValid: false };
      try { const c = loadAgentEngineConfig(); engine = { enabled: c.enabled, shadow: c.shadow, haltOn: [...c.haltOn], requiredAgents: [...c.requiredAgents], disabledAgents: [...c.disabledAgents], configValid: true }; } catch { /* reported as configValid:false */ }
      const required = new Set(engine.requiredAgents);
      const agents = createProductionRegistry({ rules: loadAgentRulesConfig({}) }).snapshot().map((c) => ({
        agentId: c.agentId, name: c.agentName, version: c.version, weight: c.weight, canBlock: c.canBlock, advisoryOnly: c.advisoryOnly, timeoutMs: c.timeoutMs,
        required: required.has(c.agentId), disabled: engine.disabledAgents.includes(c.agentId), dependsOn: [...c.dependsOn], inputs: [...c.requiredInputs],
      }));
      const O = schema.agentOrchestratorRuns, S = schema.agentOrchestratorSyntheses;
      const rows = await deps.db.select({ id: O.id, riskDecisionId: O.riskDecisionId, decisionVersion: O.decisionVersion, status: O.status, startedAt: O.startedAt, durationMs: O.durationMs, assessment: S.assessment, score: S.score }).from(O).innerJoin(S, eq(S.orchestratorRunId, O.id)).orderBy(desc(O.createdAt)).limit(limit);
      const counts = rows.length ? (await deps.db.execute(sql`select orchestrator_run_id as run, status, verdict, count(*)::int as n from agent_runs where orchestrator_run_id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}) group by 1, 2, 3`)).rows as Array<{ run: string; status: string; verdict: string; n: number }> : [];
      const total = Number(((await deps.db.execute(sql`select count(*)::int as n from agent_orchestrator_runs`)).rows[0] as { n: number }).n);
      return {
        engine, shadowResultsStored: false, agents,
        persistedRuns: total,
        recentRuns: rows.map((r) => ({ runId: r.id, riskDecisionId: r.riskDecisionId, decisionVersion: r.decisionVersion, status: r.status, assessment: r.assessment, score: r.score === null ? null : Number(r.score), startedAt: r.startedAt.toISOString(), durationMs: r.durationMs, agents: counts.filter((c) => c.run === r.id).map((c) => ({ status: c.status, verdict: c.verdict, count: c.n })) })),
      };
    } catch (error) { return failRoute(request, reply, error); }
  });
}
