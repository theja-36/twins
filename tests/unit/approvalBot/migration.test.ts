import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadExpectedMigrations } from "../../integration/migrationState";

const DIR = "packages/database/drizzle";
const TAG = "0008_approval_bot_review_log";
const sql = readFileSync(`${DIR}/${TAG}.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };

describe("migration 0008 (approval bot)", () => {
  it("is the 9th ledger entry, idx 8, after 0007, and its content hash is pinned (a changed file would break every database that applied it)", () => {
    expect(journal.entries[8]).toMatchObject({ idx: 8, tag: TAG, when: 1792856153526 });
    expect(journal.entries[8]!.when).toBeGreaterThan(journal.entries[7]!.when);
    expect(createHash("sha256").update(sql).digest("hex")).toBe("d9a1a2809e3725e001dab888175beb116d018fb83c45fbadf10c03353fe1fc28");
    expect(loadExpectedMigrations()[8]?.hash).toBe(createHash("sha256").update(sql).digest("hex"));
  });
  it("creates only the four bot tables and touches no existing table", () => {
    const created = [...sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(["approval_bot_events", "approval_bot_state", "claim_review_cards", "claim_reviews"]);
    expect(sql).not.toMatch(/ALTER TABLE "(?:options_claims|telegram_messages|telegram_sources|signals)"\s+(?:ADD|DROP|ALTER)/);
    expect(sql).not.toMatch(/DROP |TRUNCATE TABLE|DELETE FROM|UPDATE "/);
  });
  it("makes the review log and event log append-only with row and truncate triggers", () => {
    for (const t of ["claim_reviews", "approval_bot_events"]) {
      expect(sql).toContain(`CREATE TRIGGER "${t}_no_update_delete" BEFORE UPDATE OR DELETE ON "${t}" FOR EACH ROW`);
      expect(sql).toContain(`CREATE TRIGGER "${t}_no_truncate" BEFORE TRUNCATE ON "${t}" FOR EACH STATEMENT`);
    }
    expect(sql).toMatch(/RAISE EXCEPTION[^;]*USING ERRCODE = 'restrict_violation'/s);
  });
});
