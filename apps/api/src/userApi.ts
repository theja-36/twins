import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PlatformError, authorize, isQualifiedOutcome, ownerScope, toErrorBody, type Permission } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { ANALYTICS_ENDPOINTS, envelope, parseListQuery, sectionOf, type AnalyticsSection } from "@twins/outcomes";
import { bearerSessionToken } from "./authApi.js";
import type { UserOps } from "./userOps.js";

/**
 * Session-protected, owner-scoped routes (Stage 01 completion). The single rule for all of them:
 *   identity = the VERIFIED SESSION. No route reads a user id from the query, path or body: a `userId`, `user_id`, `ownerId`, `owner` or `accountOwner` field is REFUSED (422), never ignored.
 *   permission = `authorize(principal, perm, ownerScope(principal))` (the pure ADR-003 model): a role without the permission gets NOT_FOUND for private data, so existence is never leaked.
 *   data = `UserOps`, whose every function takes the session's user id and runs under row-level security.
 * The shared service API key is not a session and is never accepted here. Reads never write; the only writes are the approval actions, which are one-time, expiry-checked, freshly revalidated and append-only (the database door twins_record_decision_approval).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPOOF = ["userId", "user_id", "ownerId", "owner_id", "owner", "accountOwner", "approverUserId", "approver_user_id", "actorId", "actor_id"];
const DECISION_STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"];

function rec(v: unknown): Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
export function refuseSpoof(...sources: unknown[]): void { for (const s of sources) for (const k of Object.keys(rec(s))) if (SPOOF.includes(k)) throw new PlatformError("VALIDATION", "identity comes from the session; this field is not accepted", [`not allowed: ${k}`]); }
export function query(req: FastifyRequest, allowed: readonly string[]): Record<string, string> {
  const q = rec(req.query); refuseSpoof(q);
  for (const k of Object.keys(q)) if (!allowed.includes(k)) throw new PlatformError("VALIDATION", "unknown parameter", [`not allowed: ${k.slice(0, 30)}`]);
  const out: Record<string, string> = {}; for (const [k, v] of Object.entries(q)) { if (typeof v !== "string") throw new PlatformError("VALIDATION", "invalid parameter", [`invalid: ${k}`]); out[k] = v; }
  return out;
}
export function uuid(v: string | undefined, name: string): string { if (!v || !UUID.test(v)) throw new PlatformError("VALIDATION", "invalid id", [`invalid: ${name}`]); return v; }
export function limit(v: string | undefined, def = 50): number { const n = v === undefined ? def : Number(v); if (!Number.isInteger(n) || n < 1 || n > 200) throw new PlatformError("VALIDATION", "limit must be an integer between 1 and 200"); return n; }
export function body(req: FastifyRequest, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const b = req.body === undefined || req.body === null ? {} : rec(req.body);
  if (req.body !== undefined && req.body !== null && (typeof req.body !== "object" || Array.isArray(req.body))) throw new PlatformError("VALIDATION", "a JSON object is required");
  refuseSpoof(b);
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new PlatformError("VALIDATION", "unknown field", [`not allowed: ${k.slice(0, 30)}`]);
  for (const k of required) if (b[k] === undefined) throw new PlatformError("VALIDATION", "missing field", [`required: ${k}`]);
  return b;
}
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
function key(v: unknown): string { if (typeof v !== "string" || !KEY.test(v)) throw new PlatformError("VALIDATION", "idempotencyKey must be 8-128 characters (letters, digits, _ . : -)"); return v; }
function reason(v: unknown, required = false): string | undefined { if (v === undefined) { if (required) throw new PlatformError("VALIDATION", "a reason is required"); return undefined; } if (typeof v !== "string" || v.trim().length < (required ? 5 : 1) || v.length > 300) throw new PlatformError("VALIDATION", "invalid reason"); return v.trim(); }

const APPROVAL_HTTP: Record<string, { status: number; state: string }> = {
  NOT_FOUND: { status: 404, state: "NOT_FOUND" }, NOT_PENDING: { status: 409, state: "NOT_PENDING" }, NOT_QUALIFIED: { status: 422, state: "NOT_QUALIFIED" }, EXPIRED: { status: 409, state: "EXPIRED" },
  REVALIDATION_FAILED: { status: 409, state: "INVALIDATED" }, ALREADY_ACTIONED: { status: 409, state: "ALREADY_ACTIONED" }, NOT_PERMITTED: { status: 403, state: "NOT_PERMITTED" },
};
const decisionView = (d: NonNullable<Awaited<ReturnType<UserOps["getDecision"]>>>) => ({
  id: d.id, accountId: d.accountId, candidateId: d.candidateId, outcome: d.outcome, workflowState: d.workflowState, explanation: d.explanation, stopLossValidation: d.stopLossValidation, permittedSize: d.permittedSize,
  evidenceRefs: d.evidenceRefs, versions: d.versions, validFrom: d.validFrom.toISOString(), validUntil: d.validUntil.toISOString(), supersedesId: d.supersedesId, createdAt: d.createdAt.toISOString(),
  invalidated: d.invalidated ? { reasonCode: d.invalidated.reasonCode, at: d.invalidated.at.toISOString() } : null, simulationId: d.simulationId, riskAssessmentId: d.riskAssessmentId,
});

export function registerUserRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: UserOps; now?: () => Date }): void {
  const { auth, ops } = deps, now = deps.now ?? (() => new Date());
  const send = (reply: FastifyReply, e: unknown): FastifyReply => { const { status, body: b } = toErrorBody(e); return reply.code(status).send(b); };
  /** Verified session -> user id, after the permission check. The ONLY place a route learns who is calling. */
  async function who(req: FastifyRequest, perm: Permission): Promise<string> {
    const a = await auth.authenticate(bearerSessionToken(req.headers.authorization));
    const userId = ownerScope(a.principal);
    authorize(a.principal, perm, userId);
    return userId;
  }
  type Req<P = Record<string, string>> = FastifyRequest<{ Params: P; Querystring: Record<string, string>; Body: unknown }>;
  const get = <P = Record<string, string>>(path: string, perm: Permission, h: (userId: string, req: Req<P>) => Promise<unknown>): void => {
    app.get<{ Params: P; Querystring: Record<string, string> }>(path, async (req, reply) => { try { return await h(await who(req as never, perm), req as unknown as Req<P>); } catch (e) { return send(reply, e); } });
  };
  const post = <P = Record<string, string>>(path: string, perm: Permission, h: (userId: string, req: Req<P>, reply: FastifyReply) => Promise<unknown>): void => {
    app.post<{ Params: P; Body: unknown }>(path, async (req, reply) => { try { return await h(await who(req as never, perm), req as unknown as Req<P>, reply); } catch (e) { return send(reply, e); } });
  };
  const approvalError = (reply: FastifyReply, e: unknown): FastifyReply | null => {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "", m = APPROVAL_HTTP[code];
    if (!m || !(e instanceof Error) || e.name !== "ApprovalError") return null;
    const rv = (e as { revalidation?: { checks?: Array<{ name: string; ok: boolean }> } }).revalidation;
    return reply.code(m.status).send({ error: code, state: m.state, message: e.message.slice(0, 200), reasons: (rv?.checks ?? []).filter((c) => !c.ok).map((c) => c.name) });
  };

  // ── accounts, capital, risk ───────────────────────────────────────────────
  get("/accounts", "capital:read", async (u, req) => { query(req, []); return { accounts: await ops.accounts(u) }; });
  get("/capital/profile", "capital:read", async (u, req) => {
    const q = query(req, ["accountId"]), accountId = uuid(q["accountId"], "accountId");
    if (!(await ops.accounts(u)).some((a) => a.id === accountId)) throw new PlatformError("NOT_FOUND", "not found");
    const c = await ops.capital(u, accountId, now());
    return { accountId, isolation: "PER_USER_ACCOUNT", effective: c.effective, versions: c.versions };
  });
  get("/risk/policy", "risk:read", async (u, req) => {
    const q = query(req, ["accountId"]), accountId = uuid(q["accountId"], "accountId");
    if (!(await ops.accounts(u)).some((a) => a.id === accountId)) throw new PlatformError("NOT_FOUND", "not found");
    return { accountId, policy: await ops.riskPolicy(u, accountId, now()) };
  });
  get("/portfolio", "positions:read", async (u, req) => {
    const q = query(req, ["accountId"]), accountId = uuid(q["accountId"], "accountId");
    if (!(await ops.accounts(u)).some((a) => a.id === accountId)) throw new PlatformError("NOT_FOUND", "not found");
    const facts = await ops.portfolio(u, accountId);
    return { accountId, mode: "PAPER", isolation: "PER_USER_ACCOUNT", facts, notes: ["Allocated notional is paper notional at entry price; margin is not modelled and no live portfolio source is connected, so no live balance is shown."] };
  });
  get("/risk/controls", "risk:read", async (u, req) => { query(req, []); return { controls: await ops.controls(u, now()) }; });

  // ── decisions ─────────────────────────────────────────────────────────────
  get("/decisions", "decisions:read", async (u, req) => {
    const q = query(req, ["state", "accountId", "limit"]);
    if (q["state"] !== undefined && !DECISION_STATES.includes(q["state"])) throw new PlatformError("VALIDATION", "unknown state");
    const rows = await ops.listDecisions(u, { ...(q["state"] ? { states: [q["state"]] } : {}), ...(q["accountId"] ? { accountId: uuid(q["accountId"], "accountId") } : {}), limit: limit(q["limit"]) });
    return { decisions: rows.map(decisionView) };
  });
  get<{ id: string }>("/decisions/:id", "decisions:read", async (u, req) => {
    query(req, []); const id = uuid(req.params.id, "id"), d = await ops.getDecision(u, id);
    if (!d) throw new PlatformError("NOT_FOUND", "not found");
    const approval = await ops.approvalOf(u, id);
    return { decision: decisionView(d), events: (await ops.decisionEvents(u, id)).map((e) => ({ ...e, at: e.at.toISOString() })), approval: approval ? { action: approval.action, at: approval.createdAt.toISOString() } : null };
  });
  get("/approvals", "decisions:read", async (u, req) => {
    query(req, []); const t = now().getTime(), pendingAll = await ops.listDecisions(u, { states: ["PENDING"], limit: 100 });
    const pending = pendingAll.filter((d) => isQualifiedOutcome(d.outcome)).map((d) => ({ ...decisionView(d), expired: d.validUntil.getTime() <= t, action: { available: d.validUntil.getTime() > t } }));
    const history = (await ops.listDecisions(u, { states: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "SUPERSEDED"], limit: 50 })).map(decisionView);
    return { pending, history };
  });
  const act = (verb: "approve" | "reject") => post<{ id: string }>(`/decisions/:id/${verb}`, "decisions:approve", async (u, req, reply) => {
    const b = body(req as never, ["idempotencyKey", "reason"], ["idempotencyKey"]), id = uuid(req.params.id, "id"), r = reason(b["reason"]);
    try {
      const o = { decisionId: id, idempotencyKey: key(b["idempotencyKey"]), ...(r ? { reason: r } : {}) };
      const out = verb === "approve" ? await ops.approve(u, o) : await ops.reject(u, o);
      return reply.code(200).send({ decisionId: id, ...(rec(out)["status"] ? { status: rec(out)["status"] } : {}) });
    } catch (e) { const handled = approvalError(reply, e); if (handled) return handled; throw e; }
  });
  act("approve"); act("reject");
  post<{ id: string }>("/decisions/:id/cancel", "decisions:approve", async (u, req, reply) => {
    const b = body(req as never, ["reason"], ["reason"]), id = uuid(req.params.id, "id"), result = await ops.cancel(u, { decisionId: id, reason: reason(b["reason"], true) as string });
    if (result === "NOT_FOUND") throw new PlatformError("NOT_FOUND", "not found");
    return reply.code(200).send({ decisionId: id, result });
  });

  // ── paper orders, fills, positions ────────────────────────────────────────
  get("/execution/orders", "orders:read", async (u, req) => {
    const q = query(req, ["decisionId", "status", "limit"]);
    return { orders: await ops.orders(u, { ...(q["decisionId"] ? { decisionId: uuid(q["decisionId"], "decisionId") } : {}), ...(q["status"] ? { statuses: [q["status"]] } : {}), limit: limit(q["limit"]) }) };
  });
  get<{ id: string }>("/execution/orders/:id/fills", "orders:read", async (u, req) => { query(req, []); return { fills: await ops.fills(u, uuid(req.params.id, "id")) }; });
  get("/execution/positions", "positions:read", async (u, req) => {
    const q = query(req, ["status", "limit"]);
    if (q["status"] !== undefined && q["status"] !== "OPEN" && q["status"] !== "CLOSED") throw new PlatformError("VALIDATION", "status must be OPEN or CLOSED");
    return { positions: await ops.positions(u, { ...(q["status"] ? { status: q["status"] as "OPEN" | "CLOSED" } : {}), limit: limit(q["limit"]) }) };
  });
  get<{ id: string }>("/execution/positions/:id/events", "positions:read", async (u, req) => { query(req, []); return { events: await ops.positionEvents(u, uuid(req.params.id, "id")) }; });

  // ── analytics (Stage 08 contracts; analytics:read; owner-scoped; paper only) ─
  const emptyState = (records: number, partial: number): "EMPTY" | "PARTIAL" | "OK" => (records === 0 ? "EMPTY" : partial > 0 ? "PARTIAL" : "OK");
  for (const ep of ANALYTICS_ENDPOINTS) {
    if (ep.section === "outcomes" || ep.section === "insights") continue;
    get(ep.path, "analytics:read", async (u, req) => {
      const q = query(req, ["accountId", "dataset", "dimension"]);
      if (q["dataset"] !== undefined && !["ALL", "VALIDATED", "FIXTURE"].includes(q["dataset"])) throw new PlatformError("VALIDATION", "dataset must be ALL, VALIDATED or FIXTURE");
      const { report, records } = await ops.analytics(u, now()), env = sectionOf(report, ep.section as Exclude<AnalyticsSection, "outcomes" | "insights">);
      return { ...env, state: emptyState(records.length, report.dataQuality.partial) };
    });
  }
  get("/analytics/outcomes", "analytics:read", async (u, req) => {
    const q = query(req, ["finality", "limit", "cursor"]), p = parseListQuery(q);
    if (!p.ok) throw new PlatformError("VALIDATION", p.error);
    const { report, records } = await ops.analytics(u, now());
    const rows = records.filter((r) => !p.finality || r.finality === p.finality).slice(0, p.limit).map((r) => ({ id: r.id, paperPositionId: r.paperPositionId, decisionId: r.decisionId, version: r.version, finality: r.finality, mode: r.mode, dataSource: r.dataSource, candidateSource: r.candidateSource, setup: r.setup, instrument: r.instrument, side: r.side, grossPnl: r.grossPnl, costs: r.costs, netPnl: r.netPnl, rMultiple: r.rMultiple, holdingSeconds: r.holdingSeconds, exitReason: r.exitReason, closedAt: r.closedAt ? r.closedAt.toISOString() : null, dataQuality: r.dataQuality, missing: r.missing, correctionReason: r.correctionReason }));
    return { ...envelope(report, rows), state: emptyState(records.length, report.dataQuality.partial) };
  });
  get("/analytics/insights", "analytics:read", async (u, req) => {
    const q = query(req, ["kind", "limit"]), p = parseListQuery(q);
    if (!p.ok) throw new PlatformError("VALIDATION", p.error);
    const { report } = await ops.analytics(u, now()), rows = await ops.insights(u, { ...(p.kind ? { kind: p.kind } : {}), limit: p.limit });
    return { ...envelope(report, rows), state: rows.length === 0 ? "EMPTY" : "OK" };
  });
}
