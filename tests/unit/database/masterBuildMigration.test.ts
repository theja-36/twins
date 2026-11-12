import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasSessionCredential, runWithSessionCredential, withUser } from "../../../packages/database/src/withUser";

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


describe("migration 0033 review hardening", () => {
  const OWNED = ["user_capital_profiles", "user_risk_policies", "user_execution_permissions", "risk_assessments", "simulations", "user_decisions", "trade_monitoring_events", "trade_outcomes"];
  it("every account-bound private table has a composite (account_id, user_id) foreign key, so a row can never name another user's account", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "accounts_id_user_unique" ON "accounts" USING btree ("id","user_id")');
    for (const t of OWNED) expect(sql, t).toMatch(new RegExp(`ALTER TABLE "${t}" ADD CONSTRAINT "${t}_owner_fk" FOREIGN KEY \\("account_id","user_id"\\) REFERENCES "public"."accounts"\\("id","user_id"\\)`));
  });
  it("decision links are owner-tied: assessments, simulations, events, monitoring and outcomes can only cite the same user's rows", () => {
    for (const n of ["user_decisions_risk_assessment_fk", "user_decisions_simulation_fk", "user_decisions_supersedes_fk", "user_decision_events_decision_fk", "trade_monitoring_events_decision_fk", "trade_outcomes_decision_fk"]) expect(sql, n).toMatch(new RegExp(`CONSTRAINT "${n}" FOREIGN KEY \\("[a-z_]+","user_id"\\)`));
    expect(sql).toMatch(/CONSTRAINT "trade_outcomes_order_fk" FOREIGN KEY \("order_id","account_id"\) REFERENCES "public"."orders"\("id","account_id"\)/);
    expect(sql).toContain('CREATE UNIQUE INDEX "orders_id_account_unique" ON "orders" USING btree ("id","account_id")');
  });
  it("each unique index that a composite foreign key references is created BEFORE the first foreign key (Postgres refuses the key otherwise; found by CI)", () => {
    const parts = sql.split("--> statement-breakpoint\n");
    const firstFk = parts.findIndex((x) => x.includes("FOREIGN KEY"));
    for (const n of ["accounts_id_user_unique", "orders_id_account_unique", "risk_assessments_id_user_unique", "simulations_id_user_unique", "user_decisions_id_user_unique"]) {
      const at = parts.findIndex((x) => x.includes(`INDEX "${n}"`)); expect(at, n).toBeGreaterThan(-1); expect(at, n).toBeLessThan(firstFk);
    }
    // and every referenced table exists before an index on it is created
    const created = parts.map((x, i) => [i, /CREATE TABLE "([a-z_]+)"/.exec(x)?.[1]] as const).filter(([, t]) => t);
    for (const [n, table] of [["risk_assessments_id_user_unique", "risk_assessments"], ["simulations_id_user_unique", "simulations"], ["user_decisions_id_user_unique", "user_decisions"]] as const) {
      expect(created.find(([, t]) => t === table)?.[0] ?? 999, n).toBeLessThan(parts.findIndex((x) => x.includes(`INDEX "${n}"`)));
    }
  });
  it("no identifier exceeds Postgres's 63-byte limit (longer names are silently truncated)", () => {
    const ids = new Set([...sql.matchAll(/(?:CONSTRAINT|INDEX|TRIGGER|POLICY) "([a-z0-9_]+)"/g)].map((m) => m[1] as string));
    expect([...ids].filter((i) => Buffer.byteLength(i) > 63)).toEqual([]);
  });
  it("user_decisions: starts PENDING, only workflow_state may change, final states are final, no delete or truncate", () => {
    expect(sql).toContain('CREATE TRIGGER "user_decisions_guard" BEFORE INSERT OR UPDATE ON "user_decisions"');
    expect(sql).toContain("a decision must start PENDING"); expect(sql).toContain("only workflow_state of a decision may change"); expect(sql).toContain("a decision in a final state cannot change");
    for (const col of ["outcome", "user_id", "account_id", "candidate_id", "explanation", "valid_from", "valid_until", "risk_decision_id", "supersedes_id"]) expect(sql, col).toMatch(new RegExp(`NEW\\.${col} (<>|IS DISTINCT FROM) OLD\\.${col}`));
    expect(sql).toContain('CREATE TRIGGER "user_decisions_no_delete" BEFORE DELETE ON "user_decisions"'); expect(sql).toContain('CREATE TRIGGER "user_decisions_no_truncate" BEFORE TRUNCATE ON "user_decisions"');
  });
  it("the runtime and bot roles cannot write decisions until the Stage 07 doors exist (revoke here, read-only in app-role.sql)", () => {
    expect(sql).toMatch(/ARRAY\['user_decisions', 'user_decision_events'\]/); expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER");
    const role = readFileSync("infrastructure/staging/app-role.sql", "utf8"); const ro = /read_only text\[\] := ARRAY\[([^\]]*)\]/.exec(role)?.[1] ?? "";
    for (const t of ["user_decisions", "user_decision_events"]) expect(ro, t).toContain(`'${t}'`);
  });
  it("a shared performance snapshot can be written only with no user context", () => {
    expect(sql).toMatch(/performance_snapshots_shared_or_owner" ON "performance_snapshots" USING \(user_id is null or user_id = .*\) WITH CHECK \(\(user_id is null and nullif\(current_setting\('twins.user_id', true\), ''\)::uuid is null\) or user_id = /);
  });
  it("independent playbooks have unique names too (a nullable unique index alone would allow duplicates)", () => { expect(sql).toContain('CREATE UNIQUE INDEX "strategy_playbooks_independent_name_unique" ON "strategy_playbooks" USING btree ("name") WHERE "strategy_playbooks"."telegram_source_id" is null'); });
});

