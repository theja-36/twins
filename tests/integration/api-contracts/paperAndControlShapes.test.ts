/**
 * Stage 09.4 / Step 1 against REAL PostgreSQL and the REAL engines. Real-output parity for the routes the Control screens will read: orders, fills, positions, position events, portfolio, capital profile, risk policy and risk controls.
 * Orders, fills, positions and events come from the real decision cycle and the real paper execution and position monitor (tests/integration/support/tradingPipeline.ts: entry fill, target exit, trailing stop, stop exit). Capital and policy rows are written
 * by the real store writers and risk controls by the real `setRiskControl`; every response is served by the real session routes. Nothing here changes production code. Synthetic data only.
 *
 * What this file proves (and what it deliberately does NOT prove) is listed in the final describe block, "unverified and limits". The key lists below are the CONTRACT these screens may rely on: they are declared here, from the real output, not imported from production code.
 *
 * (Risk controls: since migration 0047 the control read also filters by owner explicitly; see the last test in section G.)
 * Findings that later screens must respect (each is asserted below):
 *  - `/execution/orders` and `/execution/positions` take only `limit` (1 to 200): no account filter, no offset, no total or "has more" field. A limited response cannot be shown as a complete history.
 *  - Positions return `userId` and a large free-form `rules` object; events return a free-form `payload`. They exist in the real output and must never be forwarded to the browser; the frontend allow-lists below exclude them.
 *  - A foreign fill or event id answers 200 with an empty list (never 404, never data), so "empty" cannot prove an id is unknown.
 *  - `/portfolio` facts come from a database view that uses the DATABASE clock: a capital profile effective in the future gives capital fields `null` (unavailable), not zero. An account with no positions reports `"0"` for allocated notional and realised P&L (the backend's own empty sum).
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { AuthService, hashSessionToken, newSessionToken, sqlAuditSink, sqlAuthStore } from "../../../packages/auth/src/index";
import { ingestOutcomes } from "../../../packages/outcomes/src/index";
import { appendCapitalProfile, appendRiskPolicy, clearRiskControl, createDb, listActiveControls, setRiskControl } from "../../../packages/database/src/index";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerUserRoutes } from "../../../apps/api/src/userApi";
import { buildUserOps } from "../../../apps/api/src/userOps";
import * as C from "../../../packages/api-contracts/src/index";
import { closeClients, db, NOW, newUser, owner, ownerShared, pipeline, session, trade, URL_, type Pipe } from "../support/tradingPipeline";

/**
 * The routes are served over a connection that uses the repository's own RLS test role (`twins_rls_test`: no superuser, no bypass), the closest the test database gets to the production runtime role. The CI database user is a SUPERUSER, which bypasses row-level
 * security even when it is forced; the trading pipeline (setup only) uses that superuser connection exactly as every other integration test does.
 */
const rlsPool = new pg.Pool({ connectionString: URL_, options: "-c role=twins_rls_test" });
const dbRls = createDb(rlsPool);
const A_CONTROLS: Array<{ kind: "RESTRICTION" | "KILL_SWITCH" }> = [{ kind: "RESTRICTION" }, { kind: "KILL_SWITCH" }];
let controlsSetFor: string | null = null;
afterAll(async () => {
  // Controls are append-only and, on the superuser test connection, would apply to every later integration file: clear them (the real owner-clear path) before leaving.
  if (controlsSetFor) for (const c of A_CONTROLS) await clearRiskControl(db, { scope: "USER", scopeKey: null, kind: c.kind, userId: controlsSetFor }, { reason: "test cleanup after contract parity", actor: "owner@example.test", actorKind: "OWNER" }).catch(() => undefined);
  await rlsPool.end().catch(() => undefined); await closeClients();
});
const store = sqlAuthStore(db), auth = new AuthService({ store, audit: sqlAuditSink(db), config: { scrypt: { N: 2 ** 10, r: 8, p: 1 } } });
const app = Fastify(); registerAuthRoutes(app, { auth }); registerUserRoutes(app, { auth, ops: buildUserOps(dbRls), now: () => NOW });
const tokenFor = async (userId: string): Promise<string> => { const t = newSessionToken(); await store.createSession({ userId: userId as never, tokenHash: hashSessionToken(t), createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }); return t; };
const get = async (url: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> => { const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }); return { status: r.statusCode, body: r.json() as Record<string, unknown> }; };
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
const sorted = (a: readonly string[]): string[] => [...a].sort();
const DECIMAL = /^-?\d+(\.\d+)?$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isDecimalString = (v: unknown): boolean => typeof v === "string" && DECIMAL.test(v);
const isIso = (v: unknown): boolean => typeof v === "string" && ISO.test(v);
const rows = (b: Record<string, unknown>, k: string): Array<Record<string, unknown>> => b[k] as Array<Record<string, unknown>>;

