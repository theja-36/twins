import { describe, expect, it } from "vitest";
import { DEFAULT_REDUCE_ONLY_POLICY, reduceOnlySize } from "../../../packages/risk/src/index";
import { loadReduceOnlyShadowFlag, ReduceOnlyShadowConfigError, runReduceOnlyShadow, SHADOW_EVENT, SHADOW_FAILED_EVENT, SHADOW_VIOLATION_EVENT, type ShadowDeps, type ShadowInputs } from "../../../services/worker/src/reduceOnlyShadow";
import { renderTally, runCli, tallyShadow } from "../../../scripts/ops/shadow-diff";

const inputs = (o: Partial<ShadowInputs> = {}): ShadowInputs => ({ drawdownPct: null, volatilityRatio: null, hoursToHighImpactEvent: null, unusableSources: 0, thinEvidence: false, unitRisk: 5, ...o });
const mk = (o: Partial<ShadowDeps> = {}) => {
  const lines: Array<{ level: string; event: string; f: Record<string, unknown> }> = [];
  const log = { info: (event: string, f: Record<string, unknown>) => lines.push({ level: "info", event, f }), warn: (event: string, f: Record<string, unknown>) => lines.push({ level: "warn", event, f }) };
  const deps: ShadowDeps = { enabled: true, log, compute: (i) => reduceOnlySize(i, DEFAULT_REDUCE_ONLY_POLICY), gather: async () => inputs(), ...o };
  return { deps, lines };
};
const SIZED = { id: "d1", decisionVersion: 3, sizingStatus: "SIZED", quantity: 100 };

describe("shadow flag", () => {
  it("is off by default and strict", () => {
    expect(loadReduceOnlyShadowFlag({}, { enforcingEngine: false })).toBe(false);
    expect(loadReduceOnlyShadowFlag({ TWINS_REDUCE_ONLY_SHADOW: "false" }, { enforcingEngine: false })).toBe(false);
    expect(loadReduceOnlyShadowFlag({ TWINS_REDUCE_ONLY_SHADOW: "true" }, { enforcingEngine: false })).toBe(true);
    expect(() => loadReduceOnlyShadowFlag({ TWINS_REDUCE_ONLY_SHADOW: "yes" }, { enforcingEngine: false })).toThrow(ReduceOnlyShadowConfigError);
  });
  it("refuses to be on with the enforcing engine", () => {
    expect(() => loadReduceOnlyShadowFlag({ TWINS_REDUCE_ONLY_SHADOW: "true" }, { enforcingEngine: true })).toThrow(ReduceOnlyShadowConfigError);
  });
});

describe("runReduceOnlyShadow", () => {
  it("does nothing when off or when the decision was not SIZED", async () => {
    let gathered = 0;
    const off = mk({ enabled: false, gather: async () => { gathered++; return inputs(); } });
    await runReduceOnlyShadow(off.deps, SIZED);
    const notSized = mk({ gather: async () => { gathered++; return inputs(); } });
    await runReduceOnlyShadow(notSized.deps, { ...SIZED, sizingStatus: "REJECTED" });
    expect(gathered).toBe(0);
    expect(off.lines).toHaveLength(0);
    expect(notSized.lines).toHaveLength(0);
  });
  it("logs exactly one line with reduce-only numbers and never marks itself used", async () => {
    const { deps, lines } = mk({ gather: async () => inputs({ unusableSources: 2, thinEvidence: true, hoursToHighImpactEvent: 2 }) });
    await runReduceOnlyShadow(deps, SIZED);
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect(l.event).toBe(SHADOW_EVENT);
    expect(l.f["v1Quantity"]).toBe(100);
    expect(l.f["shadowQuantity"] as number).toBeLessThan(100);
    expect(l.f["usedForDecisions"]).toBe(false);
    expect(l.f["unknownInputs"]).toEqual(["drawdownPct", "volatilityRatio"]);
  });
  it("swallows a throwing gather and a throwing compute", async () => {
    const a = mk({ gather: async () => { throw new Error("boom"); } });
    await expect(runReduceOnlyShadow(a.deps, SIZED)).resolves.toBeUndefined();
    expect(a.lines[0]?.event).toBe(SHADOW_FAILED_EVENT);
    const b = mk({ compute: () => { throw new Error("boom"); } });
    await expect(runReduceOnlyShadow(b.deps, SIZED)).resolves.toBeUndefined();
    expect(b.lines[0]?.event).toBe(SHADOW_FAILED_EVENT);
  });
  it("abandons a hung evaluation after the timeout", async () => {
    const { deps, lines } = mk({ gather: () => new Promise(() => undefined), timeoutMs: 20 });
    await runReduceOnlyShadow(deps, SIZED);
    expect(lines[0]).toMatchObject({ event: SHADOW_FAILED_EVENT, f: { reason: "timeout" } });
  });
  it("discards a result that would increase the size", async () => {
    const bad = mk({ compute: (i) => ({ ...reduceOnlySize(i, DEFAULT_REDUCE_ONLY_POLICY), adjustedQuantity: i.v1Quantity + 1 }) });
    await runReduceOnlyShadow(bad.deps, SIZED);
    expect(bad.lines).toHaveLength(1);
    expect(bad.lines[0]?.event).toBe(SHADOW_VIOLATION_EVENT);
    const claimsUse = mk({ compute: (i) => ({ ...reduceOnlySize(i, DEFAULT_REDUCE_ONLY_POLICY), usedForDecisions: true as unknown as false }) });
    await runReduceOnlyShadow(claimsUse.deps, SIZED);
    expect(claimsUse.lines[0]?.event).toBe(SHADOW_VIOLATION_EVENT);
  });
  it("never lets a throwing logger escape", async () => {
    const { deps } = mk();
    const loud = { ...deps, log: { info: () => { throw new Error("log"); }, warn: () => { throw new Error("log"); } } };
    await expect(runReduceOnlyShadow(loud, SIZED)).resolves.toBeUndefined();
  });
});

describe("shadow-diff tally", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ event: SHADOW_EVENT, riskDecisionId: "a", decisionVersion: 1, v1Quantity: 100, shadowQuantity: 75, multiplier: 0.75, reduced: true, factors: [{ name: "thin_evidence", multiplier: 0.75 }], unknownInputs: ["volatilityRatio"], unitRisk: 4, ...o });
  it("aggregates, dedupes and counts violations", () => {
    const text = [line({}), line({}), line({ riskDecisionId: "b", shadowQuantity: 100, multiplier: 1, reduced: false, factors: [] }), line({ riskDecisionId: "c", shadowQuantity: 150 }), JSON.stringify({ event: "risk_sizing.shadow.violation" }), "not json", JSON.stringify({ event: "other" })].join("\n");
    const t = tallyShadow(text);
    expect(t).toMatchObject({ decisions: 2, reduced: 1, reducedShare: 0.5, totalV1Quantity: 200, totalShadowQuantity: 175, riskAvoidedAmount: 100, duplicatesIgnored: 1, notReduceOnly: 1, violations: 1 });
    expect(t.byFactor).toEqual({ thin_evidence: 1 });
    expect(renderTally(t).join("\n")).toContain("risk avoided, not profit");
  });
  it("handles empty input through the CLI", () => {
    const out: string[] = [];
    expect(runCli(["--json"], { stdin: () => "", out: (l) => out.push(l), err: () => undefined })).toBe(0);
    expect(JSON.parse(out.join("\n")).decisions).toBe(0);
    expect(runCli(["--bogus"], { stdin: () => "", out: () => undefined, err: () => undefined })).toBe(2);
  });
});