describe("withUser (F5, migration 0049: the database binds the user)", () => {
  const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
  const dbReturning = (uid: string | null, calls: string[]) => ({ transaction: async (f: (tx: unknown) => Promise<unknown>) => f({ execute: async () => { calls.push("bind"); return { rows: uid ? [{ uid }] : [] }; } }) }) as never;
  it("with no request credential it binds the named user through the system door, then runs the callback", async () => {
    const calls: string[] = [];
    const out = await withUser(dbReturning(U, calls), U, async () => { calls.push("body"); return 42; });
    expect(out).toBe(42); expect(calls).toEqual(["bind", "body"]);
  });
  it("inside a request it binds by the caller's own session token and refuses a different requested user", async () => {
    const seen: unknown[] = [];
    const db = { transaction: async (f: (tx: unknown) => Promise<unknown>) => f({ execute: async (q: unknown) => { seen.push(JSON.stringify(q)); return { rows: [{ uid: U }] }; } }) } as never;
    const token = "tws_" + "A".repeat(43);
    await runWithSessionCredential(token, async () => { expect(hasSessionCredential()).toBe(true); await expect(withUser(db, U, async () => "ok")).resolves.toBe("ok"); await expect(withUser(db, V, async () => "no")).rejects.toThrow(/does not match/); });
    expect(seen.some((q) => String(q).includes("twins_bind_session"))).toBe(true);
    expect(hasSessionCredential()).toBe(false);
  });
  it("fails closed when the database returns no bound identity, and never runs the callback", async () => {
    let ran = false;
    await expect(withUser(dbReturning(null, []), U, async () => { ran = true; })).rejects.toThrow(/does not match/); expect(ran).toBe(false);
  });
  it("refuses a non-UUID user id before touching the database", async () => {
    let touched = false; const db = { transaction: async () => { touched = true; } } as never;
    await expect(withUser(db, "x'; drop table users;--", async () => 1)).rejects.toThrow(/UUID/); expect(touched).toBe(false);
  });
});