/** The REAL keys of each row, as observed. Declared here so a change in the backend output fails this test. */
const ORDER_KEYS = ["id", "decisionId", "accountId", "positionId", "purpose", "exitReason", "instrument", "exchange", "side", "orderType", "quantity", "limitPrice", "filledQuantity", "avgFillPrice", "status", "stateReason", "createdAt"];
const FILL_KEYS = ["id", "quantity", "price", "costs", "priceSource", "filledAt"];
const POSITION_KEYS = ["id", "userId", "accountId", "decisionId", "instrument", "exchange", "side", "quantity", "initialQuantity", "avgEntryPrice", "initialStop", "stopLoss", "targets", "rules", "realizedPnl", "realizedCosts", "status", "exitReason", "openedAt", "closedAt"];
const EVENT_KEYS = ["kind", "payload", "at"];
const PORTFOLIO_KEYS = ["accountId", "mode", "isolation", "facts", "notes"];
const FACTS_KEYS = ["accountId", "openPositions", "allocatedNotional", "realizedPnl", "totalCapital", "availableCapital", "unallocatedCapital", "capitalProfileVersion"];
const CAPITAL_KEYS = ["accountId", "isolation", "effective", "versions"];
const CAPITAL_ROW_KEYS = ["id", "accountId", "version", "totalCapital", "availableCapital", "maxPositionNotionalPct", "currency", "effectiveFrom", "createdBy"];
const POLICY_KEYS = ["accountId", "policy"];
const POLICY_ROW_KEYS = ["id", "accountId", "version", "riskPercent", "maxRiskPerTrade", "maxDailyLoss", "maxConcurrentPositions", "maxLots", "minRewardToRisk", "allowedUnderlyings", "maxDrawdownPct", "maxPortfolioExposurePct", "maxCorrelatedRiskPct", "effectiveFrom", "createdBy"];
const CONTROL_KEYS = ["id", "userId", "scope", "scopeKey", "kind", "reason", "setAt", "expiresAt"];
/** What a browser may receive. Everything the real output has that is NOT listed here (userId, rules, payload) must be stripped by the relay schema. */
const FRONTEND_POSITION_KEYS = POSITION_KEYS.filter((k) => !["userId", "rules"].includes(k));
const FRONTEND_EVENT_KEYS = EVENT_KEYS.filter((k) => k !== "payload");
const project = (o: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => allowed.includes(k)));

let A: { p: Pipe; token: string; orders: Array<Record<string, unknown>>; positions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };
let D: { p: Pipe; token: string };
let X: { userId: string; accountId: string; token: string }, ADMIN_TOKEN: string;
const setup = (async () => {
  await session(randomUUID()); // creates the restricted role and its grants (idempotent) BEFORE the first route call: the routes use that role
  // A: a CLOSED trade (entry, target exit, stop exit) with real fills and events; the fixture capital/policy are effective in 2030.
  const a = await pipeline(); await trade(a, "close"); await ingestOutcomes(db, a.userId, 50);
  const token = await tokenFor(a.userId); const orders = rows((await get("/execution/orders", token)).body, "orders"), positions = rows((await get("/execution/positions", token)).body, "positions");
  const events = rows((await get(`/execution/positions/${positions[0]!.id as string}/events`, token)).body, "events");
  A = { p: a, token, orders, positions, events };
  // D: an OPEN position, with capital and policy effective in the PAST of the database clock (so portfolio capital facts are real strings).
  const d = await newUser(), o = await ownerShared();
  await o.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, 'PAPER', true, 'test')", [d.userId, d.accountId]);
  await appendCapitalProfile(db, d.userId, { accountId: d.accountId, totalCapital: "2000000", availableCapital: "1500000.50", maxPositionNotionalPct: "25", effectiveFrom: new Date("2020-01-01T00:00:00Z"), createdBy: "test" });
  await appendRiskPolicy(db, d.userId, { accountId: d.accountId, riskPercent: "1.5", maxRiskPerTrade: "15000", maxDailyLoss: "30000", maxConcurrentPositions: 20, maxLots: 1000, minRewardToRisk: "1.5", allowedUnderlyings: [], maxDrawdownPct: "10", maxPortfolioExposurePct: "60", maxCorrelatedRiskPct: "3", effectiveFrom: new Date("2020-01-01T00:00:00Z"), createdBy: "test" });
  const dp = await pipeline(d); await trade(dp, "open"); D = { p: dp, token: await tokenFor(d.userId) };
  // X: a different trader with an account and nothing else (no capital, no policy, no trades).
  const x = await newUser(); X = { ...x, token: await tokenFor(x.userId) };
  const existing = (await (await owner()).query("select id from users where role = 'ADMIN' and is_active limit 1")).rows[0] as { id: string } | undefined;
  const adminId = existing?.id ?? ((await auth.bootstrapAdmin({ email: `admin-${randomUUID()}@example.test`, password: "correct horse battery staple" })).id as string);
  ADMIN_TOKEN = await tokenFor(adminId);
})();
const ready = async (): Promise<void> => { await setup; };
/** Real user-scoped controls through the real writer, created only after every trade has run (on the superuser test connection a user control would otherwise stop other users' decisions). */
let controlsReady: Promise<void> | null = null;
const withControls = async (): Promise<void> => {
  await ready();
  controlsReady ??= (async () => {
    controlsSetFor = A.p.userId; const far = new Date("2032-01-01T00:00:00Z");
    await setRiskControl(db, { scope: "USER", scopeKey: null, kind: "RESTRICTION", userId: A.p.userId }, { reason: "test restriction for contract parity", actor: "owner@example.test", actorKind: "OWNER", expiresAt: far });
    await setRiskControl(db, { scope: "USER", scopeKey: null, kind: "KILL_SWITCH", userId: A.p.userId }, { reason: "test kill switch for contract parity", actor: "owner@example.test", actorKind: "OWNER" });
  })();
  await controlsReady;
};

