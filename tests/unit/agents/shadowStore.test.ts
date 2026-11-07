import { describe, expect, it } from "vitest";
import { recordShadowObservation, sanitizeShadowResult, ShadowObservationError } from "../../../services/worker/src/shadowStore";
import { DEFAULT_REDUCE_ONLY_POLICY, reduceOnlySize } from "../../../packages/risk/src/index";
import { loadShadowPersistFlag, ReduceOnlyShadowConfigError, runReduceOnlyShadow, SHADOW_EVENT, SHADOW_PERSIST_FAILED_EVENT, type ShadowDeps } from "../../../services/worker/src/reduceOnlyShadow";

describe("sanitizeShadowResult (allow-list)", () => {
  it("keeps codes and numbers, drops sensitive keys, long free text and non-finite numbers", () => {
    const out = sanitizeShadowResult({ assessment: "RESEARCH_CAUTION", n: 3, ok: true, x: Number.NaN, rawText: "BUY NIFTY", message: "hello", token: "abc", note: "a sentence with a % sign and, commas!", agents: [{ agentId: "options-risk-v1", verdict: "CAUTION", confidence: 70 }] }) as Record<string, unknown>;
    expect(out).toEqual({ assessment: "RESEARCH_CAUTION", n: 3, ok: true, x: null, note: "[dropped]", agents: [{ agentId: "options-risk-v1", verdict: "CAUTION", confidence: 70 }] });
  });
  it("bounds width, depth and drops odd keys and non-JSON values", () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeShadowResult(wide) as object)).toHaveLength(64);
    expect(sanitizeShadowResult({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[depth-limited]" } } } });
    expect(sanitizeShadowResult({ "bad key!": 1, ok: 2, fn: () => 1 })).toEqual({ ok: 2, fn: "[dropped]" });
    expect((sanitizeShadowResult(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(32);
  });
});

describe("recordShadowObservation input checks (before any database call)", () => {
  const db = { insert: () => { throw new Error("must not be reached"); } } as never;
  const ok = { kind: "reduce_only_sizing" as const, riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 1, result: { a: 1 } };
  it("refuses bad kind, id, version and oversize results", async () => {
    await expect(recordShadowObservation(db, { ...ok, kind: "other" as never })).rejects.toThrow(ShadowObservationError);
    await expect(recordShadowObservation(db, { ...ok, riskDecisionId: "nope" })).rejects.toThrow(ShadowObservationError);
    await expect(recordShadowObservation(db, { ...ok, decisionVersion: 0 })).rejects.toThrow(ShadowObservationError);
    await expect(recordShadowObservation(db, { ...ok, result: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, Array.from({ length: 4 }, () => "x".repeat(120))])) })).rejects.toThrow(ShadowObservationError);
  });
});

const lines: Array<{ event: string; f: Record<string, unknown> }> = [];
const mk = (o: Partial<ShadowDeps>): ShadowDeps => ({
  enabled: true, log: { info: (event, f) => lines.push({ event, f }), warn: (event, f) => lines.push({ event, f }) },
  compute: (i) => reduceOnlySize(i, DEFAULT_REDUCE_ONLY_POLICY),
  gather: async () => ({ drawdownPct: null, volatilityRatio: null, hoursToHighImpactEvent: null, unusableSources: 1, thinEvidence: true, unitRisk: 5 }), ...o,
});
const SIZED = { id: "11111111-1111-4111-8111-111111111111", decisionVersion: 3, sizingStatus: "SIZED", quantity: 100 };

describe("sizing shadow persist hook", () => {
  it("persists exactly one allow-listed result alongside the log line", async () => {
    lines.length = 0;
    const calls: unknown[] = [];
    await runReduceOnlyShadow(mk({ persist: async (o) => { calls.push(o); } }), SIZED);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "reduce_only_sizing", riskDecisionId: SIZED.id, decisionVersion: 3, result: { v1Quantity: 100, reduced: true, unitRisk: 5 } });
    expect(lines.map((l) => l.event)).toEqual([SHADOW_EVENT]);
  });
  it("a failing persist is logged and never reaches the flow", async () => {
    lines.length = 0;
    await expect(runReduceOnlyShadow(mk({ persist: async () => { throw new Error("db down"); } }), SIZED)).resolves.toBeUndefined();
    expect(lines.map((l) => l.event)).toEqual([SHADOW_EVENT, SHADOW_PERSIST_FAILED_EVENT]);
  });
  it("is not called when off, not sized, or when the result would have been a violation", async () => {
    let n = 0;
    const persist = async () => { n++; };
    await runReduceOnlyShadow(mk({ enabled: false, persist }), SIZED);
    await runReduceOnlyShadow(mk({ persist }), { ...SIZED, sizingStatus: "REJECTED" });
    await runReduceOnlyShadow(mk({ persist, compute: (i) => ({ ...reduceOnlySize(i, DEFAULT_REDUCE_ONLY_POLICY), adjustedQuantity: i.v1Quantity + 1 }) }), SIZED);
    expect(n).toBe(0);
  });
  it("the persist flag is strict and defaults off", () => {
    expect(loadShadowPersistFlag({})).toBe(false);
    expect(loadShadowPersistFlag({ TWINS_SHADOW_PERSIST: "false" })).toBe(false);
    expect(loadShadowPersistFlag({ TWINS_SHADOW_PERSIST: "true" })).toBe(true);
    expect(() => loadShadowPersistFlag({ TWINS_SHADOW_PERSIST: "1" })).toThrow(ReduceOnlyShadowConfigError);
  });
});
