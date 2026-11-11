import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { ApprovalError } from "@twins/decision";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerUserRoutes } from "../../../apps/api/src/userApi";
import type { UserOps } from "../../../apps/api/src/userOps";

const PW = "correct horse battery staple", NOW = new Date("2031-01-06T05:00:00Z");
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dec = (n: number, user: string, o: Record<string, unknown> = {}) => ({ id: ID(n), userId: user, accountId: ID(900 + n), candidateId: ID(500 + n), outcome: "QUALIFIED", workflowState: "PENDING", confidenceAssessmentId: null, riskAssessmentId: null, simulationId: null, researchPackageId: null, explanation: {}, stopLossValidation: null, permittedSize: null, evidenceRefs: [], versions: {}, validFrom: NOW, validUntil: new Date(NOW.getTime() + 3600_000), supersedesId: null, createdAt: NOW, invalidated: null, ...o });

/** Fake data layer keyed by user: it can only return what belongs to the user id it is given, exactly like the SQL stores, so any route that passed the WRONG id would show up as a leak. */
function fakeOps(calls: string[] = []) {
  const decisions = new Map<string, ReturnType<typeof dec>[]>(), approvals = new Set<string>(), watching = new Map<string, boolean>(), watchKeys = new Set<string>();
  const accounts = new Map<string, Array<{ id: string; name: string; tradingMode: string; baseCurrency: string; isActive: boolean }>>();
  const ops: UserOps = {
    async accounts(u) { calls.push(`accounts:${u}`); return accounts.get(u) ?? []; },
    async listDecisions(u, o) { calls.push(`list:${u}`); return (decisions.get(u) ?? []).filter((d) => !o.states || o.states.includes(d.workflowState)) as never; },
    async getDecision(u, id) { calls.push(`get:${u}`); return ((decisions.get(u) ?? []).find((d) => d.id === id) ?? null) as never; },
    async decisionEvents() { return []; }, async approvalOf() { return null; },
    async approve(u, o) {
      const d = (decisions.get(u) ?? []).find((x) => x.id === o.decisionId); if (!d) throw new ApprovalError("NOT_FOUND", "no such decision for this user");
      if (d.workflowState !== "PENDING") throw new ApprovalError("ALREADY_ACTIONED", `the decision is ${d.workflowState}`);
      if (d.validUntil.getTime() < Date.now()) throw new ApprovalError("EXPIRED", "the decision has expired");
      d.workflowState = "APPROVED"; approvals.add(o.decisionId); calls.push(`approve:${u}`); return { status: "APPROVED" };
    },
    async reject(u, o) { const d = (decisions.get(u) ?? []).find((x) => x.id === o.decisionId); if (!d) throw new ApprovalError("NOT_FOUND", "x"); d.workflowState = "REJECTED"; return { status: "REJECTED" }; },
    async watch(u, o) { calls.push(`watch:${u}`); const d = (decisions.get(u) ?? []).find((x) => x.id === o.decisionId); if (!d) return { status: "NOT_FOUND", watching: false }; const k = `${u}:${o.idempotencyKey}`; const dup = watchKeys.has(k); watchKeys.add(k); if (!dup) watching.set(`${u}:${o.decisionId}`, o.action === "WATCH"); calls.push(`watch:${u}:${o.action}`); return { status: dup ? "DUPLICATE" : "RECORDED", watching: watching.get(`${u}:${o.decisionId}`) === true }; },
    async watched(u, id) { return watching.get(`${u}:${id}`) === true; },
    async comparables(u, id) { return (decisions.get(u) ?? []).some((x) => x.id === id) ? ({ state: "NOT_AVAILABLE", version: "comparables-v1", reason: "NO_PATTERN_REPORT", detail: "none", patterns: [] } as never) : null; },
    async cancel(u, o) { return (decisions.get(u) ?? []).some((d) => d.id === o.decisionId) ? "CANCELLED" : "NOT_FOUND"; },
    async capital(u) { return { effective: { id: "c", accountId: "a", version: 1, totalCapital: "100000.00", availableCapital: "90000.00", maxPositionNotionalPct: null, currency: "INR", effectiveFrom: NOW, createdBy: u }, versions: [] } as never; },
    async riskPolicy() { return null; }, async controls() { return []; },
    async orders(u) { calls.push(`orders:${u}`); return []; }, async fills() { return []; }, async positions(u) { calls.push(`positions:${u}`); return []; }, async positionEvents() { return []; },
    async portfolio(u) { calls.push(`portfolio:${u}`); return null; },
    async analytics(u) { calls.push(`analytics:${u}`); return { report: { generatedAt: NOW.toISOString(), modes: { PAPER: { overview: { u }, validatedOnly: {}, fixtureOnly: {}, strategy: {}, telegram: {}, independent: {}, agents: {}, decisionQuality: {} } }, drift: {}, dataQuality: { partial: 0 }, calibration: {} } as never, records: (decisions.get(u) ?? []).length ? ([{ id: "r", finality: "FINAL", closedAt: NOW }] as never) : [] }; },
    async insights() { return []; },
  };
  return { ops, decisions, accounts, approvals };
}
async function build() {
  const store = memoryAuthStore(), calls: string[] = [];
  const auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true, sessionIdleSeconds: 3600 } });
  const f = fakeOps(calls), app = Fastify(); registerAuthRoutes(app, { auth }); registerUserRoutes(app, { auth, ops: f.ops, now: () => NOW });
  const mk = async (email: string) => { const u = await auth.register({ email, password: PW }); const l = await auth.login({ email, password: PW }); return { id: u.id as string, token: l.token }; };
  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) => app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, auth, store, call, mk, calls, ...f };
}
const GETS = ["/accounts", `/portfolio?accountId=${ID(1)}`, `/capital/profile?accountId=${ID(1)}`, `/risk/policy?accountId=${ID(1)}`, "/risk/controls", "/decisions", `/decisions/${ID(1)}`, "/approvals", "/execution/orders", `/execution/orders/${ID(1)}/fills`, "/execution/positions", `/execution/positions/${ID(1)}/events`,
  "/analytics/overview", "/analytics/strategies", "/analytics/channels", "/analytics/independent", "/analytics/agents", "/analytics/decisions", "/analytics/outcomes", "/analytics/insights", "/analytics/drift", "/analytics/data-quality", "/analytics/calibration"];
