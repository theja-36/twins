import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { buildDecisionCard, createProductionRegistry, loadAgentEngineConfig, loadAgentRulesConfig, type CardSizing } from "@twins/agents";
import { clampLimit, failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * Agent status API: INTERNAL, bearer-protected, READ-ONLY. Shows which research agents exist (contract metadata only), how the engine is configured as this process sees it, and the
 * recent PERSISTED orchestrator runs. Shadow-mode evaluations are logged, not stored (HB-25), so they do not appear in `recentRuns`. No inputs, outputs or message text are returned.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerAgentsRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer }): void {
  const guard = guardWith(deps.authorized);

  /** Explainable decision card (P0 #6): a READ-ONLY view assembled from the stored synthesis and the stored decision. Nothing is computed, written, sent or approved. */
  app.get<{ Params: { id: string } }>("/risk/decisions/:id/decision-card", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: "invalid_input" });
    try {
      const O = schema.agentOrchestratorRuns, S = schema.agentOrchestratorSyntheses;
      const [row] = await deps.db.select({ runId: O.id, version: O.decisionVersion, result: S.result }).from(O).innerJoin(S, eq(S.orchestratorRunId, O.id)).where(eq(O.riskDecisionId, request.params.id)).orderBy(desc(O.createdAt), desc(O.id)).limit(1);
      if (!row) return reply.code(404).send({ error: "no_assessment" }); // no stored assessment: say so, never invent one
      const R = schema.riskDecisions;
      const [d] = await deps.db.select({ status: R.status, reason: R.decisionReasonCode, qty: R.plannedQuantity, lossPct: R.plannedMaxLossPercent, rr: R.plannedRiskRewardRatio, trust: R.sourceTrustTier }).from(R).where(eq(R.id, request.params.id)).limit(1);
      const n = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
      const sizing: CardSizing | null = d && n(d.qty) !== null ? { status: d.status ?? "UNKNOWN", reasonCode: d.reason ?? null, quantity: n(d.qty) as number, maxLossPercent: n(d.lossPct), riskReward: n(d.rr), trustTier: d.trust ?? null } : null;
      const card = buildDecisionCard({ riskDecisionId: request.params.id, decisionVersion: row.version, runId: row.runId, synthesis: row.result, sizing });
      return card ?? reply.code(422).send({ error: "assessment_unreadable" });
    } catch (error) { return failRoute(request, reply, error); }
  });
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
