import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Static proof that the shadow cannot change a decision: it imports nothing, and the worker calls it as a bare awaited statement whose result is never used.
const shadow = readFileSync("services/worker/src/reduceOnlyShadow.ts", "utf8");
const worker = readFileSync("services/worker/src/index.ts", "utf8");
const compose = readFileSync("infrastructure/staging/docker-compose.staging.yml", "utf8");

describe("reduce-only shadow isolation", () => {
  it("the shadow module imports nothing (no database, no sizing, no order module)", () => {
    expect(shadow.match(/^\s*import\s/gm)).toBeNull();
    expect(shadow).not.toMatch(/require\(|await import\(/);
  });
  it("the worker awaits it as a bare statement: the result is never assigned, returned or branched on", () => {
    const calls = worker.match(/^.*runReduceOnlyShadow\(.*$/gm) ?? [];
    const uses = calls.filter((l) => !l.includes("import {"));
    expect(uses).toHaveLength(1);
    expect(uses[0]!.trim().startsWith("if (!(\"skipped\" in sz)) await runReduceOnlyShadow(")).toBe(true);
    expect(uses[0]).not.toMatch(/=\s*await runReduceOnlyShadow|return\s+await runReduceOnlyShadow/);
  });
  it("it runs after the v1 sizing record and before the portfolio gate, and never touches the decision objects", () => {
    const iSize = worker.indexOf('log.info("worker.risk_sizing.recorded"');
    const iShadow = worker.indexOf("await runReduceOnlyShadow(");
    const iPortfolio = worker.indexOf("await evaluate(sz.id)");
    expect(iSize).toBeGreaterThan(0);
    expect(iShadow).toBeGreaterThan(iSize);
    expect(iPortfolio).toBeGreaterThan(iShadow);
    expect(worker.slice(worker.indexOf("const reduceOnlyShadowDeps"), worker.indexOf("async function recordPendingRiskDecision("))).not.toMatch(/supersedeRiskDecision|insert\(|update\(|\.execute\(/);
  });
  it("the staging worker defaults the flag to false and sets capital through the host env only", () => {
    expect(compose).toContain("TWINS_REDUCE_ONLY_SHADOW: ${TWINS_REDUCE_ONLY_SHADOW:-false}");
    expect(compose).toContain("TWINS_SIZING_AVAILABLE_CAPITAL: ${TWINS_SIZING_AVAILABLE_CAPITAL:-}");
    expect(compose).not.toMatch(/TWINS_REDUCE_ONLY_SHADOW:\s*"?true/);
  });
});
