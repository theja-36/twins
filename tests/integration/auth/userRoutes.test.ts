/**
 * Stage 01 completion against REAL PostgreSQL: the session-protected routes with the real stores and real row-level security, for several real users.
 * Sessions are real rows (user_sessions); the approval path uses the fixture evaluation dependencies of the trading pipeline (fixed clock, fixture prices), so nothing here touches a provider.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { AuthService, hashSessionToken, newSessionToken, sqlAuditSink, sqlAuthStore } from "../../../packages/auth/src/index";
import { approveDecision, rejectDecision } from "../../../packages/decision/src/index";
import { ingestOutcomes } from "../../../packages/outcomes/src/index";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerUserRoutes } from "../../../apps/api/src/userApi";
import { buildUserOps } from "../../../apps/api/src/userOps";
import { closeClients, db, evalDeps, NOW, owner, pipeline, trade, type Pipe } from "../support/tradingPipeline";

afterAll(async () => { await closeClients(); });
const store = sqlAuthStore(db);
const auth = new AuthService({ store, audit: sqlAuditSink(db), config: { scrypt: { N: 2 ** 10, r: 8, p: 1 } } });
const clock = { approvalNow: NOW };
const ops = { ...buildUserOps(db),
  approve: (u: string, o: { decisionId: string; idempotencyKey: string; reason?: string }) => approveDecision({ ...evalDeps(), now: () => clock.approvalNow }, { userId: u, ...o }),
  reject: (u: string, o: { decisionId: string; idempotencyKey: string; reason?: string }) => rejectDecision({ ...evalDeps(), now: () => clock.approvalNow }, { userId: u, ...o }) };
const app = Fastify(); registerAuthRoutes(app, { auth }); registerUserRoutes(app, { auth, ops, now: () => NOW });
const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) => app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** A real session for an existing user (the pipeline users have a placeholder password hash, so they cannot log in; the session row is what the API checks). */
async function sessionFor(userId: string, o: { createdAgoMs?: number; ttlMs?: number } = {}): Promise<string> {
  const token = newSessionToken(), created = new Date(Date.now() - (o.createdAgoMs ?? 0));
  await store.createSession({ userId: userId as never, tokenHash: hashSessionToken(token), createdAt: created, expiresAt: new Date(created.getTime() + (o.ttlMs ?? 3600_000)) });
  return token;
}
const ids = (r: { json: () => unknown }, key: string): string[] => ((r.json() as Record<string, Array<{ id: string }>>)[key] ?? []).map((x) => x.id);
const stateOf = async (id: string): Promise<string> => ((await (await owner()).query("select workflow_state from user_decisions where id = $1", [id])).rows[0] as { workflow_state: string }).workflow_state;

describe("authentication", () => {
  it("rejects no credential, the service key, an unknown token, an expired session and a revoked session", async () => {
    const p = await pipeline();
    for (const t of [undefined, "test-api-key-default", newSessionToken()]) expect((await call("GET", "/decisions", t)).statusCode).toBe(401);
    const expired = await sessionFor(p.userId, { createdAgoMs: 7200_000, ttlMs: 3600_000 });
    expect((await call("GET", "/decisions", expired)).statusCode).toBe(401);
    const live = await sessionFor(p.userId); expect((await call("GET", "/decisions", live)).statusCode).toBe(200);
    await auth.logout(live); expect((await call("GET", "/decisions", live)).statusCode).toBe(401);
    const tooOld = await sessionFor(p.userId, { createdAgoMs: 8 * 24 * 3600_000, ttlMs: 9 * 24 * 3600_000 }); // idle window still open, absolute maximum passed
    expect((await call("GET", "/decisions", tooOld)).statusCode).toBe(401);
  });
  it("a deactivated user's session is rejected at once", async () => {
    const p = await pipeline(), t = await sessionFor(p.userId); expect((await call("GET", "/decisions", t)).statusCode).toBe(200);
    const o = await owner(); await o.query("begin"); await o.query("select set_config('twins.privilege_door', 'open', true)"); await o.query("update users set is_active = false where id = $1", [p.userId]); await o.query("commit");
    expect((await call("GET", "/decisions", t)).statusCode).toBe(401);
  });
});

