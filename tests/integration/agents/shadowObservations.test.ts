/**
 * Durable shadow observations (HB-25) against REAL PostgreSQL: migration 0032 applies, the writer is idempotent, the table is append-only, constraints hold, and recording a shadow observation changes
 * no live table (the equivalence guarantee at database level). Everything is synthetic.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { recordShadowObservation } from "../../../services/worker/src/shadowStore";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let handle: BoundedDbHandle;
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 3, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });
const n = async (sql: string, p: unknown[] = []) => Number(must((await pool.query(sql, p)).rows[0])["n"]);
const LIVE = ["telegram_messages", "signals", "options_claims", "risk_decisions", "risk_approvals", "risk_approval_cards", "orders", "fills", "positions", "paper_trades", "paper_trade_events", "stop_loss_validations"];
const counts = () => Promise.all(LIVE.map((t) => n(`select count(*)::int as n from ${t}`)));

describe("shadow_observations", () => {
  it("records one row per (kind, decision, version), idempotently, without touching any live table", async () => {
    const id = randomUUID();
    const before = await counts();
    const a = await recordShadowObservation(handle.db, { kind: "reduce_only_sizing", riskDecisionId: id, decisionVersion: 2, result: { v1Quantity: 100, shadowQuantity: 75, multiplier: 0.75, reduced: true, rawText: "must be dropped", factors: [{ name: "thin_evidence", multiplier: 0.75 }] } });
    const b = await recordShadowObservation(handle.db, { kind: "reduce_only_sizing", riskDecisionId: id, decisionVersion: 2, result: { v1Quantity: 999 } });
    const c = await recordShadowObservation(handle.db, { kind: "agent_engine", riskDecisionId: id, decisionVersion: 2, result: { assessment: "RESEARCH_CAUTION", wouldHalt: false, agents: [] } });
    const d = await recordShadowObservation(handle.db, { kind: "reduce_only_sizing", riskDecisionId: id, decisionVersion: 3, result: { v1Quantity: 100 } });
    expect([a.recorded, b.recorded, c.recorded, d.recorded]).toEqual([true, false, true, true]);
    expect(await counts()).toEqual(before);
    const row = must((await pool.query("select * from shadow_observations where risk_decision_id = $1 and kind = 'reduce_only_sizing' and decision_version = 2", [id])).rows[0]);
    expect(row["used_for_decisions"]).toBe(false);
    expect(row["result"]).toMatchObject({ v1Quantity: 100, shadowQuantity: 75, reduced: true });
    expect(JSON.stringify(row["result"])).not.toContain("must be dropped");
    expect(await n("select count(*)::int as n from shadow_observations where risk_decision_id = $1", [id])).toBe(3);
  });
  it("is append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    const id = randomUUID();
    await recordShadowObservation(handle.db, { kind: "agent_engine", riskDecisionId: id, decisionVersion: 1, result: { assessment: "RESEARCH_SUPPORTIVE" } });
    await expect(pool.query("update shadow_observations set result = '{}'::jsonb where risk_decision_id = $1", [id])).rejects.toThrow();
    await expect(pool.query("delete from shadow_observations where risk_decision_id = $1", [id])).rejects.toThrow();
    await expect(pool.query("truncate shadow_observations")).rejects.toThrow();
    expect(await n("select count(*)::int as n from shadow_observations where risk_decision_id = $1", [id])).toBe(1);
  });
  it("database constraints: never used for decisions, known kinds, positive version, bounded size", async () => {
    const ins = (kind: string, ver: number, used: boolean, result: unknown) => pool.query("insert into shadow_observations (kind, risk_decision_id, decision_version, result, used_for_decisions) values ($1, $2, $3, $4::jsonb, $5)", [kind, randomUUID(), ver, JSON.stringify(result), used]);
    await expect(ins("agent_engine", 1, true, {})).rejects.toThrow();
    await expect(ins("something_else", 1, false, {})).rejects.toThrow();
    await expect(ins("agent_engine", 0, false, {})).rejects.toThrow();
    await expect(ins("agent_engine", 1, false, { big: "x".repeat(20_000) })).rejects.toThrow();
    await expect(ins("agent_engine", 1, false, { fine: 1 })).resolves.toBeTruthy();
  });
});