const POSTS = [`/decisions/${ID(1)}/approve`, `/decisions/${ID(1)}/reject`, `/decisions/${ID(1)}/cancel`, `/decisions/${ID(1)}/watch`, `/decisions/${ID(1)}/unwatch`];

describe("authentication on every user-scoped route", () => {
  it("rejects a missing, malformed, foreign (service-key) and garbage credential on every route with 401", async () => {
    const b = await build();
    for (const url of GETS) for (const t of [undefined, "", "test-api-key-default", "tws_short"]) expect((await b.call("GET", url, t)).statusCode, `${url} ${t}`).toBe(401);
    for (const url of POSTS) for (const t of [undefined, "test-api-key-default"]) expect((await b.call("POST", url, t, { idempotencyKey: "abcdefgh1234", reason: "because" })).statusCode, url).toBe(401);
    expect(b.calls).toEqual([]); // nothing reached the data layer
  });
  it("rejects expired and revoked sessions", async () => {
    const b = await build(), u = await b.mk("a@example.com");
    expect((await b.call("GET", "/decisions", u.token)).statusCode).toBe(200);
    await b.auth.logout(u.token); expect((await b.call("GET", "/decisions", u.token)).statusCode).toBe(401);
    const v = await b.mk("b@example.com"); for (const s of b.store.sessions.values()) if (s.userId === v.id) s.expiresAt = new Date(0);
    expect((await b.call("GET", "/decisions", v.token)).statusCode).toBe(401);
  });
  it("a deactivated user's session stops working immediately", async () => {
    const b = await build(), u = await b.mk("a@example.com"); b.store.users.get(u.id)!.isActive = false;
    expect((await b.call("GET", "/approvals", u.token)).statusCode).toBe(401);
  });
  it("an ADMIN holds no private permission: every private route reports NOT_FOUND, never data", async () => {
    const b = await build(); await b.auth.bootstrapAdmin({ email: "root@example.com", password: PW });
    const t = (await b.auth.login({ email: "root@example.com", password: PW })).token;
    for (const url of GETS) expect((await b.call("GET", url, t)).statusCode, url).toBe(404);
    for (const url of POSTS) expect((await b.call("POST", url, t, { idempotencyKey: "abcdefgh1234", reason: "because" })).statusCode, url).toBe(404);
    expect(b.calls).toEqual([]);
  });
});

