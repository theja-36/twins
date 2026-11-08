import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withUser } from "../../../packages/database/src/withUser";

/**
 * Static checks of migration 0033 (no database is available where this runs; the integration suite is what will apply it).
 * They pin the rules of ADR-002/003/008/011/012 so a later edit cannot quietly weaken them.
 */
const sql = readFileSync("packages/database/drizzle/0033_master_build_platform.sql", "utf8");
const created = [...sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
const PRIVATE = ["user_capital_profiles", "user_risk_policies", "user_execution_permissions", "risk_assessments", "simulations", "user_decisions", "user_decision_events", "trade_monitoring_events", "trade_outcomes"];
const APPEND_ONLY = ["user_capital_profiles", "user_risk_policies", "risk_assessments", "simulations", "user_decision_events", "trade_monitoring_events", "trade_outcomes", "strategy_drift_events", "learning_version_events", "signal_classifications", "market_regimes", "confidence_assessments", "confidence_calibration_runs", "counterfactual_reviews", "research_packages", "performance_snapshots"];

describe("migration 0033 (master build platform)", () => {
  it("creates exactly the planned 24 tables, once each", () => { expect(new Set(created).size).toBe(created.length); expect(created).toHaveLength(24); });
  it("is additive: no DROP, TRUNCATE, DELETE, or rewrite of existing columns", () => {
    const body = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(body).not.toMatch(/\bDROP\b|\bTRUNCATE TABLE\b|\bDELETE FROM\b|\bALTER COLUMN\b|\bRENAME\b/i);
    const alters = [...body.matchAll(/ALTER TABLE "([a-z_]+)" (ADD COLUMN|ADD CONSTRAINT|ENABLE|FORCE|ADD)/g)].map((m) => m[1]);
    for (const t of alters) expect([...created, "users"], t).toContain(t);
  });
  it("every user-private table has row-level security enabled, forced, and a fail-closed owner policy", () => {
    for (const t of PRIVATE) {
      expect(sql, t).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`); expect(sql, t).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql, t).toMatch(new RegExp(`CREATE POLICY "${t}_owner_only" ON "${t}" USING \\(user_id = nullif\\(current_setting\\('twins.user_id', true\\), ''\\)::uuid\\) WITH CHECK`));
    }
  });
  it("every private table carries a user_id column", () => {
    for (const t of PRIVATE) { const block = sql.slice(sql.indexOf(`CREATE TABLE "${t}"`), sql.indexOf(");", sql.indexOf(`CREATE TABLE "${t}"`))); expect(block, t).toContain('"user_id" uuid NOT NULL'); }
  });
  it("evidence tables are append-only with both triggers named so the runtime role gets SELECT and INSERT only", () => {
    for (const t of APPEND_ONLY) { expect(created, t).toContain(t); expect(sql, t).toContain(`CREATE TRIGGER "${t}_no_update_delete" BEFORE UPDATE OR DELETE ON "${t}"`); expect(sql, t).toContain(`CREATE TRIGGER "${t}_no_truncate" BEFORE TRUNCATE ON "${t}"`); }
  });
  it("the database refuses to record a live execution mode as enabled", () => { expect(sql).toContain(`CHECK ("user_execution_permissions"."mode" = 'PAPER' or "user_execution_permissions"."enabled" = false)`); });
  it("only a QUALIFIED decision can be APPROVED, and learning must be evaluated before it can go live", () => {
    expect(sql).toContain(`"user_decisions"."workflow_state" <> 'APPROVED' or "user_decisions"."outcome" = 'QUALIFIED'`);
    expect(sql).toContain(`"learning_versions"."influences_live" = false or "learning_versions"."state" = 'ACTIVE'`);
    expect(sql).toContain(`"confidence_calibration_runs"."calibration_status" <> 'CALIBRATED' or "confidence_calibration_runs"."out_of_sample" = true`);
  });
  it("the two pipelines cannot be mixed in one candidate, and risk is capped at the hard 5 percent ceiling", () => {
    expect(sql).toMatch(/opportunity_candidates_origin_check/); expect(sql).toContain(`"user_risk_policies"."risk_percent" <= 5`);
  });
  it("paper and live outcomes must cite their own source", () => { expect(sql).toMatch(/trade_outcomes_source_check/); });
});

describe("withUser", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  it("sets the transaction-local user before running the callback and returns its result", async () => {
    const calls: string[] = [];
    const db = { transaction: async (f: (tx: unknown) => Promise<unknown>) => f({ execute: async () => { calls.push("set"); } }) } as never;
    const out = await withUser(db, U, async () => { calls.push("body"); return 42; });
    expect(out).toBe(42); expect(calls).toEqual(["set", "body"]);
  });
  it("refuses a non-UUID user id before touching the database", async () => {
    let touched = false; const db = { transaction: async () => { touched = true; } } as never;
    await expect(withUser(db, "x'; drop table users;--", async () => 1)).rejects.toThrow(/UUID/); expect(touched).toBe(false);
  });
});
