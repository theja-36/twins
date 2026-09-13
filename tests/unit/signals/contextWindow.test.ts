import { describe, expect, it } from "vitest";
import { resolveContextWindow } from "../../../packages/signals/src/contextWindow";

describe("resolveContextWindow", () => {
  it("uses the signal timestamp as asOf and leaves from undefined when no lookback is given", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const window = resolveContextWindow(t);
    expect(window.asOf).toBe(t);
    expect(window.from).toBeUndefined();
  });

  it("computes from as asOf minus the lookback window", () => {
    const t = new Date("2026-01-10T00:00:00Z");
    const lookbackMs = 1000 * 60 * 60 * 24 * 7; // 7 days
    const window = resolveContextWindow(t, { lookbackMs });
    expect(window.from?.getTime()).toBe(t.getTime() - lookbackMs);
  });
});
