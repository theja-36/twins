/**
 * Paper switch, admin route, notifications, agents status and system config against REAL PostgreSQL. Simulation only; no network, no broker.
 */
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../../../apps/api/src/adminApi";
import { registerAgentsRoutes } from "../../../apps/api/src/agentsApi";
import { collectNotifications, registerNotificationsRoutes } from "../../../apps/api/src/notificationsApi";
import { registerPaperRoutes } from "../../../apps/api/src/paperApi";
import { registerSystemRoutes } from "../../../apps/api/src/systemApi";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { PRODUCTION_AGENT_IDS } from "../../../packages/agents/src/index";
import { DEFAULT_PAPER_CONFIG, getPaperSwitch, listPaperSwitchEvents, runPaperCycle, setPaperSwitch, type PriceSource } from "../../../packages/paper/src/index";
import { configureRuntimeState, inMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let handle: BoundedDbHandle;
const db = () => handle.db;
const READ = { authorization: "Bearer read-token" }, ADMIN = { authorization: "Bearer admin-token-0123456789abcdef0123456789" };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;

function app() {
  const a = Fastify();
  registerPaperRoutes(a, { db: db(), authorized: (h) => h === READ.authorization });
  registerAgentsRoutes(a, { db: db(), authorized: (h) => h === READ.authorization });
  registerNotificationsRoutes(a, { db: db(), authorized: (h) => h === READ.authorization });
  registerSystemRoutes(a, { db: db(), authorized: (h) => h === READ.authorization, readSafety: () => ({ TRADING_ENABLED: false, INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }) });
  registerAdminRoutes(a, { db: db(), adminAuthorized: (h) => h === ADMIN.authorization });
  return a;
}
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 3, idleTimeoutMillis: 10_000 }); configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }); });
afterAll(async () => { await setPaperSwitch(db(), { enabled: false, actor: "service:test", reason: "restore OFF after the switch test" }).catch(() => undefined); await handle?.close(); await pool.end(); });

describe("paper switch", () => {
  it("is seeded OFF with a seed event, and only the audited function can change it", async () => {
    await setPaperSwitch(db(), { enabled: false, actor: "service:test", reason: "normalise before the test" });
    const sw = await getPaperSwitch(db());
    expect(sw.enabled).toBe(false); expect((await listPaperSwitchEvents(db(), 200)).some((e) => e.version === 1 && e.changedBy === "service:migration")).toBe(true);
    await expect(pool.query("update paper_switch set enabled = true where id = 1")).rejects.toThrow(/version must advance/); // even the owner cannot flip it without the version step
    await expect(pool.query("delete from paper_switch")).rejects.toThrow(/never deleted/);
    await expect(pool.query("update paper_switch_events set enabled = true")).rejects.toThrow();
    await expect(pool.query("delete from paper_switch_events")).rejects.toThrow();
    await expect(pool.query("select twins_paper_set_switch(true, 'sara', 'a good reason')")).rejects.toThrow(/actor/);
    await expect(pool.query("select twins_paper_set_switch(true, 'operator:sara', 'no')")).rejects.toThrow(/reason/);
    await expect(pool.query("select twins_paper_set_switch(null, 'operator:sara', 'a good reason')")).rejects.toThrow(/true or false/);
  });
  it("records each real change once (idempotent when unchanged) with actor, reason and a version step", async () => {
    const before = (await listPaperSwitchEvents(db(), 200)).length;
    expect(await setPaperSwitch(db(), { enabled: true, actor: "operator:sara", reason: "start of the paper period" })).toBe("enabled");
    expect(await setPaperSwitch(db(), { enabled: true, actor: "operator:sara", reason: "start of the paper period" })).toBe("unchanged");
    expect(await setPaperSwitch(db(), { enabled: false, actor: "operator:sara", reason: "end of the paper period" })).toBe("disabled");
    const ev = await listPaperSwitchEvents(db(), 200);
    expect(ev.length).toBe(before + 2); expect(ev[0]).toMatchObject({ enabled: false, previousEnabled: true, changedBy: "operator:sara" }); expect(ev[0]!.version).toBe(ev[1]!.version + 1);
  });
  it("gates the paper cycle: armed by the host but switched OFF => nothing runs and nothing is written", async () => {
    const before = Number((await q("select count(*)::int as n from paper_trades"))[0]!["n"]);
    const prices: PriceSource = { last: async () => { throw new Error("must not be asked for a price"); } };
    const r = await runPaperCycle(db(), { config: { ...DEFAULT_PAPER_CONFIG, enabled: true }, prices, env: { LIVE_TRADING: "false", TRADING_MODE: "paper" } });
    expect(r.skipped).toBe("PAPER_SWITCH_OFF");
    expect(Number((await q("select count(*)::int as n from paper_trades"))[0]!["n"])).toBe(before);
  });
});

