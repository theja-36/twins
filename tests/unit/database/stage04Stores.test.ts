import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("Stage 04 stores write only their own table", () => {
  // the research package store writes a package and, in the same transaction, that package's agent runs (G-44): exactly these two tables, in this order
  const stores: Array<[string, string[]]> = [["packages/database/src/stores/marketRegimeStore.ts", ["marketRegimes"]], ["packages/database/src/stores/researchPackageStore.ts", ["researchPackages", "researchAgentRuns"]], ["packages/database/src/stores/aiUsageStore.ts", ["aiUsageRecords"]]];
  for (const [file, table] of stores) {
    it(`${file.split("/").pop()} inserts only ${table.join(" and ")}, never updates or deletes`, () => {
      const s = code(file);
      expect([...s.matchAll(/\.insert\((\w+)\)/g)].map((m) => m[1])).toEqual(table);
      expect(s).not.toMatch(/\.update\(|\.delete\(|truncate/i);
    });
  }
  it("the AI usage table and store hold no prompt or response text", () => {
    const cols = code("packages/database/src/schema/aiUsage.ts") + code("packages/database/src/stores/aiUsageStore.ts");
    expect(cols).not.toMatch(/\b(prompt_text|response|completion|messageText|message_text|content)\b/i);
  });
});
describe("migration 0035", () => {
  const sql = read("packages/database/drizzle/0035_ai_usage_records.sql");
  it("creates one table, append-only, with shared-or-owner row-level security", () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('CREATE TRIGGER "ai_usage_records_no_update_delete"'); expect(sql).toContain('CREATE TRIGGER "ai_usage_records_no_truncate"');
    expect(sql).toContain('ALTER TABLE "ai_usage_records" FORCE ROW LEVEL SECURITY'); expect(sql).toContain('"ai_usage_records_shared_or_owner"');
    expect(sql).not.toMatch(/DROP |ALTER TABLE "(?!ai_usage_records)/); // additive only
  });
  it("is in the journal as entry 35", () => {
    const j = JSON.parse(read("packages/database/drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; tag: string }> };
    expect(j.entries[35]).toMatchObject({ idx: 35, tag: "0035_ai_usage_records" });
  });
});
describe("AI gateway source hygiene", () => {
  const files = ["provider", "prompts", "gateway", "narrative"].map((f) => code(`packages/ai/src/gateway/${f}.ts`)).join("\n");
  it("makes no network call, reads no environment and imports no broker, database, agent or risk code", () => {
    expect(files).not.toMatch(/\bfetch\(|XMLHttpRequest|node:https?|node:net|process\.env|axios|undici/);
    expect(files).not.toMatch(/from "@twins\/(database|agents|risk|broker|execution|ingestion|signals)/);
  });
  it("cannot touch capital, limits, permissions, orders or decisions", () => {
    expect(files).not.toMatch(/\b(placeOrder|submitOrder|positionSize|killSwitch|approve|stopLoss|capital)\b/i);
  });
});
