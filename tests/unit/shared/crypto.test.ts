import { describe, expect, it } from "vitest";
import { constantTimeCompare } from "../../../packages/shared/src/crypto";

describe("constantTimeCompare (SEC-02)", () => {
  it("returns true for identical ASCII strings", () => {
    expect(constantTimeCompare("secret_token_123", "secret_token_123")).toBe(true);
  });

  it("returns true for identical UTF-8 multi-byte strings", () => {
    expect(constantTimeCompare("token_₹_lock_🔒", "token_₹_lock_🔒")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(constantTimeCompare("secret_token_123", "secret_token_124")).toBe(false);
  });

  it("returns false for different strings of different length", () => {
    expect(constantTimeCompare("short", "longer_secret_token")).toBe(false);
  });

  it("returns false safely without throwing on null or undefined", () => {
    expect(constantTimeCompare(undefined, "secret")).toBe(false);
    expect(constantTimeCompare("secret", undefined)).toBe(false);
    expect(constantTimeCompare(null, "secret")).toBe(false);
    expect(constantTimeCompare("secret", null)).toBe(false);
    expect(constantTimeCompare(undefined, undefined)).toBe(false);
    expect(constantTimeCompare(null, null)).toBe(false);
  });

  it("returns false safely on empty strings", () => {
    expect(constantTimeCompare("", "")).toBe(false);
    expect(constantTimeCompare("", "secret")).toBe(false);
    expect(constantTimeCompare("secret", "")).toBe(false);
  });

  it("returns false safely on non-string types", () => {
    expect(constantTimeCompare(123 as unknown as string, "123")).toBe(false);
    expect(constantTimeCompare({} as unknown as string, "{}")).toBe(false);
  });
});

