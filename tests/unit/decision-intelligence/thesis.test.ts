import { describe, expect, it } from "vitest";
import { buildBearThesis, buildBullThesis } from "../../../packages/decision-intelligence/src/thesis";
import { failedDimensionQuality, fixtureQuality, fixtureReport } from "./fixtures";

describe("buildBullThesis", () => {
  it("is empty when no positive-convention event exists", () => {
    const thesis = buildBullThesis(fixtureReport());
    expect(thesis.factors).toHaveLength(0);
    expect(thesis.strength).toBe("weak");
  });

  it("cites a real dividend event as a supporting factor with its evidence id", () => {
    const report = fixtureReport({
      entityContext: {
        company: null,
        sector: null,
        market: null,
        country: null,
        relevantEvents: [{ id: "evt-1", title: "Company declares dividend", eventType: "dividend", firstSeenAt: new Date() }],
      } as never,
    });
    const thesis = buildBullThesis(report);
    expect(thesis.factors).toHaveLength(1);
    expect(thesis.factors[0]?.evidenceId).toBe("evt-1");
    expect(thesis.evidenceIds).toContain("evt-1");
  });

  it("does not treat an earnings event as directional (ambiguous without beat/miss data)", () => {
    const report = fixtureReport({
      entityContext: {
        company: null,
        sector: null,
        market: null,
        country: null,
        relevantEvents: [{ id: "evt-1", title: "Company reports earnings", eventType: "earnings", firstSeenAt: new Date() }],
      } as never,
    });
    expect(buildBullThesis(report).factors).toHaveLength(0);
  });
});

describe("buildBearThesis", () => {
  it("flags missing market data", () => {
    const report = fixtureReport({ core: { marketContext: null } as never });
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.no_market_data")).toBe(true);
  });

  it("flags stale market data via the Phase 5 freshness dimension", () => {
    const report = fixtureReport();
    report.core.marketContext!.quality = failedDimensionQuality("freshness");
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.stale_market_data")).toBe(true);
  });

  it("flags a cross-source market conflict", () => {
    const report = fixtureReport();
    report.core.marketContext!.quality = failedDimensionQuality("cross_source_conflict");
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.market_data_conflict")).toBe(true);
  });

  it("cites a real negative-convention event (e.g. bankruptcy) with its evidence id", () => {
    const report = fixtureReport({
      entityContext: {
        company: { entityId: "ent-1", entityType: "company", canonicalName: "Test Co", strength: "structural", matchMethod: "deterministic_rule" },
        sector: null,
        market: null,
        country: null,
        relevantEvents: [{ id: "evt-2", title: "Company files for bankruptcy", eventType: "bankruptcy", firstSeenAt: new Date() }],
      } as never,
    });
    const thesis = buildBearThesis(report);
    const factor = thesis.factors.find((f) => f.ruleId === "bear.negative_convention_event");
    expect(factor?.evidenceId).toBe("evt-2");
  });

  it("flags an untrusted (non-trusted-status) telegram source", () => {
    const report = fixtureReport(); // fixture already sets telegramMessageQuality to "flagged"
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.untrusted_source")).toBe(true);
  });

  it("flags an unresolved entity mapping", () => {
    const report = fixtureReport({
      entityContext: { company: null, sector: null, market: null, country: null, relevantEvents: [] },
    });
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.unresolved_entity")).toBe(true);
  });

  it("flags absence of macro AND news corroboration", () => {
    const thesis = buildBearThesis(fixtureReport()); // fixture has empty macro/news
    expect(thesis.factors.some((f) => f.ruleId === "bear.no_corroborating_context")).toBe(true);
  });

  it("does not flag missing corroboration when macro OR news evidence exists", () => {
    const report = fixtureReport({
      core: {
        macroContext: [
          { id: "m1", source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), receivedAt: new Date(), value: "6.5", unit: null, dataQualityStatus: "ok", rawPayload: null, createdAt: new Date() },
        ],
      } as never,
    });
    const thesis = buildBearThesis(report);
    expect(thesis.factors.some((f) => f.ruleId === "bear.no_corroborating_context")).toBe(false);
  });

  it("classifies strength based on factor count", () => {
    const empty = buildBearThesis(
      fixtureReport({
        core: {
          marketContext: { observation: fixtureReport().core.marketContext!.observation, quality: fixtureQuality() },
          telegramMessageQuality: fixtureQuality({ overallStatus: "trusted" }),
          macroContext: [{ id: "m1" }] as never,
          newsContext: [{ id: "n1" }] as never,
        } as never,
        entityContext: { company: { entityId: "e", entityType: "company", canonicalName: "x", strength: "structural", matchMethod: "deterministic_rule" }, sector: null, market: null, country: null, relevantEvents: [] },
      }),
    );
    expect(empty.strength).toBe("weak");
  });
});
