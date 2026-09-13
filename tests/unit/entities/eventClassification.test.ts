import { describe, expect, it } from "vitest";
import { classifyEventType } from "../../../packages/entities/src/eventClassification";

describe("classifyEventType", () => {
  it("classifies an earnings headline", () => {
    expect(classifyEventType("Company reports strong quarterly results")).toBe("earnings");
  });

  it("classifies an interest rate decision", () => {
    expect(classifyEventType("RBI announces repo rate hike of 25bps")).toBe("interest_rate_decision");
  });

  it("classifies a merger/acquisition", () => {
    expect(classifyEventType("Company A to acquire Company B in $2B deal")).toBe("merger_acquisition");
  });

  it("classifies a tariff event", () => {
    expect(classifyEventType("New tariffs imposed on steel imports")).toBe("tariff");
  });

  it("returns null for text with no matching keywords rather than guessing", () => {
    expect(classifyEventType("The weather was pleasant today in Mumbai")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyEventType("COMPANY ANNOUNCES DIVIDEND OF RS 5 PER SHARE")).toBe("dividend");
  });
});
