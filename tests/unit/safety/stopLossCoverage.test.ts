import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ELIGIBLE_STATES } from "../../../packages/stop-loss/src/index";

/**
 * Architectural guard for the mandatory stop-loss invariant (Stage 1 / Task 4). It fails when a NEW path appears that can produce an
 * approval-class or execution-eligible state without going through the shared rule in @twins/stop-loss, so the rule cannot be bypassed by omission.
 * If this test fails because you legitimately added a state or a writer: route it through validateStopLoss / assertStopLossAllowsEligibility, extend the
 * database invariant (migration), THEN update the allow-lists below in the same change.
 */
const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*|#)/.test(l)).join("\n");

function sources(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (["node_modules", "dist", "tests", "__pycache__", "drizzle"].includes(name)) continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.ts$/.test(name)) out.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
const ALL = sources(["apps", "services", "packages", "adapters", "scripts"]);

describe("no approval-class state is produced outside the audited places", () => {
  const STATES = /["'`](APPROVE|QUALIFIED|CONDITIONAL)["'`]/;
  /** The ONLY non-test files that may mention an approval-class state literal, and why. */
  const ALLOWED: Record<string, string> = {
    "packages/database/src/schema/enums.ts": "the outcome enum definition",
    "packages/decision-intelligence/src/types.ts": "the outcome type",
    "packages/decision-intelligence/src/decide.ts": "the single producer of APPROVE (guarded by assertStopLossAllowsEligibility)",
    "packages/stop-loss/src/eligibility.ts": "the eligibility lists and the invariant",
  };
  it("only the allow-listed files contain APPROVE / QUALIFIED / CONDITIONAL as a state", () => {
    const hits = ALL.filter((f) => STATES.test(strip(read(f))));
    expect(hits.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  it("the producer routes through the shared rule and cannot return before the final guard", () => {
    const decide = strip(read("packages/decision-intelligence/src/decide.ts"));
    expect(decide).toContain('from "@twins/stop-loss"');
    const guard = decide.indexOf("assertStopLossAllowsEligibility(outcome, structural.stopLoss)");
    expect(guard).toBeGreaterThan(-1);
    const lastAssign = decide.lastIndexOf("outcome = ");
    expect(guard).toBeGreaterThan(lastAssign); // after the last place an outcome is decided
    expect(decide.slice(guard)).toMatch(/^[^]*?return \{\s*signalId: signal\.id,\s*outcome,/); // and the next return is the final one
    expect(decide.slice(guard).match(/\breturn\b/g)?.length).toBe(1);
    // the early structural REJECT return is the only other return and it is a REJECT
    expect(decide.slice(0, guard)).toMatch(/outcome: "REJECT",\s*stopLoss: structural\.stopLoss/);
  });
  it("structural validation, the options assessment and the review bot all use the shared rule (not a private copy)", () => {
    expect(strip(read("packages/decision-intelligence/src/structuralValidation.ts"))).toMatch(/validateStopLoss\(/);
    expect(strip(read("packages/signals/src/options/assess.ts"))).toMatch(/validateOptionsClaimStopLoss\(/);
    expect(strip(read("services/approval-bot/src/card.ts"))).toMatch(/validateOptionsClaimStopLoss\(/);
    expect(strip(read("services/approval-bot/src/bot.ts"))).toMatch(/claimHasValidStopLoss\(claimRow\.claim\)/);
  });
  it("persisting a verdict asserts the invariant and appends the stop-loss evidence BEFORE the verdict row", () => {
    const persist = strip(read("packages/decision-intelligence/src/persist.ts"));
    const assertAt = persist.indexOf("assertStopLossAllowsEligibility(result.outcome, result.stopLoss)");
    const evidenceAt = persist.indexOf("recordStopLossEvidence(");
    const insertAt = persist.indexOf(".insert(schema.signalValidations)");
    expect(assertAt).toBeGreaterThan(-1);
    expect(evidenceAt).toBeGreaterThan(assertAt);
    expect(insertAt).toBeGreaterThan(evidenceAt);
  });
  it("the options-claim writer records the evidence of the claim it just created", () => {
    expect(strip(read("packages/signals/src/options/persist.ts"))).toMatch(/recordStopLossEvidence\(db, \{ kind: "options_claim"/);
  });
});

describe("the database enforces the same invariant, for every execution-eligible state that exists", () => {
  const enums = strip(read("packages/database/src/schema/enums.ts"));
  const outcomeEnum = /signalValidationOutcomeEnum = pgEnum\("signal_validation_outcome", \[([^\]]*)\]/.exec(enums)?.[1] ?? "";
  const values = [...outcomeEnum.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
  const migration = read("packages/database/drizzle/0011_stop_loss_validations.sql");

  it("the verdict enum is exactly the reviewed set (adding a state forces a review of this test and of the database trigger)", () => {
    expect(values.sort()).toEqual(["APPROVE", "INSUFFICIENT_EVIDENCE", "REJECT"]);
  });
  it("every execution-eligible state that is a verdict value is covered by the signal_validations trigger", () => {
    const eligibleValues = values.filter((v) => (EXECUTION_ELIGIBLE_STATES as readonly string[]).includes(v));
    expect(eligibleValues).toEqual(["APPROVE"]);
    for (const state of eligibleValues) expect(migration).toContain(`NEW.outcome = '${state}'`);
    expect(migration).toContain("ENABLE ALWAYS TRIGGER \"signal_validations_stop_loss_invariant\"");
  });
  it("CONDITIONAL / QUALIFIED are not verdict values anywhere in the schema (if one is added it needs the rule and the trigger first)", () => {
    expect(enums).not.toMatch(/CONDITIONAL|QUALIFIED/);
  });
});

describe("nothing can reach an executable decision, risk decision or order today (future paths must be added consciously)", () => {
  // Stage 3 / Task 1: risk_decisions now has exactly ONE writer, the risk-decision module. Everything else stays forbidden.
  const RISK_DECISION_WRITER = "packages/risk/src/riskDecisions.ts";
  it("no production code inserts into decisions, orders, fills or positions", () => {
    const offenders = ALL.filter((f) => /\.insert\(\s*schema\.(decisions|orders|fills|positions)\b/.test(strip(read(f))) || /insert into (decisions|orders|fills|positions)\b/i.test(strip(read(f))));
    expect(offenders).toEqual([]);
  });
  it("only the risk-decision module writes risk_decisions (and it is the one file that does)", () => {
    const writers = ALL.filter((f) => /\.insert\(\s*schema\.riskDecisions\b/.test(strip(read(f))) || /insert into risk_decisions\b/i.test(strip(read(f))));
    expect(writers.map((f) => f.replace(/\\/g, "/").replace(/^.*?(packages\/risk\/src\/riskDecisions\.ts)$/, "$1"))).toEqual([RISK_DECISION_WRITER]);
  });
  it("the shared rule package has no dependencies and no I/O", () => {
    const pkg = JSON.parse(read("packages/stop-loss/package.json")) as { dependencies?: unknown };
    expect(pkg.dependencies).toBeUndefined();
    for (const f of sources(["packages/stop-loss/src"])) expect(strip(read(f)), f).not.toMatch(/\bfetch\(|node:fs|node:net|node:http|process\.env\b[^\n]*\n[^\n]*validate/);
  });
});