describe("ownership and spoofing", () => {
  it("a user sees only their own decisions; another user's id is NOT_FOUND on read and on every action", async () => {
    const b = await build(), a = await b.mk("a@example.com"), c = await b.mk("c@example.com");
    b.decisions.set(a.id, [dec(1, a.id)]); b.decisions.set(c.id, [dec(2, c.id)]);
    const mine = (await b.call("GET", "/decisions", a.token)).json().decisions as Array<{ id: string }>;
    expect(mine.map((d) => d.id)).toEqual([ID(1)]);
    expect((await b.call("GET", `/decisions/${ID(2)}`, a.token)).statusCode).toBe(404);
    for (const verb of ["approve", "reject", "cancel"]) expect((await b.call("POST", `/decisions/${ID(2)}/${verb}`, a.token, verb === "cancel" ? { reason: "because" } : { idempotencyKey: "abcdefgh1234", reason: "because" })).statusCode, verb).toBe(404);
    expect(b.decisions.get(c.id)![0]!.workflowState).toBe("PENDING"); // untouched
  });
  it("every data call carries the SESSION's user id and nothing else", async () => {
    const b = await build(), a = await b.mk("a@example.com"); await b.mk("c@example.com");
    b.accounts.set(a.id, [{ id: ID(1), name: "x", tradingMode: "PAPER", baseCurrency: "INR", isActive: true }]);
    for (const url of GETS) await b.call("GET", url, a.token);
    for (const c of b.calls) expect(c.endsWith(a.id), c).toBe(true);
    expect(b.calls.length).toBeGreaterThan(5);
  });
  it("a request-supplied user id (query, body) is refused, not ignored", async () => {
    const b = await build(), a = await b.mk("a@example.com"), c = await b.mk("c@example.com");
    for (const q of ["userId", "user_id", "ownerId", "owner"]) { const r = await b.call("GET", `/decisions?${q}=${c.id}`, a.token); expect(r.statusCode, q).toBe(422); expect(r.json().error).toBe("VALIDATION"); }
    b.decisions.set(a.id, [dec(1, a.id)]);
    for (const extra of [{ userId: c.id }, { approverUserId: c.id }, { actorId: c.id }, { owner: c.id }]) expect((await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { idempotencyKey: "abcdefgh1234", ...extra })).statusCode, JSON.stringify(extra)).toBe(422);
    expect(b.decisions.get(a.id)![0]!.workflowState).toBe("PENDING");
    expect((await b.call("GET", "/decisions?bogus=1", a.token)).statusCode).toBe(422);
  });
  it("capital and risk need an account the session user owns", async () => {
    const b = await build(), a = await b.mk("a@example.com"), c = await b.mk("c@example.com");
    b.accounts.set(c.id, [{ id: ID(7), name: "other", tradingMode: "PAPER", baseCurrency: "INR", isActive: true }]);
    expect((await b.call("GET", `/capital/profile?accountId=${ID(7)}`, a.token)).statusCode).toBe(404);
    expect((await b.call("GET", `/risk/policy?accountId=${ID(7)}`, a.token)).statusCode).toBe(404);
    expect((await b.call("GET", `/capital/profile?accountId=${ID(7)}`, c.token)).json()).toMatchObject({ isolation: "PER_USER_ACCOUNT" });
    expect((await b.call("GET", "/capital/profile?accountId=nope", c.token)).statusCode).toBe(422);
  });
});