describe("ownership through real row-level security", () => {
  let a: Pipe, b: Pipe, ta: string, tb: string;
  it("each user lists only their own decisions; the other user's decision is NOT_FOUND", async () => {
    a = await pipeline(); b = await pipeline(); ta = await sessionFor(a.userId); tb = await sessionFor(b.userId);
    expect(ids(await call("GET", "/decisions?limit=200", ta), "decisions")).toContain(a.decisionId);
    expect(ids(await call("GET", "/decisions?limit=200", ta), "decisions")).not.toContain(b.decisionId);
    expect(ids(await call("GET", "/decisions?limit=200", tb), "decisions")).toContain(b.decisionId);
    expect((await call("GET", `/decisions/${b.decisionId}`, ta)).statusCode).toBe(404);
    expect((await call("GET", `/decisions/${a.decisionId}`, ta)).statusCode).toBe(200);
  });
  it("capital and risk are readable only for an account the session user owns", async () => {
    expect((await call("GET", `/capital/profile?accountId=${a.accountId}`, ta)).json()).toMatchObject({ isolation: "PER_USER_ACCOUNT", effective: { totalCapital: expect.any(String) } });
    expect((await call("GET", `/capital/profile?accountId=${b.accountId}`, ta)).statusCode).toBe(404);
    expect((await call("GET", `/risk/policy?accountId=${b.accountId}`, ta)).statusCode).toBe(404);
    expect(ids(await call("GET", "/accounts", ta), "accounts")).toEqual([a.accountId]);
  });
  it("a request-supplied user id is refused and changes nothing", async () => {
    for (const q of [`userId=${b.userId}`, `owner=${b.userId}`]) expect((await call("GET", `/decisions?${q}`, ta)).statusCode).toBe(422);
    expect((await call("POST", `/decisions/${a.decisionId}/approve`, ta, { idempotencyKey: "spoof-key-1234", userId: b.userId })).statusCode).toBe(422);
    expect(await stateOf(a.decisionId)).toBe("PENDING");
  });
  it("user A cannot approve, reject or cancel user B's decision; B's decision is untouched", async () => {
    expect((await call("POST", `/decisions/${b.decisionId}/approve`, ta, { idempotencyKey: "cross-key-1234" })).statusCode).toBe(404);
    expect((await call("POST", `/decisions/${b.decisionId}/reject`, ta, { idempotencyKey: "cross-key-5678" })).statusCode).toBe(404);
    expect((await call("POST", `/decisions/${b.decisionId}/cancel`, ta, { reason: "not yours to cancel" })).statusCode).toBe(404);
    expect(await stateOf(b.decisionId)).toBe("PENDING");
  });
  it("orders, positions and fills are owner-scoped", async () => {
    const c = await pipeline(), d = await pipeline(); await trade(c, "open"); await trade(d, "open");
    const tc = await sessionFor(c.userId), td = await sessionFor(d.userId);
    const oc = (await call("GET", "/execution/orders", tc)).json() as { orders: Array<{ id: string; decisionId: string }> }, od = (await call("GET", "/execution/orders", td)).json() as { orders: Array<{ id: string; decisionId: string }> };
    expect(oc.orders.length).toBeGreaterThan(0); expect(oc.orders.every((o) => o.decisionId === c.decisionId)).toBe(true); expect(od.orders.every((o) => o.decisionId === d.decisionId)).toBe(true);
    expect((await call("GET", `/execution/orders/${od.orders[0]!.id}/fills`, tc)).json()).toMatchObject({ fills: [] }); // another user's order id yields nothing
    const pc = (await call("GET", "/execution/positions", tc)).json() as { positions: Array<{ id: string; decisionId: string }> };
    expect(pc.positions.every((p) => p.decisionId === c.decisionId)).toBe(true);
    const pd = (await call("GET", "/execution/positions", td)).json() as { positions: Array<{ id: string }> };
    expect((await call("GET", `/execution/positions/${pd.positions[0]!.id}/events`, tc)).json()).toMatchObject({ events: [] });
  });
});

