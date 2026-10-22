import { describe, expect, it } from "vitest";
import { resolveEffectiveAsOf } from "../../../packages/decision-intelligence/src/engine";

const t = (iso: string) => new Date(iso);

describe("validateSignal effective as-of time (selection clock == decision clock)", () => {
  it("defaults to now when nothing is set", () => {
    const before = Date.now();
    const d = resolveEffectiveAsOf({}).getTime();
    expect(d).toBeGreaterThanOrEqual(before);
    expect(d).toBeLessThanOrEqual(Date.now());
  });
  it("uses whichever single source sets it", () => {
    expect(resolveEffectiveAsOf({ asOf: t("2026-01-01T00:00:00Z") }).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(resolveEffectiveAsOf({ intelligence: { asOf: t("2026-01-02T00:00:00Z") } }).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(resolveEffectiveAsOf({ decide: { now: t("2026-01-03T00:00:00Z") } }).toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });
  it("accepts several sources that agree", () => {
    const same = "2026-01-04T00:00:00Z";
    expect(resolveEffectiveAsOf({ asOf: t(same), intelligence: { asOf: t(same) }, decide: { now: t(same) } }).toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });
  it.each([
    [{ asOf: t("2026-01-01T00:00:00Z"), decide: { now: t("2026-01-02T00:00:00Z") } }],
    [{ intelligence: { asOf: t("2026-01-01T00:00:00Z") }, decide: { now: t("2026-01-02T00:00:00Z") } }],
    [{ asOf: t("2026-01-01T00:00:00Z"), intelligence: { asOf: t("2026-01-05T00:00:00Z") } }],
  ])("refuses a silent disagreement between evidence cutoff and decision clock", (opts) => {
    expect(() => resolveEffectiveAsOf(opts)).toThrow(/must be the same instant/);
  });
});