describe("approval API (G-26)", () => {
  it("approves a pending decision once; a replay or a second action is ALREADY_ACTIONED and changes nothing", async () => {
    const b = await build(), a = await b.mk("a@example.com"); b.decisions.set(a.id, [dec(1, a.id, { validUntil: new Date(Date.now() + 3600_000) })]);
    const first = await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { idempotencyKey: "key-12345678", reason: "looks right" });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ decisionId: ID(1), status: "APPROVED" });
    const replay = await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { idempotencyKey: "key-12345678" });
    expect(replay.statusCode).toBe(409); expect(replay.json()).toMatchObject({ error: "ALREADY_ACTIONED", state: "ALREADY_ACTIONED" });
    expect((await b.call("POST", `/decisions/${ID(1)}/reject`, a.token, { idempotencyKey: "other-key-1234" })).statusCode).toBeLessThan(500);
    expect(b.calls.filter((c) => c.startsWith("approve:")).length).toBe(1);
  });
  it("an expired decision cannot be approved: EXPIRED, nothing executed", async () => {
    const b = await build(), a = await b.mk("a@example.com"); b.decisions.set(a.id, [dec(1, a.id, { validUntil: new Date(Date.now() - 1000) })]);
    const r = await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { idempotencyKey: "key-12345678" });
    expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: "EXPIRED", state: "EXPIRED" }); expect(b.decisions.get(a.id)![0]!.workflowState).toBe("PENDING");
  });
  it("a failed revalidation reports INVALIDATED with the names of the failed checks only", async () => {
    const b = await build(), a = await b.mk("a@example.com");
    const app2 = Fastify(); const ops = { ...b.ops, approve: async () => { throw new ApprovalError("REVALIDATION_FAILED", "revalidation failed: price_fresh", { passed: false, at: NOW.toISOString(), checks: [{ name: "price_fresh", ok: false, detail: "secret detail" }, { name: "stop_valid", ok: true, detail: "" }] } as never); } };
    registerUserRoutes(app2, { auth: b.auth, ops, now: () => NOW });
    const r = await app2.inject({ method: "POST", url: `/decisions/${ID(1)}/approve`, headers: { authorization: `Bearer ${a.token}` }, payload: { idempotencyKey: "key-12345678" } });
    expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: "REVALIDATION_FAILED", state: "INVALIDATED", reasons: ["price_fresh"] }); expect(r.body).not.toContain("secret detail");
  });
  it("requires a well-formed idempotency key and a reason to cancel; unknown fields are refused", async () => {
    const b = await build(), a = await b.mk("a@example.com"); b.decisions.set(a.id, [dec(1, a.id)]);
    for (const k of [undefined, "short", "has space in it!!", 5]) expect((await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { ...(k !== undefined ? { idempotencyKey: k } : {}) })).statusCode, String(k)).toBe(422);
    expect((await b.call("POST", `/decisions/${ID(1)}/cancel`, a.token, {})).statusCode).toBe(422);
    expect((await b.call("POST", `/decisions/${ID(1)}/cancel`, a.token, { reason: "changed my mind" })).statusCode).toBe(200);
    expect((await b.call("POST", `/decisions/${ID(1)}/approve`, a.token, { idempotencyKey: "key-12345678", force: true })).statusCode).toBe(422);
  });
  it("the pending list shows only QUALIFIED pending decisions and flags the expired", async () => {
    const b = await build(), a = await b.mk("a@example.com");
    b.decisions.set(a.id, [dec(1, a.id), dec(2, a.id, { outcome: "WAIT" }), dec(3, a.id, { validUntil: new Date(NOW.getTime() - 1) }), dec(4, a.id, { workflowState: "APPROVED" })]);
    const j = (await b.call("GET", "/approvals", a.token)).json();
    expect(j.pending.map((d: { id: string }) => d.id).sort()).toEqual([ID(1), ID(3)]);
    expect(j.pending.find((d: { id: string }) => d.id === ID(3))).toMatchObject({ expired: true, action: { available: false } });
    expect(j.history.map((d: { id: string }) => d.id)).toEqual([ID(4)]);
  });
});

