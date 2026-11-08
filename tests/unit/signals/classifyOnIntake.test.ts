import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeOptionsText } from "../../../packages/signals/src/options/parse";
import { CLASSIFY_ON_INTAKE_ENV, ClassifyOnIntakeConfigError, classifyClaimOnIntake, loadClassifyOnIntakeFlag } from "../../../packages/signals/src/classification/index";

const claim = (() => { const a = analyzeOptionsText("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96"); if (a.kind !== "options_claim") throw new Error(a.kind); return a.claim; })();
const input = { claimId: "claim-1", claim, messageText: "SECRETWORD BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96", messageTimestamp: new Date("2026-11-09T04:30:00Z") };
const fakeDb = (returning: () => Promise<unknown[]>) => ({ insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }) }) as never;

describe("TWINS_CLASSIFY_ON_INTAKE flag", () => {
  it("is off by default and strict: only true or false (or empty) are accepted", () => {
    expect(CLASSIFY_ON_INTAKE_ENV).toBe("TWINS_CLASSIFY_ON_INTAKE");
    expect(loadClassifyOnIntakeFlag({})).toBe(false); expect(loadClassifyOnIntakeFlag({ TWINS_CLASSIFY_ON_INTAKE: "" })).toBe(false); expect(loadClassifyOnIntakeFlag({ TWINS_CLASSIFY_ON_INTAKE: "false" })).toBe(false);
    expect(loadClassifyOnIntakeFlag({ TWINS_CLASSIFY_ON_INTAKE: "true" })).toBe(true);
    for (const bad of ["1", "TRUE", "yes", " true"]) expect(() => loadClassifyOnIntakeFlag({ TWINS_CLASSIFY_ON_INTAKE: bad }), bad).toThrow(ClassifyOnIntakeConfigError);
  });
  it("is off in the shipped compose file", () => { expect(readFileSync("infrastructure/staging/docker-compose.staging.yml", "utf8")).toContain("TWINS_CLASSIFY_ON_INTAKE: ${TWINS_CLASSIFY_ON_INTAKE:-false}"); });
});

describe("classifyClaimOnIntake never loses or blocks an intake event", () => {
  it("stores once, and reports an already-recorded classification on a retry", async () => {
    let n = 0; const db = fakeDb(async () => (n++ === 0 ? [{ id: "x" }] : []));
    expect(await classifyClaimOnIntake(db, input)).toEqual({ status: "stored" }); expect(await classifyClaimOnIntake(db, input)).toEqual({ status: "already_recorded" });
  });
  it("a storage failure is returned, not thrown, and carries only the error class name (never row or message content)", async () => {
    class DbDown extends Error { constructor() { super("connection refused while inserting SECRETWORD row"); this.name = "DbDown"; } }
    const r = await classifyClaimOnIntake(fakeDb(async () => { throw new DbDown(); }), input);
    expect(r).toEqual({ status: "failed", errorName: "DbDown" }); expect(JSON.stringify(r)).not.toContain("SECRETWORD");
  });
  it("even a synchronous failure from the database layer is contained", async () => { expect(await classifyClaimOnIntake({ insert: () => { throw new TypeError("boom"); } } as never, input)).toEqual({ status: "failed", errorName: "TypeError" }); });
});

describe("architecture: classification at intake is evidence only", () => {
  const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");
  it("the wrapper imports only classification code and writes nothing but the classification row", () => {
    const code = strip(readFileSync("packages/signals/src/classification/intake.ts", "utf8"));
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(); expect(imports).toEqual(["../db", "../options/types", "./classify", "./persist"]);
    expect(code).not.toMatch(/riskDecision|stop-loss|stopLoss|sizing|approval|paper|broker|schema\./i);
    const persist = strip(readFileSync("packages/signals/src/classification/persist.ts", "utf8")); expect([...persist.matchAll(/schema\.(\w+)/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort()).toEqual(["signalClassifications"]);
  });
  it("the worker hook is after the claim is recorded, flag-gated, awaited inside the isolating wrapper, and never imports the backfill", () => {
    const w = strip(readFileSync("services/worker/src/index.ts", "utf8"));
    const rec = w.indexOf("await recordOptionsIntake("), hook = w.indexOf("classifyClaimOnIntake(db,"), risk = w.indexOf("await recordPendingRiskDecision(log, () => createPendingRiskDecisionForOptionsClaim");
    expect(rec).toBeGreaterThan(-1); expect(hook).toBeGreaterThan(rec); expect(hook).toBeLessThan(risk);
    expect(w).toMatch(/if \(intake\.kind === "claim" && \(options\.classifyOnIntake \?\? defaultClassifyOnIntake\)\)/);
    expect(w).not.toMatch(/loadPendingClaims|classifyBatch/); // no automatic historical classification or import from the live worker
  });
});
