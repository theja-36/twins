import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Production analyses ONLY the Yahoo daily bars the worker just refreshed - never synthetic rows. The `analysisMarket` option exists so
 * integration tests that run on synthetic bars can say so explicitly; it must stay optional, and the default must not change.
 */
const src = readFileSync("services/worker/src/index.ts", "utf8");
const harness = readFileSync("tests/integration/runtime/harness.ts", "utf8");

describe("worker analysis market input", () => {
  it("defaults to the Yahoo provider's daily bars, and the override is optional", () => {
    expect(src).toContain('options.analysisMarket ?? { source: YAHOO_PROVIDER_NAME, timeframe: "1d" }');
    expect(src).toMatch(/analysisMarket\?: \{ source: string; timeframe: string; context\?: "analysis" \| "synthetic" \}/);
    expect(src).not.toMatch(/analysisMarket[^\n]*r0b-synthetic/); // no synthetic source is named anywhere in production code
    expect(src).not.toMatch(/context: "synthetic"/);
  });
  it("only the test harness selects synthetic bars, and it names both source and context", () => {
    expect(harness).toContain('analysisMarket: { source: SYNTHETIC_SOURCE, timeframe: "1d", context: "synthetic" }');
    expect(harness).toContain('const SYNTHETIC_SOURCE = "r0b-synthetic"');
  });
});
