import { describe, expect, it } from "vitest";
import { analyzeTelegramText } from "../../../packages/signals/src/extract";
import { randomLetters } from "../../support/randomLetters";

describe("test symbols built from random letters are never classified as options-shaped", () => {
  it("letters only, requested length, and always parsed as an ordinary equity directive", () => {
    for (let i = 0; i < 3000; i++) {
      const s = randomLetters(8);
      expect(s).toMatch(/^[A-Z]{8}$/);
      expect(analyzeTelegramText(`BUY SEL-${s} @ 100 SL 95 TGT 110`).kind).toBe("signal");
    }
  });
});
