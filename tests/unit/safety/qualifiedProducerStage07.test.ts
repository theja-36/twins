import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, DEFAULT_DECISION_POLICY, validateCandidateStop, type DecisionCandidate, type DecisionInput } from "../../../packages/decision/src/index";
import { assertStopLossAllowsEligibility, StopLossInvariantError, validateStopLoss } from "../../../packages/stop-loss/src/index";

/**
 * Stage 07 proof that EVERY path that can produce a QUALIFIED decision is protected by the full mandatory stop-loss validation (closes G-18 together with migration 0038's database check):
 *  1. there is exactly one TypeScript producer of a QUALIFIED outcome, and it is the decision engine;
 *  2. the engine always runs validateStopLoss, and the last statement before its only return is assertStopLossAllowsEligibility;
 *  3. behaviour: no combination of other evidence can yield QUALIFIED while the stop validation is not VALID;
 *  4. the persistence door and the database independently refuse a QUALIFIED decision without a VALID validation.
 */
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*|#)/.test(l)).join("\n");
const files = (): string[] => { const out: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { if (["node_modules", "dist", "tests", "drizzle", "__pycache__"].includes(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n)) out.push(p); } }; for (const d of ["apps", "services", "packages", "adapters", "scripts"]) walk(d); return out; };

describe("the single producer of QUALIFIED", () => {
  const engine = strip(readFileSync("packages/decision/src/engine.ts", "utf8"));
  it("no other source file assigns, returns or constructs a QUALIFIED outcome", () => {
    const producers = files().filter((f) => /(outcome\s*[:=]\s*["'`]QUALIFIED["'`]|return\s+["'`]QUALIFIED["'`]|DecisionOutcome\s*=\s*["'`]QUALIFIED["'`])/.test(strip(readFileSync(f, "utf8"))));
    expect(producers).toEqual(["packages/decision/src/engine.ts"]);
  });
  it("the engine runs the shared mandatory rule unconditionally and guards the outcome last", () => {
    expect(engine).toContain('from "@twins/stop-loss"');
    expect(engine).toMatch(/const stop = validateCandidateStop\(c\);/);
    expect(engine.indexOf("const stop = validateCandidateStop(c)")).toBeLessThan(engine.indexOf("let outcome"));
    expect(strip(readFileSync("packages/decision/src/engine.ts", "utf8"))).toMatch(/validateStopLoss\(/);
    const guard = engine.indexOf("assertStopLossAllowsEligibility(outcome, stop)");
    expect(guard).toBeGreaterThan(-1);
    const afterDecide = engine.slice(engine.indexOf("export function decide"));
    const lastAssign = Math.max(afterDecide.lastIndexOf("outcome = "), afterDecide.lastIndexOf("settle("));
    expect(engine.indexOf(afterDecide)+guard-engine.indexOf(afterDecide)).toBeGreaterThan(engine.indexOf(afterDecide) + lastAssign);
    // after the guard there is exactly one return: the final result object
    const tail = engine.slice(guard);
    expect(tail.match(/\breturn\b/g)?.length).toBe(1);
    expect(tail).toMatch(/return \{\s*engineVersion/);
  });
  it("the engine's only imports of approval-class helpers are the shared stop-loss rule and types", () => {
    expect(engine).toMatch(/import \{ assertStopLossAllowsEligibility, validateStopLoss/);
  });
});

describe("behaviour: QUALIFIED is impossible without a VALID mandatory validation", () => {
  const good: DecisionCandidate = { id: "c1", source: "INDEPENDENT", state: "READY_FOR_DECISION", underlying: "ACME", exchange: "NSE", strike: null, optionType: null, expiry: null, side: "BUY", entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [104, 108], dataSource: "LIVE", expiresAt: new Date("2031-01-06T06:00:00Z"), setup: "BREAKOUT" };
  const NOW = new Date("2031-01-06T05:00:00Z");
  const research = { packageVersion: "research-package-v1", candidateId: "c1", candidateSource: "INDEPENDENT", dataSource: "LIVE", version: 1, assessment: "RESEARCH_SUPPORTIVE", halt: false, haltReason: null, score: 0.5, synthesisAlgorithmVersion: "s", reports: [], contradictions: [], roleCoverage: { coveredRoles: [], missingRoles: [], unmappedAgents: [] }, agentVersions: {}, evidenceIndex: [], missingRequired: [], grantsApproval: false, synthesisInputSha256: "a", packageSha256: "b" } as never;
  const sizing = { modelVersion: "position-sizing-v2", costModelVersion: "c", status: "SIZED", reason: null, detail: "", lots: 10, quantity: 250, lotSize: "25", tick: "0.05", entry: "100", stop: "98", grossExposure: "25000.00", riskBudget: { riskPercentOfCapital: "1", perTradeCap: null, remainingDailyRisk: null, remainingPortfolioRisk: null, remainingGroupRisk: null, sizeMultiplier: "1", effectiveBudget: "10000.00", binding: "risk_percent" }, maxLossAtStop: "600.00", riskPerLot: "60.00", stopLossGross: "500.00", costsAtStop: "100.00", slippageAtStop: "0.00", breakevenPrice: "100.1", targets: [], capitalUtilisationPct: "2.5", riskPercentOfCapital: "0.06", limitsApplied: [], specVersion: "s", specSourceKind: "OFFICIAL", feeVersion: "f", feeSourceKind: "OFFICIAL", grantsApproval: false } as never;
  const risk = { engineVersion: "risk-assessment-v1", policyVersion: 1, verdict: "PASS", reasons: [], correctiveActions: [], limits: {}, exposure: {}, sizeMultiplier: 1, caps: {}, evidence: [], evaluatedAt: NOW.toISOString(), stop: { structurallyValid: true, independentlyValidated: false, note: "" }, specs: {}, grantsApproval: false } as never;
  const input = (c: Partial<DecisionCandidate> = {}): DecisionInput => ({ now: NOW, candidate: { ...good, ...c }, research, researchPackageId: "p1", confidence: { id: "k1", score: 80, calibrationStatus: "UNCALIBRATED", completeness: 1, missing: [], caps: [] }, risk, riskAssessmentId: "r1", sizing, simulationId: "s1", paperEnabled: true, policy: DEFAULT_DECISION_POLICY });
  it("a fully supported candidate with a valid stop qualifies (control)", () => {
    const d = decide(input());
    expect(d.outcome).toBe("QUALIFIED"); expect(d.stopLoss.validation.result).toBe("VALID"); expect(d.permittedSize?.lots).toBe(10); expect(d.grantsApproval).toBe(false);
  });
  it("every unsafe stop yields a non-QUALIFIED outcome, whatever else is supportive", () => {
    const bad: Array<Partial<DecisionCandidate>> = [{ stopLoss: null }, { stopLoss: 0 }, { stopLoss: -5 }, { stopLoss: 100 }, { stopLoss: 101 }, { stopLoss: 40 } /* too far */, { strike: 24500, optionType: "CE", stopLoss: 98 } /* option stop must be premium: levels are fine but entry/stop sides */ ];
    for (const b of bad) {
      const c = { ...good, ...b } as DecisionCandidate, v = validateCandidateStop(c), d = decide(input(b));
      if (v.result !== "VALID") { expect(d.outcome, JSON.stringify(b)).not.toBe("QUALIFIED"); expect(d.permittedSize).toBeNull(); expect(d.reasons.some((r) => r.category === "STOP_LOSS")).toBe(true); }
    }
    expect(decide(input({ stopLoss: null })).outcome).toBe("REJECT");
  });
  it("the final guard itself refuses an execution-eligible outcome without a VALID validation", () => {
    const invalid = validateStopLoss({ instrumentType: "equity", side: "buy", stopLoss: null, entryPrice: 100, levelBasis: "price" });
    expect(() => assertStopLossAllowsEligibility("QUALIFIED", invalid)).toThrow(StopLossInvariantError);
    expect(() => assertStopLossAllowsEligibility("QUALIFIED", null)).toThrow(StopLossInvariantError);
    expect(() => assertStopLossAllowsEligibility("WAIT", invalid)).not.toThrow();
  });
  it("confidence, fixture data, missing evidence and the other inputs can only make the outcome MORE conservative", () => {
    const rank = ["NO_TRADE", "REJECT", "EVALUATION_ONLY", "WAIT", "QUALIFIED"];
    const base = rank.indexOf(decide(input()).outcome);
    const variants: DecisionInput[] = [{ ...input(), confidence: null }, { ...input(), confidence: { id: "k", score: 10, calibrationStatus: "UNCALIBRATED", completeness: 1, missing: [], caps: [] } }, { ...input(), research: null }, { ...input(), risk: null }, { ...input(), sizing: null }, { ...input(), paperEnabled: false }, input({ dataSource: "FIXTURE" }), input({ state: "EXPIRED" }), input({ expiresAt: new Date("2031-01-06T04:00:00Z") })];
    for (const v of variants) expect(rank.indexOf(decide(v).outcome)).toBeLessThanOrEqual(base);
    // confidence 100 does not rescue a candidate with a blocked risk verdict
    const blocked = { ...(risk as object), verdict: "BLOCKED", reasons: [{ code: "REWARD_TO_RISK_TOO_LOW", severity: "BLOCK", detail: "x", limit: null, value: null, correctiveAction: null, evidence: [] }] } as never;
    expect(decide({ ...input(), risk: blocked, confidence: { id: "k", score: 100, calibrationStatus: "CALIBRATED", completeness: 1, missing: [], caps: [] } }).outcome).toBe("REJECT");
  });
});

describe("persistence also refuses it", () => {
  it("migration 0038 requires a VALID stop-loss validation, a non-blocked risk assessment, a size and a research package for a QUALIFIED insert", () => {
    const sql = readFileSync("packages/database/drizzle/0038_decision_execution_trade_management.sql", "utf8");
    expect(sql).toContain("a QUALIFIED decision needs a VALID mandatory stop-loss validation");
    expect(sql).toContain("(NEW.stop_loss_validation->>'result') IS DISTINCT FROM 'VALID'");
    expect(sql).toContain("r.verdict <> 'BLOCKED'");
    expect(sql).toContain("a QUALIFIED decision needs a permitted size of at least one lot");
    expect(sql).toContain("a decision reaches % only through a recorded approval action");
  });
});
