import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Static checks of migration 0044 (G-43 run key, G-44 per-agent run records). The behaviour itself is proven on PostgreSQL in tests/integration/opportunity/researchRuns.test.ts (CI). */
const DIR = join(__dirname, "../../../packages/database/drizzle"), sql = readFileSync(join(DIR, "0044_research_run_records.sql"), "utf8");
describe("migration 0044: research run records", () => {
  it("is additive: one new table, one nullable column, no drop, delete, truncate or rewrite of existing data", () => {
    expect(sql).toContain('CREATE TABLE "research_agent_runs"'); expect(sql).toContain('ALTER TABLE "research_packages" ADD COLUMN "run_key" text;');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TRIGGER)\b|\bDELETE\s+FROM\b|\bTRUNCATE\s+TABLE\b|\bUPDATE\s+"[a-z_]+"\s+SET\b/i);
    expect(sql).not.toMatch(/"run_key" text NOT NULL/);
  });
  it("the run key is 64 hex characters and unique per candidate only when present (legacy packages have none)", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "research_packages_candidate_run_key_unique".*\("candidate_id","run_key"\) WHERE .*"run_key" is not null/);
    expect(sql).toMatch(/CHECK \("research_packages"."run_key" is null or "research_packages"."run_key" ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  });
  it("agent runs: restrict-FK to the package, one per agent per package, status/verdict/confidence coherence, size and format checks", () => {
    expect(sql).toMatch(/"research_agent_runs_research_package_id_research_packages_id_fk".*ON DELETE restrict/);
    expect(sql).toContain('CREATE UNIQUE INDEX "research_agent_runs_package_agent_unique"');
    for (const c of ["research_agent_runs_value_check", "research_agent_runs_status_check", "research_agent_runs_size_check"]) expect(sql, c).toContain(c);
    expect(sql).toMatch(/\("research_agent_runs"."status" = 'COMPLETED'\) = \("research_agent_runs"."verdict" <> 'UNAVAILABLE'\)/);
  });
  it("agent runs are append-only: update/delete and truncate are refused by the shared audit trigger", () => {
    expect(sql).toContain('CREATE TRIGGER "research_agent_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "research_agent_runs" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"()');
    expect(sql).toContain('CREATE TRIGGER "research_agent_runs_no_truncate" BEFORE TRUNCATE ON "research_agent_runs" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"()');
  });
  it("is registered in the journal as the last migration with its snapshot, and the rollback is documented", () => {
    const journal = JSON.parse(readFileSync(join(DIR, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
    const last = journal.entries[journal.entries.length - 1]!, prev = journal.entries[journal.entries.length - 2]!;
    expect(last.tag).toBe("0044_research_run_records"); expect(last.when).toBeGreaterThan(prev.when); expect(existsSync(join(DIR, "meta/0044_snapshot.json"))).toBe(true);
    expect(readFileSync(join(__dirname, "../../../scripts/product/append-0044.py"), "utf8")).toMatch(/Rollback \(forward-only/);
  });
});