describe("admin route (real database)", () => {
  it("flips the switch with the admin token only, audits it, and reports armed/effective", async () => {
    const a = app();
    const on = await a.inject({ method: "POST", url: "/admin/paper/switch", headers: ADMIN, payload: { enabled: true, actor: "operator:sara", reason: "admin route test on" } });
    expect(on.statusCode).toBe(201); expect(on.json()).toMatchObject({ outcome: "enabled", switch: { enabled: true }, armedByHost: false, effective: false }); // not armed by the host: still not running
    expect((await a.inject({ method: "POST", url: "/admin/paper/switch", headers: ADMIN, payload: { enabled: true, actor: "operator:sara", reason: "admin route test on" } })).statusCode).toBe(200);
    const st = (await a.inject({ method: "GET", url: "/paper/status", headers: READ })).json();
    expect(st).toMatchObject({ enabled: false, armedByHost: false, switch: { enabled: true } }); expect(st.switchHistory.length).toBeGreaterThan(0);
    const off = await a.inject({ method: "POST", url: "/admin/paper/switch", headers: ADMIN, payload: { enabled: false, actor: "operator:sara", reason: "admin route test off" } });
    expect(off.json()).toMatchObject({ outcome: "disabled", switch: { enabled: false } });
    expect((await a.inject({ method: "POST", url: "/admin/paper/switch", headers: READ, payload: { enabled: true, actor: "operator:sara", reason: "read token must not work" } })).statusCode).toBe(401);
  });
  it("refuses to enable while the live-trading guard fails", async () => {
    const saved = process.env["LIVE_TRADING"]; process.env["LIVE_TRADING"] = "true";
    try { expect((await app().inject({ method: "POST", url: "/admin/paper/switch", headers: ADMIN, payload: { enabled: true, actor: "operator:sara", reason: "must be refused" } })).statusCode).toBe(409); expect((await getPaperSwitch(db())).enabled).toBe(false); }
    finally { if (saved === undefined) delete process.env["LIVE_TRADING"]; else process.env["LIVE_TRADING"] = saved; }
  });
});

describe("feeds", () => {
  it("notifications: newest first, bounded, includes the switch changes, masks actors, and never leaks credentials", async () => {
    await setPaperSwitch(db(), { enabled: true, actor: "operator:abcdef12", reason: "notification test on" }); await setPaperSwitch(db(), { enabled: false, actor: "operator:abcdef12", reason: "notification test off" });
    const list = await collectNotifications(db(), 200); // the paper tests use a future fake clock, so their events sort first; look at a wide window
    expect(list.length).toBeLessThanOrEqual(200); expect((await collectNotifications(db(), 7)).length).toBeLessThanOrEqual(7); expect(list.map((n) => n.at)).toEqual([...list.map((n) => n.at)].sort().reverse());
    const sw = list.find((n) => n.kind === "paper_switch"); expect(sw).toBeTruthy(); expect(sw!.title).toMatch(/OFF|ON/); expect(sw!.title).not.toContain("abcdef12"); expect(sw!.title).toContain("***ef12");
    expect(JSON.stringify(list)).not.toMatch(/password|secret|bearer|token/i);
    const res = await app().inject({ method: "GET", url: "/notifications?limit=5", headers: READ }); expect(res.statusCode).toBe(200); expect(res.json().notifications.length).toBeLessThanOrEqual(5);
  });
  it("agents status: the twelve agents with contract metadata, engine mode, and persisted runs; shadow results are declared not stored", async () => {
    const r = (await app().inject({ method: "GET", url: "/agents/status", headers: READ })).json();
    expect(r.agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual([...PRODUCTION_AGENT_IDS].sort());
    expect(r).toMatchObject({ shadowResultsStored: false, engine: { enabled: false } }); expect(Array.isArray(r.recentRuns)).toBe(true); expect(typeof r.persistedRuns).toBe("number");
    for (const a of r.agents) expect(Object.keys(a).sort()).toEqual(["advisoryOnly", "agentId", "canBlock", "dependsOn", "disabled", "inputs", "name", "required", "timeoutMs", "version", "weight"]);
  });
  it("system config: safe snapshot with live trading off, paper not effective, risk limits present, and no secrets", async () => {
    const r = (await app().inject({ method: "GET", url: "/system/config", headers: READ })).json();
    expect(r.environment).toMatchObject({ liveTradingEnabled: false, brokerOrders: false }); expect(r.paperTrading).toMatchObject({ effective: false }); expect(r.runtimeControls).toMatchObject({ KILL_SWITCH_ACTIVE: false });
    expect(r.risk.sizing.valid).toBe(true); expect(r.risk.circuitBreakers.valid).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:\/\/|bearer|password|api[_-]?key|secret/i);
  });
});
