import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain ESM helpers shared with the CLI
import { render, summary, validate } from "../../../scripts/product/trackerLib.mjs";

const tracker = JSON.parse(readFileSync("docs/product/tracker.json", "utf8"));

describe("implementation tracker", () => {
  it("is valid: unique ids, evidence rules, all 16 modules, 12 agents + options-risk, 30 screens", () => { expect(validate(tracker)).toEqual([]); });
  it("never marks anything VERIFIED without evidence, and marks IMPLEMENTED only with evidence", () => {
    for (const r of tracker.requirements) if (r.status === "VERIFIED" || r.status === "IMPLEMENTED") expect(r.evidence.length, r.id).toBeGreaterThan(0);
  });
  it("rejects a VERIFIED requirement without evidence and a BLOCKED one without a blocker", () => {
    const bad = JSON.parse(JSON.stringify(tracker)); bad.requirements[0].status = "VERIFIED"; bad.requirements[0].evidence = []; bad.requirements[1].status = "BLOCKED"; bad.requirements[1].blockers = [];
    const e = validate(bad); expect(e.some((x: string) => x.includes("needs evidence"))).toBe(true); expect(e.some((x: string) => x.includes("needs a blocker"))).toBe(true);
  });
  it("the committed Markdown matches the JSON (run: node scripts/product/tracker.mjs render)", () => { expect(readFileSync("docs/product/IMPLEMENTATION_TRACKER.md", "utf8")).toBe(render(tracker)); });
  it("covers every module in the spec's module list", () => { expect(Object.keys(summary(tracker)).filter((k) => /^M\d\d$/.test(k))).toHaveLength(16); });
});