describe("approval API (G-26) on PostgreSQL", () => {
  it("approves once; a replay with the same key and a second action are refused; the approval record is append-only and single", async () => {
    const p = await pipeline(), t = await sessionFor(p.userId);
    const pend = ids(await call("GET", "/approvals", t), "pending"); expect(pend).toContain(p.decisionId);
    const ok = await call("POST", `/decisions/${p.decisionId}/approve`, t, { idempotencyKey: "approve-key-0001", reason: "reviewed" });
    expect(ok.statusCode, ok.body).toBe(200); expect(await stateOf(p.decisionId)).toBe("APPROVED");
    const replay = await call("POST", `/decisions/${p.decisionId}/approve`, t, { idempotencyKey: "approve-key-0001" });
    expect(replay.statusCode).toBe(409); expect(replay.json()).toMatchObject({ error: "ALREADY_ACTIONED" });
    expect((await call("POST", `/decisions/${p.decisionId}/reject`, t, { idempotencyKey: "reject-key-0002" })).statusCode).toBe(409);
    const o = await owner(); expect((await o.query("select count(*)::int as n from decision_approvals where decision_id = $1", [p.decisionId])).rows[0].n).toBe(1);
    await expect(o.query("update decision_approvals set action = 'REJECT' where decision_id = $1", [p.decisionId])).rejects.toThrow(/append-only|not allowed/i);
    expect(ids(await call("GET", "/approvals", t), "pending")).not.toContain(p.decisionId);
  });
  it("an expired decision cannot be approved: it becomes EXPIRED and nothing is executed", async () => {
    const p = await pipeline(), t = await sessionFor(p.userId);
    clock.approvalNow = new Date(NOW.getTime() + 30 * 24 * 3600_000);
    try {
      const r = await call("POST", `/decisions/${p.decisionId}/approve`, t, { idempotencyKey: "approve-key-0003" });
      expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: "EXPIRED", state: "EXPIRED" });
    } finally { clock.approvalNow = NOW; }
    expect(await stateOf(p.decisionId)).toBe("EXPIRED");
    const o = await owner(); expect((await o.query("select count(*)::int as n from decision_approvals where decision_id = $1", [p.decisionId])).rows[0].n).toBe(0);
  });
  it("reject and cancel record their states; a user without the PAPER permission cannot approve", async () => {
    const r = await pipeline(), t = await sessionFor(r.userId);
    expect((await call("POST", `/decisions/${r.decisionId}/reject`, t, { idempotencyKey: "reject-key-0004", reason: "no" })).statusCode).toBe(200); expect(await stateOf(r.decisionId)).toBe("REJECTED");
    const c = await pipeline(), tc = await sessionFor(c.userId);
    const cancelled = await call("POST", `/decisions/${c.decisionId}/cancel`, tc, { reason: "changed my mind" }); expect(cancelled.statusCode).toBe(200); expect(await stateOf(c.decisionId)).toBe("CANCELLED");
    const n = await pipeline(), tn = await sessionFor(n.userId); const o = await owner();
    await o.query("update user_execution_permissions set enabled = false where user_id = $1", [n.userId]);
    const denied = await call("POST", `/decisions/${n.decisionId}/approve`, tn, { idempotencyKey: "approve-key-0005" });
    expect([403, 409]).toContain(denied.statusCode); expect(await stateOf(n.decisionId)).not.toBe("APPROVED");
  });
});

describe("analytics API on PostgreSQL", () => {
  it("returns the owner's analytics only; another user sees an EMPTY state, never the owner's outcomes", async () => {
    const p = await pipeline(); await trade(p, "close"); await ingestOutcomes(db, p.userId, 50);
    const other = await pipeline(), tp = await sessionFor(p.userId), to = await sessionFor(other.userId);
    const mine = (await call("GET", "/analytics/outcomes?limit=200", tp)).json() as { dataset: string; mode: string; liveStatus: string; state: string; data: Array<{ decisionId: string; dataSource: string }> };
    expect(mine).toMatchObject({ dataset: "PAPER", mode: "PAPER", liveStatus: "UNAVAILABLE" }); expect(mine.data.some((r) => r.decisionId === p.decisionId)).toBe(true);
    expect(mine.data.every((r) => r.dataSource === "FIXTURE")).toBe(true);   // fixture prices are labelled, never presented as validated
    const theirs = (await call("GET", "/analytics/outcomes?limit=200", to)).json() as { state: string; data: unknown[] };
    expect(theirs.data).toEqual([]); expect(theirs.state).toBe("EMPTY");
    const ov = (await call("GET", "/analytics/overview", tp)).json() as { state: string; data: { validatedOnly: { eligible: number }; fixtureOnly: { eligible: number } } };
    expect(ov.state).not.toBe("EMPTY"); expect(ov.data.validatedOnly.eligible).toBe(0); expect(ov.data.fixtureOnly.eligible).toBeGreaterThan(0);
    expect(((await call("GET", "/analytics/overview", to)).json() as { state: string }).state).toBe("EMPTY");
    for (const s of ["strategies", "channels", "independent", "agents", "decisions", "drift", "data-quality", "calibration", "insights"]) expect((await call("GET", `/analytics/${s}`, tp)).statusCode, s).toBe(200);
  });
});

describe("role changes through the API", () => {
  it("a TRADER session cannot change roles or create users; an ADMIN session has no access to private data", async () => {
    const p = await pipeline(), t = await sessionFor(p.userId), other = await pipeline();
    expect((await call("POST", `/admin/users/${other.userId}/role`, t, { role: "ADMIN" })).statusCode).toBe(403);
    expect((await call("POST", `/admin/users/${p.userId}/role`, t, { role: "ADMIN" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/users", t, { email: `${randomUUID()}@example.com`, password: "correct horse battery staple", role: "ADMIN" })).statusCode).toBe(403);
    const o = await owner(); expect((await o.query("select role from users where id = any($1::uuid[])", [[p.userId, other.userId]])).rows.map((r: { role: string }) => r.role)).toEqual(["TRADER", "TRADER"]);
    const adminId = randomUUID(); await o.query("begin"); await o.query("select set_config('twins.privilege_door', 'open', true)");
    await o.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'ADMIN', true)", [adminId, `${adminId}@example.com`]); await o.query("commit");
    const ta = await sessionFor(adminId);
    for (const url of ["/decisions", "/approvals", "/execution/orders", "/analytics/overview"]) expect((await call("GET", url, ta)).statusCode, url).toBe(404);
  });
});