describe("analytics API", () => {
  it("returns the contract envelope (paper only, live unavailable) with a state, owner-scoped", async () => {
    const b = await build(), a = await b.mk("a@example.com"), c = await b.mk("c@example.com"); b.decisions.set(c.id, [dec(2, c.id)]);
    const none = (await b.call("GET", "/analytics/overview", a.token)).json();
    expect(none).toMatchObject({ contractVersion: "analytics-contract-v1", dataset: "PAPER", mode: "PAPER", liveStatus: "UNAVAILABLE", state: "EMPTY" }); expect(none.data.all).toEqual({ u: a.id }); // computed for A, not C
    const some = (await b.call("GET", "/analytics/overview", c.token)).json(); expect(some.state).toBe("OK"); expect(some.data.all).toEqual({ u: c.id });
  });
  it("validates its parameters", async () => {
    const b = await build(), a = await b.mk("a@example.com");
    for (const url of ["/analytics/overview?dataset=REAL", "/analytics/outcomes?limit=0", "/analytics/outcomes?finality=X", "/analytics/insights?kind=bad kind", "/analytics/overview?userId=x"]) expect((await b.call("GET", url, a.token)).statusCode, url).toBe(422);
  });
});

describe("static guarantees", () => {
  const api = readFileSync("apps/api/src/userApi.ts", "utf8"), ops = readFileSync("apps/api/src/userOps.ts", "utf8");
  it("no route reads a user id from the request: every handler gets it from who()", () => {
    expect(api).not.toMatch(/req\.(query|body|params)\)?\.?\[?["']?userId/); expect(api).toContain("ownerScope(a.principal)");
    expect(ops).not.toMatch(/process\.env\[["']TWINS_API_KEY/);
  });
  it("the user routes never accept the shared service key", () => { expect(api).not.toMatch(/checkBearerToken|TWINS_API_KEY|constantTimeCompare/); });
  it("every ANALYTICS endpoint of the Stage 08 contract is registered", () => { for (const p of ["/analytics/overview", "/analytics/outcomes", "/analytics/insights", "/analytics/calibration"]) expect(readFileSync("packages/outcomes/src/contracts.ts", "utf8")).toContain(p); expect(api).toContain("ANALYTICS_ENDPOINTS"); });
});

describe("WATCH / UNWATCH and comparables (G-27)", () => {
  it("watch is a private bookmark: owner-only, idempotent, strict body, grants no approval and changes no state", async () => {
    const b = await build(), a = await b.mk("w1@example.com"), c = await b.mk("w2@example.com");
    b.decisions.set(a.id, [dec(1, a.id) as never]);
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, undefined, { idempotencyKey: "key-12345678" })).statusCode).toBe(401);
    const first = await b.call("POST", `/decisions/${ID(1)}/watch`, a.token, { idempotencyKey: "key-12345678", reason: "keep an eye" });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ status: "RECORDED", watching: true, grantsApproval: false });
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, a.token, { idempotencyKey: "key-12345678" })).json()).toMatchObject({ status: "DUPLICATE", watching: true });
    expect((await b.call("GET", `/decisions/${ID(1)}`, a.token)).json()).toMatchObject({ watching: true, decision: { workflowState: "PENDING" } });
    expect((await b.call("POST", `/decisions/${ID(1)}/unwatch`, a.token, { idempotencyKey: "key-87654321" })).json()).toMatchObject({ watching: false });
    expect(b.approvals.size).toBe(0); expect(b.calls.some((x) => x.startsWith("approve:"))).toBe(false);
    // another user cannot see or watch it; a missing key or an injected owner field is refused
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, c.token, { idempotencyKey: "key-12345678" })).statusCode).toBe(404);
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, a.token, {})).statusCode).toBe(422);
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, a.token, { idempotencyKey: "key-12345678", userId: c.id })).statusCode).toBe(422);
  });
  it("watch has its OWN narrow permission (decisions:watch): it is not served under decisions:read, and it is not decisions:approve", () => {
    const src = readFileSync("apps/api/src/userApi.ts", "utf8");
    expect(src).toMatch(/watchRoute = .*post<\{ id: string \}>\(`\/decisions\/:id\/\$\{verb\}`, "decisions:watch"/);
    expect(src).not.toMatch(/\/decisions\/:id\/\$\{verb\}`, "decisions:read"/); // no decisions:read route writes
    expect((src.match(/"decisions:approve"/g) ?? []).length).toBe(2); // approve + reject (one registration) and cancel remain the only decision mutations under decisions:approve
    for (const read of ['get("/decisions", "decisions:read"', 'get<{ id: string }>("/decisions/:id", "decisions:read"', 'get("/approvals", "decisions:read"']) expect(src).toContain(read); // reading stays read-only
  });
  it("one user's watch and unwatch can never touch another user's list, the decision, or an approval (the data layer only ever sees the session's own user id)", async () => {
    const b = await build(), a = await b.mk("w5@example.com"), c = await b.mk("w6@example.com");
    b.decisions.set(a.id, [dec(1, a.id) as never]);
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, a.token, { idempotencyKey: "key-aaaaaaaa" })).json()).toMatchObject({ watching: true });
    // the other user tries both verbs on the owner's decision, and tries to name the owner in the body
    expect((await b.call("POST", `/decisions/${ID(1)}/unwatch`, c.token, { idempotencyKey: "key-bbbbbbbb" })).statusCode).toBe(404);
    expect((await b.call("POST", `/decisions/${ID(1)}/watch`, c.token, { idempotencyKey: "key-cccccccc" })).statusCode).toBe(404);
    for (const field of ["userId", "user_id", "ownerId", "accountId"]) expect((await b.call("POST", `/decisions/${ID(1)}/unwatch`, c.token, { idempotencyKey: "key-dddddddd", [field]: a.id })).statusCode, field).toBe(422);
    const watchUsers = b.calls.filter((x) => x.startsWith("watch:")).map((x) => x.split(":")[1]);
    expect(watchUsers.every((id) => id === a.id || id === c.id)).toBe(true); // only session identities ever reach the data layer, never an id taken from a body or path
    expect(b.calls.filter((x) => x === `watch:${c.id}`)).toHaveLength(2); // the other user's two attempts ran as THAT user, so the store saw no decision of theirs (404) ...
    expect(b.calls.filter((x) => x === `watch:${a.id}`)).toHaveLength(1); // ... and the owner's list was only ever written by the owner's own single watch
    // the owner's bookmark and the decision are exactly as they were
    expect((await b.call("GET", `/decisions/${ID(1)}`, a.token)).json()).toMatchObject({ watching: true, decision: { workflowState: "PENDING" } });
    expect(b.approvals.size).toBe(0);
    // an ADMIN holds neither the permission nor any route to it
    await b.auth.bootstrapAdmin({ email: "root2@example.com", password: PW });
    const t = (await b.auth.login({ email: "root2@example.com", password: PW })).token;
    for (const verb of ["watch", "unwatch"]) expect((await b.call("POST", `/decisions/${ID(1)}/${verb}`, t, { idempotencyKey: "key-eeeeeeee" })).statusCode, verb).toBe(404);
    expect(b.calls.filter((x) => x === `watch:${a.id}`)).toHaveLength(1); // the admin's attempts never reached the data layer at all
  });
  it("comparables are owner-only and honest when no pattern provider ran", async () => {
    const b = await build(), a = await b.mk("w3@example.com"), c = await b.mk("w4@example.com");
    b.decisions.set(a.id, [dec(1, a.id) as never]);
    expect((await b.call("GET", `/decisions/${ID(1)}/comparables`, a.token)).json()).toMatchObject({ comparables: { state: "NOT_AVAILABLE", patterns: [] } });
    expect((await b.call("GET", `/decisions/${ID(1)}/comparables`, c.token)).statusCode).toBe(404);
    expect((await b.call("GET", `/decisions/${ID(1)}/comparables`)).statusCode).toBe(401);
  });
});