describe("A. orders (real entry, target exit and stop exit)", () => {
  it("envelope, exact row keys, decimal STRINGS, explicit nulls and the declared vocabularies", async () => {
    await ready(); const r = await get("/execution/orders", A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(["orders"]);
    expect(A.orders).toHaveLength(3); expect(A.orders.filter((o) => o["purpose"] === "ENTRY")).toHaveLength(1); expect(A.orders.filter((o) => o["purpose"] === "EXIT")).toHaveLength(2);
    for (const o of A.orders) {
      expect(keys(o)).toEqual(sorted(ORDER_KEYS));
      for (const k of ["quantity", "filledQuantity", "avgFillPrice"]) expect(isDecimalString(o[k]), `${k} ${String(o[k])}`).toBe(true);
      expect(o["limitPrice"]).toBeNull(); expect(o["orderType"]).toBe("MARKET"); // a market order has NO limit price: null, not 0
      expect(C.PAPER_ORDER_STATES).toContain(o["status"]); expect(["ENTRY", "EXIT"]).toContain(o["purpose"]); expect(["BUY", "SELL"]).toContain(o["side"]);
      expect(isIso(o["createdAt"])).toBe(true); expect(typeof o["stateReason"]).toBe("string");
      expect(o["decisionId"]).toBe(A.p.decisionId); expect(o["accountId"]).toBe(A.p.accountId);
    }
  });
  it("the entry order has NO positionId (null) and no exit reason; exit orders carry the position id and a reason", async () => {
    await ready(); const pos = A.positions[0]!["id"];
    for (const o of A.orders) {
      if (o["purpose"] === "ENTRY") { expect(o["positionId"]).toBeNull(); expect(o["exitReason"]).toBeNull(); }
      else { expect(o["positionId"]).toBe(pos); expect(typeof o["exitReason"]).toBe("string"); }
    }
    expect(A.orders.filter((o) => o["purpose"] === "EXIT").map((o) => o["exitReason"]).sort()).toEqual(["STOP_HIT", "TARGET_HIT"]);
  });
  it("decimal strings keep their backend scale (quantity '4500' but filledQuantity '4500.00000000'): they are different strings and must be shown as sent", async () => {
    await ready(); const entry = A.orders.find((o) => o["purpose"] === "ENTRY")!; expect(entry["quantity"]).toBe("4500"); expect(entry["filledQuantity"]).toBe("4500.00000000"); expect(String(entry["avgFillPrice"]).split(".")[1]!.length).toBeGreaterThan(8);
  });
  it("the list has only `limit` (1 to 200): no account filter, no offset, no cursor, no total, so a limited answer is never a complete history", async () => {
    await ready();
    expect((await get("/execution/orders?limit=1", A.token)).body["orders"]).toHaveLength(1); // truncation exists, and the envelope below carries no sign of it
    expect(keys((await get("/execution/orders?limit=1", A.token)).body)).toEqual(["orders"]);
    for (const q of [`accountId=${A.p.accountId}`, "offset=1", "cursor=x", "page=2", "limit=0", "limit=201", "limit=abc", "x=1"]) { const r = await get(`/execution/orders?${q}`, A.token); expect(r.status, q).toBe(422); expect(r.body["error"]).toBe("VALIDATION"); }
    expect((await get("/execution/orders?limit=200", A.token)).status).toBe(200);
  });
  it("decisionId and status are the only filters, and decisionId returns exactly that decision's orders", async () => {
    await ready(); const mine = rows((await get(`/execution/orders?decisionId=${A.p.decisionId}`, A.token)).body, "orders"); expect(mine.map((o) => o["id"]).sort()).toEqual(A.orders.map((o) => o["id"]).sort());
    expect(rows((await get(`/execution/orders?decisionId=${D.p.decisionId}`, A.token)).body, "orders")).toEqual([]); // another user's decision: nothing, no error
    expect(rows((await get("/execution/orders?status=FILLED", A.token)).body, "orders")).toHaveLength(3); expect((await get("/execution/orders?decisionId=not-a-uuid", A.token)).status).toBe(422);
  });
});

describe("B. fills", () => {
  it("every FILLED order has at least one fill; exact keys; quantity, price and costs are decimal STRINGS; priceSource and filledAt are real", async () => {
    await ready();
    for (const o of A.orders) {
      const r = await get(`/execution/orders/${o["id"] as string}/fills`, A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(["fills"]); const fills = rows(r.body, "fills"); expect(fills.length).toBeGreaterThan(0);
      for (const f of fills) { expect(keys(f)).toEqual(sorted(FILL_KEYS)); for (const k of ["quantity", "price", "costs"]) expect(isDecimalString(f[k]), `${k} ${String(f[k])}`).toBe(true); expect(typeof f["priceSource"]).toBe("string"); expect(isIso(f["filledAt"])).toBe(true); }
    }
  });
  it("the entry fill states where its price came from (FIXTURE here) and its quantity equals the order's filled quantity as the same string family", async () => {
    await ready(); const entry = A.orders.find((o) => o["purpose"] === "ENTRY")!, f = rows((await get(`/execution/orders/${entry["id"] as string}/fills`, A.token)).body, "fills")[0]!;
    expect(f["priceSource"]).toBe("FIXTURE"); expect(Number(f["quantity"])).toBe(Number(entry["filledQuantity"])); // value equality only; no arithmetic on money
  });
});

describe("C. positions", () => {
  it("a CLOSED position: exact keys including the ones a browser must never receive; money, stops and targets are decimal STRINGS", async () => {
    await ready(); const r = await get("/execution/positions", A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(["positions"]); expect(A.positions).toHaveLength(1); const p = A.positions[0]!;
    expect(keys(p)).toEqual(sorted(POSITION_KEYS));
    for (const k of ["quantity", "initialQuantity", "avgEntryPrice", "initialStop", "stopLoss", "realizedPnl", "realizedCosts"]) expect(isDecimalString(p[k]), `${k} ${String(p[k])}`).toBe(true);
    expect(Array.isArray(p["targets"])).toBe(true); for (const t of p["targets"] as unknown[]) expect(isDecimalString(t)).toBe(true);
    expect(C.POSITION_STATUSES).toContain(p["status"]); expect(p["status"]).toBe("CLOSED"); expect(p["quantity"]).toBe("0"); // a closed position's remaining quantity is the string "0", a real backend value
    expect(typeof p["exitReason"]).toBe("string"); expect(isIso(p["openedAt"])).toBe(true); expect(isIso(p["closedAt"])).toBe(true);
    expect(p["decisionId"]).toBe(A.p.decisionId); expect(p["accountId"]).toBe(A.p.accountId);
  });
  it("an OPEN position reports its not-yet-known fields as explicit null (exitReason, closedAt), never zero, and an open quantity string", async () => {
    await ready(); const p = rows((await get("/execution/positions?status=OPEN", D.token)).body, "positions")[0]!; expect(keys(p)).toEqual(sorted(POSITION_KEYS));
    expect(p["status"]).toBe("OPEN"); expect(p["exitReason"]).toBeNull(); expect(p["closedAt"]).toBeNull(); expect(isDecimalString(p["quantity"])).toBe(true); expect(Number(p["quantity"])).toBeGreaterThan(0); expect(p["realizedPnl"]).toEqual(expect.any(String));
  });
  it("the real output contains `userId` and a large free-form `rules` object; the frontend allow-list excludes them and projecting through it leaks neither the user id nor any fee schedule", async () => {
    await ready(); const p = A.positions[0]!; expect(p["userId"]).toBe(A.p.userId); expect(typeof p["rules"]).toBe("object"); expect(p["rules"]).not.toBeNull();
    expect(FRONTEND_POSITION_KEYS).not.toContain("userId"); expect(FRONTEND_POSITION_KEYS).not.toContain("rules"); expect(FRONTEND_POSITION_KEYS.every((k) => POSITION_KEYS.includes(k))).toBe(true);
    const shown = JSON.stringify(project(p, FRONTEND_POSITION_KEYS)); expect(shown).not.toContain(A.p.userId); expect(shown).not.toMatch(/sebiPct|brokerage|feeVersion|stampDuty|exchangeCharge|ladder/);
  });
  it("`status` accepts only OPEN or CLOSED, and the list has only `status` and `limit` (no account filter, no offset, no decisionId filter)", async () => {
    await ready(); expect(rows((await get("/execution/positions?status=CLOSED", A.token)).body, "positions")).toHaveLength(1); expect(rows((await get("/execution/positions?status=OPEN", A.token)).body, "positions")).toEqual([]);
    for (const q of ["status=BOGUS", `accountId=${A.p.accountId}`, `decisionId=${A.p.decisionId}`, "offset=1", "limit=0", "limit=201"]) expect((await get(`/execution/positions?${q}`, A.token)).status, q).toBe(422);
    expect(keys((await get("/execution/positions?limit=1", A.token)).body)).toEqual(["positions"]);
  });
});

describe("D. position events", () => {
  it("real, non-empty, exact keys {kind, payload, at}; `at` is ISO; the payload is a free-form object whose money values, where present, are strings", async () => {
    await ready(); const r = await get(`/execution/positions/${A.positions[0]!["id"] as string}/events`, A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(["events"]); expect(A.events.length).toBeGreaterThanOrEqual(8);
    for (const e of A.events) { expect(keys(e)).toEqual(sorted(EVENT_KEYS)); expect(typeof e["kind"]).toBe("string"); expect(isIso(e["at"])).toBe(true); expect(typeof e["payload"]).toBe("object"); expect(e["payload"]).not.toBeNull(); }
    const kinds = new Set(A.events.map((e) => e["kind"])); for (const k of ["OPENED", "PARTIAL_EXIT", "CLOSED", "STOP_MOVED"]) expect(kinds.has(k), k).toBe(true);
    for (const e of A.events) for (const k of ["realizedPnl", "realizedCosts", "avgEntryPrice", "quantity", "to", "from"]) { const v = (e["payload"] as Record<string, unknown>)[k]; if (v !== undefined) expect(typeof v, `${String(e["kind"])}.${k}`).toBe("string"); }
  });
  it("the events are returned in API order (by time, then id); a CLOSED event can precede its STOP_HIT detail event, so a screen must not infer lifecycle from the order", async () => {
    await ready(); const ats = A.events.map((e) => Date.parse(e["at"] as string)); expect(ats).toEqual([...ats].sort((x, y) => x - y));
    const idx = (k: string): number => A.events.findIndex((e) => e["kind"] === k); expect(idx("CLOSED")).toBeGreaterThanOrEqual(0); expect(idx("STOP_HIT")).toBeGreaterThan(idx("CLOSED")); // observed with the real monitor: the detail event is written after the closing event
  });
  it("the frontend allow-list excludes `payload`, and projecting through it exposes no payload content", async () => {
    await ready(); expect(FRONTEND_EVENT_KEYS).toEqual(["kind", "at"]); const shown = JSON.stringify(A.events.map((e) => project(e, FRONTEND_EVENT_KEYS))); expect(shown).not.toMatch(/realizedPnl|openQuantity|decisionId|repaired|differences/);
  });
  it("CROSS-USER ISOLATION: the rows really exist, yet another trader reads an EMPTY list (200, no error, no data), an ADMIN reads nothing, and an unknown id looks the same", async () => {
    await ready(); const pid = A.positions[0]!["id"] as string, o = await owner();
    const real = (await o.query("select count(*)::int as n from paper_position_events where position_id = $1", [pid])).rows[0] as { n: number }; expect(real.n).toBeGreaterThan(0); expect(A.events.length).toBe(real.n);
    for (const [who, token] of [["trader X", X.token], ["trader D", D.token]] as const) { const r = await get(`/execution/positions/${pid}/events`, token); expect(r.status, who).toBe(200); expect(r.body).toEqual({ events: [] }); }
    const unknown = await get(`/execution/positions/${randomUUID()}/events`, X.token); expect(unknown.status).toBe(200); expect(unknown.body).toEqual({ events: [] }); // indistinguishable from a foreign id: a screen must not claim "no events recorded" for an id it did not get from its own list
    expect((await get(`/execution/positions/${pid}/events`, ADMIN_TOKEN)).status).toBe(404); expect((await get("/execution/positions/not-a-uuid/events", A.token)).status).toBe(422);
  });
});

describe("E. portfolio", () => {
  it("a trader with a closed trade: exact envelope and facts keys, PAPER mode, counts as numbers, money as STRINGS, realised P&L equal to the position's string", async () => {
    await ready(); const r = await get(`/portfolio?accountId=${A.p.accountId}`, A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(sorted(PORTFOLIO_KEYS)); expect(r.body["mode"]).toBe("PAPER"); expect(r.body["isolation"]).toBe("PER_USER_ACCOUNT");
    const f = r.body["facts"] as Record<string, unknown>; expect(keys(f)).toEqual(sorted(FACTS_KEYS)); expect(f["accountId"]).toBe(A.p.accountId); expect(typeof f["openPositions"]).toBe("number"); expect(f["openPositions"]).toBe(0);
    expect(isDecimalString(f["allocatedNotional"])).toBe(true); expect(isDecimalString(f["realizedPnl"])).toBe(true); expect(f["realizedPnl"]).toBe(A.positions[0]!["realizedPnl"]); // string equality, no arithmetic
    expect(Array.isArray(r.body["notes"])).toBe(true); expect((r.body["notes"] as string[]).join(" ")).toContain("no live portfolio source is connected");
  });
  it("capital facts are null (UNAVAILABLE), never 0: A's profile is effective in 2030, which is the FUTURE for the database view's clock", async () => {
    await ready(); const f = (await get(`/portfolio?accountId=${A.p.accountId}`, A.token)).body["facts"] as Record<string, unknown>;
    for (const k of ["totalCapital", "availableCapital", "unallocatedCapital", "capitalProfileVersion"]) expect(f[k], k).toBeNull();
    const cap = (await get(`/capital/profile?accountId=${A.p.accountId}`, A.token)).body; expect(cap["effective"]).not.toBeNull(); // the capital route (route clock 2031) still sees the profile: the two routes use different clocks, and the screens must show each as sent
  });
  it("a trader with an OPEN position and a profile effective in the past: capital facts are decimal STRINGS and a version NUMBER; one open position; allocated notional is a non-zero string", async () => {
    await ready(); const f = (await get(`/portfolio?accountId=${D.p.accountId}`, D.token)).body["facts"] as Record<string, unknown>; expect(keys(f)).toEqual(sorted(FACTS_KEYS));
    expect(f["openPositions"]).toBe(1); expect(isDecimalString(f["allocatedNotional"])).toBe(true); expect(Number(f["allocatedNotional"])).toBeGreaterThan(0);
    for (const k of ["totalCapital", "availableCapital", "unallocatedCapital"]) expect(isDecimalString(f[k]), k).toBe(true); expect(f["totalCapital"]).toBe("2000000"); expect(f["availableCapital"]).toBe("1500000.50"); expect(typeof f["capitalProfileVersion"]).toBe("number");
  });
  it("an account with NO positions and NO capital: the backend itself reports '0' for the empty sums and null for capital (a screen must show '0' as sent, and capital as unavailable)", async () => {
    await ready(); const f = (await get(`/portfolio?accountId=${X.accountId}`, X.token)).body["facts"] as Record<string, unknown>;
    expect(f["openPositions"]).toBe(0); expect(f["allocatedNotional"]).toBe("0"); expect(f["realizedPnl"]).toBe("0"); for (const k of ["totalCapital", "availableCapital", "unallocatedCapital", "capitalProfileVersion"]) expect(f[k], k).toBeNull();
  });
  it("NO unrealised P&L, mark price or live balance exists anywhere in the portfolio, orders, positions or events output", async () => {
    await ready(); const all = JSON.stringify([(await get(`/portfolio?accountId=${A.p.accountId}`, A.token)).body, (await get(`/portfolio?accountId=${D.p.accountId}`, D.token)).body, A.orders, A.positions, A.events, (await get("/execution/positions", D.token)).body]).toLowerCase();
    expect(all).not.toMatch(/unrealis|unrealiz|markprice|mark_price|marktomarket|ltp|livebalance|live_balance|cashbalance/);
  });
  it("the account must be the caller's: a foreign or unknown account is 404, a missing or malformed accountId is a validation error", async () => {
    await ready(); expect((await get(`/portfolio?accountId=${A.p.accountId}`, X.token)).status).toBe(404); expect((await get(`/portfolio?accountId=${randomUUID()}`, A.token)).status).toBe(404);
    expect((await get("/portfolio", A.token)).status).toBe(422); expect((await get("/portfolio?accountId=nope", A.token)).status).toBe(422);
  });
});

describe("F. capital profile and risk policy", () => {
  it("capital: exact keys, money as STRINGS, an unset optional limit stays null, the version history is real", async () => {
    await ready(); const r = await get(`/capital/profile?accountId=${A.p.accountId}`, A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(sorted(CAPITAL_KEYS)); expect(r.body["isolation"]).toBe("PER_USER_ACCOUNT");
    const e = r.body["effective"] as Record<string, unknown>; expect(keys(e)).toEqual(sorted(CAPITAL_ROW_KEYS)); expect(e["totalCapital"]).toBe("1000000"); expect(isDecimalString(e["availableCapital"])).toBe(true); expect(e["maxPositionNotionalPct"]).toBeNull(); expect(typeof e["version"]).toBe("number"); expect(e["currency"]).toBe("INR"); expect(isIso(e["effectiveFrom"])).toBe(true);
    const v = rows(r.body, "versions"); expect(v.length).toBeGreaterThanOrEqual(1); for (const x of v) expect(keys(x)).toEqual(sorted(CAPITAL_ROW_KEYS));
    const d = (await get(`/capital/profile?accountId=${D.p.accountId}`, D.token)).body["effective"] as Record<string, unknown>; expect(d["maxPositionNotionalPct"]).toBe("25"); expect(d["availableCapital"]).toBe("1500000.50");
  });
  it("capital for an account with no profile: effective is null and versions is an empty list (not a zero profile)", async () => {
    await ready(); expect((await get(`/capital/profile?accountId=${X.accountId}`, X.token)).body).toEqual({ accountId: X.accountId, isolation: "PER_USER_ACCOUNT", effective: null, versions: [] });
  });
  it("risk policy: exact keys; percentages and limits as STRINGS; counts as numbers; unset limits are null; the underlying list is an array", async () => {
    await ready(); const r = await get(`/risk/policy?accountId=${A.p.accountId}`, A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(sorted(POLICY_KEYS)); const p = r.body["policy"] as Record<string, unknown>; expect(keys(p)).toEqual(sorted(POLICY_ROW_KEYS));
    for (const k of ["riskPercent", "maxDailyLoss", "minRewardToRisk"]) expect(isDecimalString(p[k]), k).toBe(true); for (const k of ["maxConcurrentPositions", "maxLots", "version"]) expect(typeof p[k], k).toBe("number");
    for (const k of ["maxRiskPerTrade", "maxDrawdownPct", "maxPortfolioExposurePct", "maxCorrelatedRiskPct"]) expect(p[k], k).toBeNull(); expect(p["allowedUnderlyings"]).toEqual([]);
    const d = (await get(`/risk/policy?accountId=${D.p.accountId}`, D.token)).body["policy"] as Record<string, unknown>; for (const k of ["maxRiskPerTrade", "maxDrawdownPct", "maxPortfolioExposurePct", "maxCorrelatedRiskPct"]) expect(isDecimalString(d[k]), k).toBe(true); expect(d["maxRiskPerTrade"]).toBe("15000"); expect(d["maxDrawdownPct"]).toBe("10"); expect(d["maxCorrelatedRiskPct"]).toBe("3"); expect(d["allowedUnderlyings"]).toEqual([]);
  });
  it("risk policy for an account with none: policy is null", async () => { await ready(); expect((await get(`/risk/policy?accountId=${X.accountId}`, X.token)).body).toEqual({ accountId: X.accountId, policy: null }); });
  it("another trader's account and an ADMIN are 404 on capital and policy; a missing accountId is a validation error", async () => {
    await ready(); for (const u of [`/capital/profile?accountId=${A.p.accountId}`, `/risk/policy?accountId=${A.p.accountId}`]) { expect((await get(u, X.token)).status, `X ${u}`).toBe(404); expect((await get(u, ADMIN_TOKEN)).status, `ADMIN ${u}`).toBe(404); }
    expect((await get("/capital/profile", A.token)).status).toBe(422); expect((await get("/risk/policy", A.token)).status).toBe(422);
  });
});

describe("G. risk controls (real rows written by the real setRiskControl)", () => {
  it("exact envelope and row keys; the user's own RESTRICTION and KILL_SWITCH are present; `expiresAt` is ISO or null; `setAt` is an ISO timestamp", async () => {
    await withControls(); const r = await get("/risk/controls", A.token); expect(r.status).toBe(200); expect(keys(r.body)).toEqual(["controls"]); const own = rows(r.body, "controls").filter((c) => c["userId"] === A.p.userId);
    expect(own.map((c) => c["kind"]).sort()).toEqual(["KILL_SWITCH", "RESTRICTION"]);
    for (const c of rows(r.body, "controls")) { expect(keys(c)).toEqual(sorted(CONTROL_KEYS)); expect(["USER", "MARKET", "SOURCE", "STRATEGY"]).toContain(c["scope"]); expect(["RESTRICTION", "DAILY_LOSS_HALT", "DRAWDOWN_HALT", "KILL_SWITCH"]).toContain(c["kind"]); expect(typeof c["reason"]).toBe("string"); expect(isIso(c["setAt"])).toBe(true); expect(c["expiresAt"] === null || isIso(c["expiresAt"])).toBe(true); }
    expect(own.find((c) => c["kind"] === "RESTRICTION")!["expiresAt"]).toBe("2032-01-01T00:00:00.000Z"); expect(own.find((c) => c["kind"] === "KILL_SWITCH")!["expiresAt"]).toBeNull(); expect(own.every((c) => c["scope"] === "USER" && c["scopeKey"] === null)).toBe(true);
  });
  it("another trader never sees A's user-scoped controls, and an ADMIN is 404", async () => {
    await withControls(); for (const t of [X.token, D.token]) { const others = rows((await get("/risk/controls", t)).body, "controls"); expect(others.some((c) => c["userId"] === A.p.userId)).toBe(false); expect(JSON.stringify(others)).not.toContain("contract parity"); }
    expect((await get("/risk/controls", ADMIN_TOKEN)).status).toBe(404);
  });
  it("controls take no parameters", async () => { await withControls(); expect((await get(`/risk/controls?accountId=${A.p.accountId}`, A.token)).status).toBe(422); });
  it("the control read filters by owner EXPLICITLY (risk-control hardening, defence in depth beside forced RLS): another trader's control is invisible both under the restricted role and on the superuser connection where RLS is bypassed", async () => {
    await withControls(); const asX = (await listActiveControls(dbRls, X.userId, NOW)).filter((c) => c.userId === A.p.userId); expect(asX).toEqual([]);
    const asSuper = (await listActiveControls(db, X.userId, NOW)).filter((c) => c.userId === A.p.userId); expect(asSuper).toEqual([]); // before the explicit filter this returned 2 rows on a superuser connection: isolation then rested on row-level security alone
  });
});

describe("H. cross-user isolation and ADMIN restrictions for every route in this step", () => {
  it("trader X reads none of A's orders, fills, positions, events, portfolio, capital, policy or controls", async () => {
    await ready(); const oid = A.orders[0]!["id"] as string, pid = A.positions[0]!["id"] as string;
    const lists = JSON.stringify([(await get("/execution/orders", X.token)).body, (await get("/execution/positions", X.token)).body, (await get(`/execution/orders?decisionId=${A.p.decisionId}`, X.token)).body, (await get(`/execution/orders/${oid}/fills`, X.token)).body, (await get(`/execution/positions/${pid}/events`, X.token)).body, (await get("/risk/controls", X.token)).body]);
    for (const marker of [A.p.decisionId, A.p.accountId, A.p.userId, oid, pid]) expect(lists, marker).not.toContain(marker);
    for (const u of [`/portfolio?accountId=${A.p.accountId}`, `/capital/profile?accountId=${A.p.accountId}`, `/risk/policy?accountId=${A.p.accountId}`]) expect((await get(u, X.token)).status, u).toBe(404);
  });
  it("an ADMIN holds no private permission: all eight routes answer 404 with the neutral body", async () => {
    await ready(); const oid = A.orders[0]!["id"] as string, pid = A.positions[0]!["id"] as string;
    for (const u of ["/execution/orders", `/execution/orders/${oid}/fills`, "/execution/positions", `/execution/positions/${pid}/events`, `/portfolio?accountId=${A.p.accountId}`, `/capital/profile?accountId=${A.p.accountId}`, `/risk/policy?accountId=${A.p.accountId}`, "/risk/controls"]) {
      const r = await get(u, ADMIN_TOKEN); expect(r.status, u).toBe(404); expect(r.body["error"]).toBe("NOT_FOUND"); expect(JSON.stringify(r.body)).not.toContain(A.p.userId);
    }
  });
  it("no session and a bad token are 401 on every route", async () => {
    await ready(); for (const u of ["/execution/orders", "/execution/positions", `/portfolio?accountId=${A.p.accountId}`, "/risk/controls"]) { const r = await app.inject({ method: "GET", url: u }); expect(r.statusCode, u).toBe(401); expect((await get(u, "tws_not_a_session")).status, u).toBe(401); }
  });
});

describe("I. decision to order and position linkage", () => {
  it("every order and the position carry the decision's id, the decision exists for the same owner, and exactly ONE position belongs to the decision", async () => {
    await ready(); const dec = await get(`/decisions/${A.p.decisionId}`, A.token); expect(dec.status).toBe(200); expect((dec.body["decision"] as Record<string, unknown>)["id"]).toBe(A.p.decisionId);
    expect(A.orders.every((o) => o["decisionId"] === A.p.decisionId)).toBe(true); expect(A.positions.filter((p) => p["decisionId"] === A.p.decisionId)).toHaveLength(1);
    expect(A.orders.filter((o) => o["positionId"] !== null).every((o) => o["positionId"] === A.positions[0]!["id"])).toBe(true);
  });
  it("the link is owner-checked: another trader can neither read the decision nor list orders by its id, and an ADMIN reads nothing", async () => {
    await ready(); expect((await get(`/decisions/${A.p.decisionId}`, X.token)).status).toBe(404); expect(rows((await get(`/execution/orders?decisionId=${A.p.decisionId}`, X.token)).body, "orders")).toEqual([]);
    expect((await get(`/execution/orders?decisionId=${A.p.decisionId}`, ADMIN_TOKEN)).status).toBe(404);
  });
  it("positions cannot be filtered by decision on the server (422), so a position is linked to a decision only by matching `decisionId` inside the latest-N list", async () => {
    await ready(); expect((await get(`/execution/positions?decisionId=${A.p.decisionId}`, A.token)).status).toBe(422);
  });
});

describe("J. unverified and limits (recorded, not asserted as fact)", () => {
  it("documents what this file does NOT prove", () => {
    const unverified = [
      "event `kind` vocabulary: only the kinds produced by the real monitor in these scenarios were observed (OPENED, PARTIAL_EXIT, TARGET_HIT, RECONCILED, STOP_MOVED, CLOSED, STOP_HIT); no complete list is declared by the backend",
      "event `payload` and position `rules`: free-form, per-kind shapes observed but not contractual",
      "order statuses other than FILLED (PARTIALLY_FILLED, REJECTED, CANCELLED, EXPIRED, PROPOSED, SUBMITTED, ACCEPTED): not produced by these scenarios; only membership in the declared vocabulary is checked",
      "a limit order (limitPrice non-null) and an unfilled order (avgFillPrice null): not produced here",
      "risk controls of kind DAILY_LOSS_HALT and DRAWDOWN_HALT and non-USER scopes: not written here (platform-wide controls would affect other tests)",
      "the default limit (50) and the maximum (200) are asserted only through the rejection of 201; no data set with more than 3 rows is created",
      "account-scoped history cannot be derived: the lists are per user, newest-limited, with no account filter, offset or total",
    ];
    expect(unverified.length).toBeGreaterThan(0);
  });
});
