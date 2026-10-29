import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@twins/database";
import {
  assessApprovalEligibility, createApprovalCard, getRiskDecision, listRecentApprovals, listRecentDecisionSummaries, recordRiskApproval, RiskDecisionError, safeEligibility, summarizeDecision, RISK_DECISION_STATUSES,
} from "@twins/risk";

/**
 * Risk decision / approval API (Stage 3 / Task 6). INTERNAL: every route requires the bearer token (the same TWINS_API_KEY authentication as the other protected routes);
 * there is no unauthenticated route. Responses carry safe, structured fields only - never the decision's input snapshot, idempotency keys, the Telegram message text,
 * credentials or the approver's full identity. Recording an approval creates NO order, fill, position or broker call.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RiskDecisionError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : error.code === "not_approval_eligible" ? 409 : error.code === "safety_refused" || error.code === "circuit_breaker_unavailable" ? 503 : 500;
    return reply.code(status).send({ error: error.code }); // a fixed code, never a message that could carry driver text
  }
  return reply.code(500).send({ error: "internal_error" });
}

export function registerRiskRoutes(app: FastifyInstance, deps: { db: Db; authorized: (header: string | undefined) => boolean }): void {
  const { db } = deps;
  const guard = (header: string | undefined, reply: FastifyReply): boolean => {
    if (deps.authorized(header)) return true;
    void reply.code(401).send({ error: "Unauthorized" });
    return false;
  };

  app.get<{ Params: { id: string } }>("/risk/decisions/:id/approval-eligibility", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: "invalid_input" });
    try {
      return safeEligibility(await assessApprovalEligibility(db, request.params.id));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/risk/decisions/:id/summary", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: "invalid_input" });
    try {
      const d = await getRiskDecision(db, request.params.id);
      return d ? summarizeDecision(d) : reply.code(404).send({ error: "not_found" });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string; status?: string } }>("/risk/decisions", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const status = request.query.status;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (status !== undefined && !(RISK_DECISION_STATUSES as readonly string[]).includes(status))) return reply.code(400).send({ error: "invalid_input" });
    try {
      return { decisions: await listRecentDecisionSummaries(db, limit, status as (typeof RISK_DECISION_STATUSES)[number] | undefined) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/risk/approvals", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: "invalid_input" });
    try {
      return { approvals: await listRecentApprovals(db, limit) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Creates the approval card for an approval-eligible decision (409 + reasons otherwise). The card is delivered by the approval bot; nothing is sent from here. */
  app.post<{ Params: { id: string } }>("/risk/decisions/:id/approval-card", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: "invalid_input" });
    try {
      const c = await createApprovalCard(db, request.params.id);
      return reply.code(c.created ? 201 : 200).send({ cardId: c.cardId, created: c.created, decisionId: c.decisionId, decisionVersion: c.decisionVersion, expiresAt: c.expiresAt.toISOString() });
    } catch (error) {
      if (error instanceof RiskDecisionError && error.code === "not_approval_eligible") {
        const a = await assessApprovalEligibility(db, request.params.id).catch(() => null);
        return reply.code(409).send({ error: "not_approval_eligible", reasons: a?.reasons ?? [] });
      }
      return fail(reply, error);
    }
  });

  /** Records an APPROVE or REJECT of the decision version (the database re-checks eligibility at that instant). Body: { action, actor: "operator:<name>", reason? }. */
  app.post<{ Params: { id: string }; Body: { action?: unknown; actor?: unknown; reason?: unknown } }>("/risk/decisions/:id/approval", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    const { action, actor, reason } = request.body ?? {};
    if (!UUID.test(request.params.id) || (action !== "APPROVE" && action !== "REJECT") || typeof actor !== "string" || (reason !== undefined && typeof reason !== "string")) return reply.code(400).send({ error: "invalid_input" });
    try {
      const r = await recordRiskApproval(db, { decisionId: request.params.id, action, actor, ...(reason !== undefined ? { reason } : {}) });
      if (r.outcome === "recorded") return reply.code(201).send({ outcome: "recorded", approvalId: r.approvalId });
      if (r.outcome === "duplicate") return reply.code(409).send({ outcome: "duplicate" });
      return reply.code(409).send({ outcome: "refused", reason: r.reason });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
