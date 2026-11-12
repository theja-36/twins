import { describe, expect, it } from "vitest";
import { formatDecimal, formatIst, formatMoney, isDecimalString, signOf } from "./format";

describe("display formatting (string handling only; no arithmetic)", () => {
  it("groups Indian-style from the exact string", () => {
    expect(formatDecimal("1100920.00")).toBe("11,00,920.00"); expect(formatDecimal("999")).toBe("999"); expect(formatDecimal("1000")).toBe("1,000"); expect(formatDecimal("12345678.9")).toBe("1,23,45,678.9"); expect(formatDecimal("0.0001")).toBe("0.0001");
  });
  it("keeps every digit of a long decimal (no float rounding)", () => { expect(formatDecimal("123456789012345678.123456789")).toBe("1,23,45,67,89,01,23,45,678.123456789"); });
  it("negative values use a true minus sign", () => { expect(formatDecimal("-2260.00")).toBe("−2,260.00"); expect(formatMoney("-310.5")).toBe("−₹ 310.5"); });
  it("money carries the rupee symbol; other currencies their code", () => { expect(formatMoney("1100920.00")).toBe("₹ 11,00,920.00"); expect(formatMoney("5", "USD")).toBe("USD 5"); });
  it("numbers from the wire are formatted without arithmetic", () => { expect(formatDecimal(700)).toBe("700"); expect(formatDecimal(1481.2)).toBe("1,481.2"); });
  it("anything that is not a plain decimal is shown as unavailable, never guessed", () => { for (const v of ["", "abc", "1e5", "1,000", "NaN", "Infinity", "--1", "1.", ".5", null, undefined]) expect(formatDecimal(v as never), String(v)).toBe("—"); expect(formatMoney(null)).toBe("—"); });
  it("sign comes from the characters: -0.00 and 0.00 are flat", () => { expect(signOf("3810.00")).toBe("gain"); expect(signOf("-2260.00")).toBe("loss"); expect(signOf("0.00")).toBe("flat"); expect(signOf("-0.00")).toBe("flat"); expect(signOf("x")).toBe("flat"); expect(signOf(null)).toBe("flat"); });
  it("isDecimalString", () => { expect(isDecimalString("12.50")).toBe(true); expect(isDecimalString(12.5)).toBe(false); });
  it("timestamps show IST", () => { expect(formatIst("2031-01-06T05:00:00Z")).toContain("10:30"); expect(formatIst("2031-01-06T05:00:00Z")).toContain("IST"); expect(formatIst("junk")).toBe("—"); expect(formatIst(null)).toBe("—"); });
});
