import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("packages/database/drizzle/0041_domain_integrity.sql", "utf8"), role = readFileSync("infrastructure/staging/app-role.sql", "utf8");
describe("migration 0041 (Stage 02 domain integrity), static", () => {
  it("accounts and broker_connections get owner-only forced row-level security", () => {
    for (const t of ["accounts", "broker_connections"]) { expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`); expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`); expect(sql).toContain(`CREATE POLICY "${t}_owner_only"`); }
  });
  it("the unique index precedes the composite foreign key that uses it, and credentials can only be references", () => {
    expect(sql.indexOf('CREATE UNIQUE INDEX "broker_connections_id_user_unique"')).toBeGreaterThan(-1);
    expect(sql.indexOf('CREATE UNIQUE INDEX "broker_connections_id_user_unique"')).toBeLessThan(sql.indexOf('"accounts_broker_owner_fk"'));
    expect(sql).toContain("secretref:");
  });
  it("legacy account-owned tables are protected through the account", () => { for (const t of ["orders", "positions", "portfolio_snapshots", "fills"]) expect(sql).toContain(`CREATE POLICY "${t}_owner_only"`); });
  it("the cross-user listings return identifiers only and are the only way the runtime role lists accounts", () => {
    expect(sql).toMatch(/"twins_list_active_accounts"\(\) RETURNS TABLE \(a_account_id uuid, a_user_id uuid\)/);
    expect(sql).toMatch(/"twins_list_active_account_users"\(p_limit integer\) RETURNS TABLE \(a_user_id uuid\)/);
    expect(role).toContain("twins_list_active_accounts(), twins_list_active_account_users(integer)");
    expect(readFileSync("packages/database/src/stores/planningStore.ts", "utf8")).toContain("twins_list_active_accounts()");
    expect(readFileSync("packages/database/src/stores/outcomeStore.ts", "utf8")).toContain("twins_list_active_account_users(");
  });
  it("the derived views honour the caller's row-level security", () => { expect(sql.match(/WITH \(security_invoker = true\)/g)?.length).toBe(2); });
  it("the decision links guard pins account and candidate for every outcome", () => { expect(sql).toContain("user_decisions_links_guard"); expect(sql).toMatch(/r\.account_id = NEW\.account_id AND r\.candidate_id = NEW\.candidate_id/); expect(sql).toMatch(/s\.account_id = NEW\.account_id AND s\.candidate_id = NEW\.candidate_id/); });
  it("no floating-point money anywhere in the schema sources", () => {
    for (const f of ["tradeExecution", "userDecisions", "userPlatform", "outcomeLearning", "riskControls"]) expect(readFileSync(`packages/database/src/schema/${f}.ts`, "utf8"), f).not.toMatch(/doublePrecision|real\(|float\(/);
  });
});
