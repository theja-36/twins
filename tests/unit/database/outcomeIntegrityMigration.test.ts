import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Static checks of migration 0046 (Stage 08: A1 exactly-one trade outcome per paper position; A2 reproducible analytics snapshots). The behaviour is proven on PostgreSQL in tests/integration/outcomes/*. */
const DIR = join(__dirname, "../../../packages/database/drizzle"), sql = readFileSync(join(DIR, "0046_outcome_integrity_analytics_snapshots.sql"), "utf8");
describe("migration 0046: outcome integrity and analytics snapshots", () => {
  it("makes a paper position's trade outcome unique, and refuses to run on data that already violates it", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "trade_outcomes_paper_position_unique" ON "trade_outcomes" USING btree ("paper_position_id") WHERE "trade_outcomes"."paper_position_id" is not null');
    expect(sql).toMatch(/PRE-FLIGHT[\s\S]*HAVING count\(\*\) > 1[\s\S]*migration 0046 refused/);
    expect(sql.indexOf("PRE-FLIGHT")).toBeLessThan(sql.indexOf("CREATE UNIQUE INDEX \"trade_outcomes_paper_position_unique\"")); // the check runs BEFORE the index is built
  });
  it("creates analytics_snapshots: paper-only, known creators, hash-shaped, one row per (user, input hash)", () => {
    for (const c of ["analytics_snapshots_mode_check", "analytics_snapshots_creator_check", "analytics_snapshots_hash_check"]) expect(sql).toContain(c);
    expect(sql).toContain('"mode" = \'PAPER\''); expect(sql).toContain("^[0-9a-f]{64}$");
    expect(sql).toContain('CREATE UNIQUE INDEX "analytics_snapshots_input_unique" ON "analytics_snapshots" USING btree ("user_id","input_hash")');
    for (const col of ["evidence_hash", "input_hash", "algorithm_versions", "config", "config_hash", "watermarks", "report", "report_sha256", "as_of", "created_by", "created_at"]) expect(sql).toContain(`"${col}"`);
  });
  it("is append-only and protected by forced owner-only row-level security", () => {
    expect(sql).toContain('CREATE TRIGGER "analytics_snapshots_no_update_delete" BEFORE UPDATE OR DELETE ON "analytics_snapshots"'); // the name the runtime-role grant loop recognises
    expect(sql).toContain('CREATE TRIGGER "analytics_snapshots_no_truncate" BEFORE TRUNCATE ON "analytics_snapshots"');
    expect(sql).toContain('ALTER TABLE "analytics_snapshots" FORCE ROW LEVEL SECURITY'); expect(sql).toContain('CREATE POLICY "analytics_snapshots_owner_only"');
    expect(sql).toMatch(/USING \(user_id = nullif\(current_setting\('twins\.user_id', true\), ''\)::uuid\) WITH CHECK/);
  });
  it("leaves the existing performance_snapshots table and every decision, approval and execution table alone", () => {
    expect(sql).not.toMatch(/performance_snapshots|user_decision_approvals|paper_orders|paper_positions|paper_fills|risk_limits|system_controls/);
  });
  it("is in the journal right after 0045, in order, with its snapshot, and the rollback is documented", () => {
    const journal = JSON.parse(readFileSync(join(DIR, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
    const i = journal.entries.findIndex((e) => e.tag === "0046_outcome_integrity_analytics_snapshots"), cur = journal.entries[i]!, prev = journal.entries[i - 1]!;
    expect(i).toBeGreaterThan(0); expect(prev.tag).toBe("0045_decision_watches"); expect(cur.when).toBeGreaterThan(prev.when);
    expect(existsSync(join(DIR, "meta/0046_snapshot.json"))).toBe(true);
    expect(readFileSync(join(__dirname, "../../../scripts/product/append-0046.py"), "utf8")).toMatch(/Rollback \(forward-only/);
  });
});
