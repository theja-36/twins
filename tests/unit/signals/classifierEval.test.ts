import { describe, expect, it } from "vitest";
import { cohenKappa, confusionMatrix, fieldOutcome, fieldReport, leakageProblems, macroF1, perClass, reportable, validateDataset, wilson, type DatasetRow } from "../../../packages/signals/src/evaluation/classifierEval";

/** SYNTHETIC rows and predictions. They prove the harness arithmetic and its guards; they are NOT evidence of any classifier's accuracy. */
const row = (id: string, ts: string, split: DatasetRow["split"], o: Partial<DatasetRow> = {}): DatasetRow => ({ datasetVersion: "v1", rowId: id, channelRef: "***0001", messageTimestamp: ts, revisionOf: null, dupGroup: id, split, label: "claim", annotators: ["a1", "a2"], adjudicated: false, annotatorLabels: ["claim", "claim"], fields: { underlying: "NIFTY" }, ...o });

describe("dataset validation", () => {
  it("accepts a well-formed row and names every defect", () => {
    expect(validateDataset([row("r1", "2030-01-01T10:00:00+05:30", "train")], "v1")).toEqual([]);
    const bad = validateDataset([row("a", "2030-01-01 10:00", "train"), row("a", "2030-01-01T10:00:00Z", "nope" as never, { datasetVersion: "v0", label: "x" as never, annotators: ["a1"], annotatorLabels: ["claim", "noise"] }), row("c", "2030-01-01T10:00:00Z", "train", { fields: undefined })], "v1").map((p) => p.code);
    expect(bad).toEqual(expect.arrayContaining(["BAD_TIMESTAMP", "DUPLICATE_ROW_ID", "BAD_SPLIT", "DATASET_VERSION", "BAD_CLASS", "TOO_FEW_ANNOTATORS", "DISAGREEMENT_NOT_ADJUDICATED", "CLAIM_WITHOUT_FIELDS"]));
  });
  it("a bare local time without an offset is refused (timezone is never guessed)", () => { expect(validateDataset([row("r", "2030-01-01T10:00:00", "train")], "v1").map((p) => p.code)).toContain("BAD_TIMESTAMP"); });
  it("a disagreement that was adjudicated passes", () => { expect(validateDataset([row("r", "2030-01-01T10:00:00Z", "train", { annotatorLabels: ["claim", "noise"], adjudicated: true })], "v1")).toEqual([]); });
});
describe("chronological leakage", () => {
  it("a clean split is chronological; test earlier than train, validation earlier than train, and a duplicate group across splits are all flagged", () => {
    const clean = [row("t1", "2030-01-01T00:00:00Z", "train"), row("v1", "2030-02-01T00:00:00Z", "validation"), row("x1", "2030-03-01T00:00:00Z", "test")];
    expect(leakageProblems(clean)).toEqual([]);
    expect(leakageProblems([row("t1", "2030-03-01T00:00:00Z", "train"), row("x1", "2030-01-01T00:00:00Z", "test")]).map((p) => p.code)).toContain("TEST_BEFORE_TRAIN");
    expect(leakageProblems([row("t1", "2030-03-01T00:00:00Z", "train"), row("v1", "2030-01-01T00:00:00Z", "validation")]).map((p) => p.code)).toContain("VALIDATION_BEFORE_TRAIN");
    expect(leakageProblems([row("t1", "2030-01-01T00:00:00Z", "train", { dupGroup: "g" }), row("x1", "2030-03-01T00:00:00Z", "test", { dupGroup: "g" })]).map((p) => p.code)).toContain("GROUP_SPANS_SPLITS");
  });
});
describe("confusion matrix, precision, recall, F1", () => {
  const pairs = [...Array(8).fill({ truth: "claim", predicted: "claim" }), ...Array(2).fill({ truth: "claim", predicted: "noise" }), ...Array(1).fill({ truth: "noise", predicted: "claim" }), ...Array(9).fill({ truth: "noise", predicted: "noise" })];
  const m = confusionMatrix(pairs, ["claim", "noise"]), s = perClass(m), claim = s.find((x) => x.class === "claim")!;
  it("counts rows = truth, columns = prediction", () => { expect(m).toEqual({ claim: { claim: 8, noise: 2 }, noise: { claim: 1, noise: 9 } }); });
  it("claim: precision 8/9, recall 8/10, F1 is their harmonic mean; false positives and negatives are counted", () => {
    expect(claim).toMatchObject({ support: 10, truePositive: 8, falsePositive: 1, falseNegative: 2 });
    expect(claim.precision).toBeCloseTo(8 / 9, 10); expect(claim.recall).toBeCloseTo(0.8, 10); expect(claim.f1).toBeCloseTo((2 * (8 / 9) * 0.8) / (8 / 9 + 0.8), 10);
    expect(macroF1(s)).toBeCloseTo((claim.f1! + s.find((x) => x.class === "noise")!.f1!) / 2, 10);
  });
  it("an unseen class gives null, not zero or NaN; an unknown class is refused", () => {
    const e = perClass(confusionMatrix([{ truth: "claim", predicted: "claim" }], ["claim", "ambiguous"]));
    expect(e.find((x) => x.class === "ambiguous")).toMatchObject({ support: 0, precision: null, recall: null, f1: null });
    expect(() => confusionMatrix([{ truth: "weird", predicted: "claim" }], ["claim"])).toThrow();
  });
});
describe("field accuracy: invented values are the worst error", () => {
  it("separates correct, wrong value, abstained correctly, missed and INVENTED", () => {
    expect(fieldOutcome(24500, 24500)).toBe("CORRECT"); expect(fieldOutcome(24500, 24550)).toBe("WRONG_VALUE"); expect(fieldOutcome(null, null)).toBe("ABSTAINED_CORRECTLY"); expect(fieldOutcome(24500, null)).toBe("MISSED"); expect(fieldOutcome(null, 24500)).toBe("INVENTED");
  });
  it("the report carries rates and an interval, and an invented value shows up as a non-zero invented rate", () => {
    const r = fieldReport("strike", [{ truth: 1, predicted: 1 }, { truth: null, predicted: 5 }, { truth: 2, predicted: 3 }, { truth: null, predicted: null }]);
    expect(r).toMatchObject({ n: 4, counts: { CORRECT: 1, INVENTED: 1, WRONG_VALUE: 1, ABSTAINED_CORRECTLY: 1 }, inventedRate: 0.25, wrongValueRate: 0.25 });
    expect(r.accuracyInterval!.lower).toBeLessThan(0.5); expect(r.accuracyInterval!.upper).toBeGreaterThan(0.5);
  });
});
describe("intervals, agreement and the reporting floor", () => {
  it("Wilson interval: known values and edge cases", () => {
    const w = wilson(50, 100)!; expect(w.lower).toBeCloseTo(0.4038, 3); expect(w.upper).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 10)!.lower).toBe(0); expect(wilson(10, 10)!.upper).toBe(1); expect(wilson(1, 0)).toBeNull(); expect(wilson(11, 10)).toBeNull();
  });
  it("Cohen's kappa: perfect agreement 1, chance-level about 0, undefined when one class only", () => {
    expect(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"])).toBe(1);
    expect(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"])).toBe(0);
    expect(cohenKappa(["a", "a"], ["a", "a"])).toBeNull(); expect(cohenKappa([], [])).toBeNull(); expect(cohenKappa(["a"], ["a", "b"])).toBeNull();
  });
  it("accuracy is only reportable with at least 200 labelled claims", () => {
    expect(reportable(199).status).toBe("INSUFFICIENT_SAMPLE"); expect(reportable(200).status).toBe("REPORTABLE"); expect(reportable(300, 500).status).toBe("INSUFFICIENT_SAMPLE");
  });
});
