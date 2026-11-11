import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Static checks of migration 0045 (Stage 07, G-27: decision WATCH / UNWATCH). Behaviour is proven on PostgreSQL in tests/integration/trading/stage07Hardening.test.ts. */
const DIR = join(__dirname, "../../../packages/database/drizzle"), sql = readFileSync(join(DIR, "0045_decision_watches.sql"), "utf8");
describe("migration 0045: decision watches", () => {
  it("creates an owner-tied, idempotent, action-checked table", () => {
    expect(sql).toContain('CREATE TABLE "decision_watches"');
    expect(sql).toContain('FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id")');
    expect(sql).toContain("CHECK (\"decision_watches\".\"action\" in ('WATCH', 'UNWATCH'))");
    expect(sql).toContain('CREATE UNIQUE INDEX "decision_watches_user_key_unique"');
  });
  it("is append-only and protected by forced owner-only row-level security", () => {
    expect(sql).toContain('CREATE TRIGGER "decision_watches_no_update_delete" BEFORE UPDATE OR DELETE ON "decision_watches"');
    expect(sql).toContain('CREATE TRIGGER "decision_watches_no_truncate" BEFORE TRUNCATE ON "decision_watches"');
    expect(sql).toContain('ALTER TABLE "decision_watches" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "decision_watches" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY "decision_watches_owner_only"');
  });
  it("touches no approval, order or position table", () => { expect(sql).not.toMatch(/user_decision_approvals|paper_orders|paper_positions|paper_fills/); });
  it("is the last migration in the journal with its snapshot, and the rollback is documented", () => {
    const journal = JSON.parse(readFileSync(join(DIR, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
    const last = journal.entries[journal.entries.length - 1]!, prev = journal.entries[journal.entries.length - 2]!;
    expect(last.tag).toBe("0045_decision_watches"); expect(last.when).toBeGreaterThan(prev.when); expect(existsSync(join(DIR, "meta/0045_snapshot.json"))).toBe(true);
    expect(readFileSync(join(__dirname, "../../../scripts/product/append-0045.py"), "utf8")).toMatch(/Rollback \(forward-only/);
  });
});
