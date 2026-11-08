import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DECISION_OUTCOMES, checkExecutionGate, mayEnterApproval, type GateInput } from "../../../packages/types/src/platform/index";

/**
 * Proof that the three files added to the stop-loss allow-list (ADR-010) cannot PRODUCE a QUALIFIED decision or bypass the mandatory-stop rule:
 *  1. static: every QUALIFIED literal in them is vocabulary, a comparison, or part of a database CHECK/guard - never an assignment, return value or object field;
 *  2. behavioural: the gate and mayEnterApproval only consume an outcome; nothing here returns one;
 *  3. structural: no source file writes the user_decisions table (no producer exists), and the database refuses a QUALIFIED row without a stop-loss.
 * The existing assertions in stopLossCoverage.test.ts are untouched.
 */
const FILES = ["packages/types/src/platform/decision.ts", "packages/types/src/platform/execution.ts", "packages/database/src/schema/userDecisions.ts"];
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");
const LITERAL = /["'`]QUALIFIED["'`]/g;

describe("the allow-listed master-build files cannot produce a QUALIFIED decision", () => {
  for (const f of FILES) {
    it(`${f}: every QUALIFIED literal is vocabulary, a comparison or a CHECK, never a produced value`, () => {
      const code = strip(readFileSync(f, "utf8"));
      const hits = [...code.matchAll(LITERAL)];
      expect(hits.length, f).toBeGreaterThan(0);
      for (const m of hits) {
        const i = m.index ?? 0, before = code.slice(Math.max(0, i - 40), i), after = code.slice(i + m[0].length, i + m[0].length + 20);
        const inSqlCheck = /sql`/.test(code.slice(Math.max(0, i - 220), i)) && /\$\{t\.outcome\}\s*=\s*$/.test(before) && m[0].startsWith("'"); // SQL equality inside a CHECK template
        const ok = /=\s*\[\s*$/.test(before) /* const X = ["QUALIFIED", ...] */
          || /(===|!==)\s*$/.test(before) /* comparison */
          || /\|\s*$/.test(before) || /^\s*\|/.test(after) /* type union member */
          || inSqlCheck;
        expect(ok, `${f}: unclassified QUALIFIED use near: ${before.trim()} ${m[0]} ${after.trim()}`).toBe(true);
      }
      expect(code, f).not.toMatch(/return\s+["'`]QUALIFIED["'`]/);
      expect(code, f).not.toMatch(/outcome\s*[:=]\s*["'`]QUALIFIED["'`]/); // no assignment or object field; the sql CHECK uses SQL equality inside a template (checked above)
    });
  }
  it("mayEnterApproval and the execution gate only consume an outcome", () => {
    expect(DECISION_OUTCOMES.filter(mayEnterApproval)).toEqual(["QUALIFIED"]);
    const base: GateInput = { mode: "PAPER", liveExecutionEnabled: false, paperEnabled: true, userPermitsMode: true, killSwitchActive: false, riskRecheckPassed: true, decisionState: "APPROVED", decisionOutcome: "QUALIFIED", orderConfirmationId: null, autoPolicyId: null, brokerAndRegulatoryGatesVerified: false };
    // exhaustive over every outcome x state: the gate is open only for QUALIFIED + APPROVED; the result type carries no outcome
    for (const o of DECISION_OUTCOMES) for (const s of ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const) {
      const r = checkExecutionGate({ ...base, decisionOutcome: o, decisionState: s });
      expect(r.allowed, `${o}/${s}`).toBe(o === "QUALIFIED" && s === "APPROVED");
      expect(Object.keys(r).sort()).toEqual(["allowed", "reasons"]);
    }
  });
  it("Stage 07: user_decisions is written only through the audited database doors, called from exactly one TypeScript store", () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { if (["node_modules", "dist", "drizzle"].includes(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n)) out.push(p); } };
    for (const d of ["apps", "services", "packages", "adapters", "scripts"]) walk(d);
    const users = out.filter((f) => /\buserDecisions\b|\buser_decisions\b/.test(readFileSync(f, "utf8"))).sort();
    // schema definitions (and the tables that reference the decision by foreign key) plus the ONE store that calls the database doors and reads decisions
    expect(users).toEqual(["packages/database/src/schema/index.ts", "packages/database/src/schema/learning.ts", "packages/database/src/schema/tradeExecution.ts", "packages/database/src/schema/userDecisions.ts", "packages/database/src/stores/decisionStore.ts"]);
    for (const f of out) { const code = strip(readFileSync(f, "utf8")); expect(code, f).not.toMatch(/insert\s+into\s+user_decisions|update\s+user_decisions|delete\s+from\s+user_decisions|\.insert\(\s*userDecisions|\.update\(\s*userDecisions/i); }
    const door = out.filter((f) => /twins_create_user_decision/.test(readFileSync(f, "utf8"))).sort();
    expect(door).toEqual(["packages/database/src/stores/decisionStore.ts"]);
    const callers = out.filter((f) => /\bcreateDecision\(/.test(strip(readFileSync(f, "utf8")))).sort();
    expect(callers).toEqual(["packages/database/src/stores/decisionStore.ts", "packages/decision/src/cycle.ts"]);
  });
  it("the migration refuses a QUALIFIED decision without a positive stop-loss, an APPROVED insert, and an outcome change", () => {
    const sql = readFileSync("packages/database/drizzle/0033_master_build_platform.sql", "utf8");
    expect(sql).toContain("c.stop_loss IS NOT NULL AND c.stop_loss > 0"); expect(sql).toContain("a QUALIFIED decision needs a candidate with a stop-loss");
    expect(sql).toContain("a decision must start PENDING"); expect(sql).toMatch(/NEW\.outcome <> OLD\.outcome/);
  });
  it("the original stop-loss producer is untouched in shape: decide.ts still gates through assertStopLossAllowsEligibility", () => {
    const decide = strip(readFileSync("packages/decision-intelligence/src/decide.ts", "utf8"));
    expect(decide).toContain("assertStopLossAllowsEligibility(outcome, structural.stopLoss)");
  });
});
