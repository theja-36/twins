import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORTER_STUBS, exporterStub, runExporterStub, type ExporterKind } from "../../../packages/agents/src/index";

const rules = readFileSync(join(process.cwd(), "packages/agents/src/agents/rules.ts"), "utf8");
const FORMATS = new Set(["twins-holiday-calendar-v1", "twins-economic-calendar-v1", "twins-news-v1", "twins-sentiment-v1", "twins-macro-context-v1", "twins-index-constituents-v1", "twins-market-quotes-v1"]);

describe("exporter stubs (structure only)", () => {
  it("cover each missing data kind exactly once", () => {
    expect(EXPORTER_STUBS.map((s) => s.kind).sort()).toEqual(["calendar", "macro", "market-data", "news", "sentiment"]);
  });
  it("point at settings the rules loader really reads, and at known file formats", () => {
    for (const s of EXPORTER_STUBS) {
      for (const setting of s.settings) expect(rules, setting).toContain(setting);
      for (const o of s.outputs) { expect(FORMATS.has(o.format), o.format).toBe(true); expect(o.file).toMatch(/^[a-z-]+\.json$/); }
      expect(s.requires.length).toBeGreaterThan(0); expect(s.agents.every((a) => /^[a-z-]+-v1$/.test(a))).toBe(true);
    }
  });
  it("are inert: every run answers NOT_CONFIGURED, unknown kinds throw", async () => {
    for (const s of EXPORTER_STUBS) expect(await runExporterStub(s.kind)).toEqual({ status: "NOT_CONFIGURED", kind: s.kind, reason: "exporter_not_implemented" });
    expect(() => exporterStub("nope" as ExporterKind)).toThrow();
  });
  it("source has no network, credential or file-system access", () => {
    const code = readFileSync(join(process.cwd(), "packages/agents/src/exporters/stubs.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\s*\(|node:(https?|net|fs)|process\.env|import\s/);
  });
});
