import { describe, expect, it } from "vitest";
import { extractCandidatePhrases } from "../../../packages/entities/src/newsMentions";

describe("extractCandidatePhrases", () => {
  it("extracts single-word and multi-word n-grams, preserving original casing for provenance display", () => {
    const phrases = extractCandidatePhrases("Reliance Industries announces results");
    expect(phrases).toContain("Reliance");
    expect(phrases).toContain("Reliance Industries");
    expect(phrases).toContain("Industries announces");
  });

  it("produces a bounded number of phrases proportional to word count, not entity-registry size", () => {
    const text = "one two three four five six seven eight";
    const phrases = extractCandidatePhrases(text);
    const words = text.split(" ").length;
    // n-grams of length 1..4: sum_{n=1}^{4} (words - n + 1), bounded and small
    const maxExpected = words * 4;
    expect(phrases.length).toBeLessThanOrEqual(maxExpected);
  });

  it("handles punctuation and case without crashing", () => {
    const phrases = extractCandidatePhrases("Fed's rate decision: markets react!");
    expect(phrases.length).toBeGreaterThan(0);
  });

  it("returns an empty array for empty text", () => {
    expect(extractCandidatePhrases("")).toEqual([]);
  });
});
