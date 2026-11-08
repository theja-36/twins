import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The strategy/ subsystem is research-side learning storage. It may write ONLY its own five tables (playbooks, playbook versions, learning versions and their events, drift events) and must never touch the live pipeline, risk, approval, order or broker code. */
const DIR = "packages/historical/src/strategy";
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => [f, strip(readFileSync(join(DIR, f), "utf8"))] as const);

describe("strategy storage is confined", () => {
  it("inserts and updates only playbook and learning-version tables", () => {
    const code = files.map(([, c]) => c).join("\n");
    const inserted = [...new Set([...code.matchAll(/\.insert\(\s*(?:schema\.)?(\w+)\)/g)].map((m) => m[1]))].sort();
    expect(inserted).toEqual(["E", "L", "P", "strategyDriftEvents", "strategyPlaybooks"]); // E, L, P are the aliases checked below
    const updated = [...new Set([...code.matchAll(/\.update\(\s*(\w+)\)/g)].map((m) => m[1]))].sort(); expect(updated).toEqual(["L", "P"]);
    expect(code).toMatch(/const P = schema\.playbookVersions, L = schema\.learningVersions, E = schema\.learningVersionEvents/); // the aliases are exactly these tables
  });
  it("never names a live table, a risk/approval/execution package, a broker, the network or logging", () => {
    for (const [f, c] of files) {
      expect(c, f).not.toMatch(/schema\.(telegramMessages|signals|optionsClaims|riskDecisions|riskApprovals|riskApprovalCards|orders|fills|positions|decisions|userDecisions|auditEvents|systemControls|paperTrades)\b/);
      expect(c, f).not.toMatch(/@twins\/(risk|runtime-state|adapter|ingestion|kite|paper)|zerodha|broker|api\.telegram\.org|fetch\(|node:https?|node:net|console\./i);
    }
  });
  it("the profile and rule code is pure: no database import outside playbook.ts", () => { for (const [f, c] of files) if (f !== "playbook.ts") expect(c, f).not.toMatch(/@twins\/database|drizzle-orm/); });
});
