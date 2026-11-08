import { describe, expect, it } from "vitest";
import { buildAttribution, buildCorrection, dataSourceOf } from "../../../packages/outcomes/src/index";
import { facts, rec } from "./fixtures";

describe("outcome attribution", () => {
  it("a closed position with a recorded outcome is FINAL, with realised figures, holding time, behaviour and provenance", () => {
    const a = buildAttribution(facts(), null)!;
    expect(a).toMatchObject({ finality: "FINAL", version: 1, supersedesId: null, correctionReason: null, mode: "PAPER", dataSource: "LIVE", candidateSource: "INDEPENDENT", setup: "BREAKOUT", detectorVersion: "opportunity-setups-v1", timeframeSeconds: 900, exitPrice: "102", exitReason: "TARGET_HIT", holdingSeconds: 3600, outcomeId: "out1", netPnl: "160.00", grossPnl: "180.00", costs: "20.00", riskAmount: "200.00", rMultiple: "0.8" });
    expect(a.trade).toMatchObject({ stopMoves: 1, targetsHit: 1, partialExits: 1, stopHit: false, reachedBreakeven: true, initialStop: "98" });
    expect(a.predicted).toMatchObject({ confidenceScore: 62, riskVerdict: "PASS", plannedRewardToRisk: "2.00", plannedMaxLoss: "210.00", permittedLots: 4 });
    expect(a.evidenceRefs).toEqual(expect.arrayContaining(["decision:dec1", "paper_position:pos1", "trade_outcome:out1", "ev:1"]));
    expect(a.agentVersions).toEqual({ "technical-structure-v1": "technical-structure-v1.1" });
  });
  it("never infers an outcome: an open position, or a closed one with no recorded outcome, is PARTIAL with no exit, no R and no holding time", () => {
    for (const f of [facts({ status: "OPEN" }), facts({ status: "CLOSED", outcome: false })]) {
      const a = buildAttribution(f, null)!;
      expect(a.finality).toBe("PARTIAL"); expect(a).toMatchObject({ outcomeId: null, exitPrice: null, rMultiple: null, holdingSeconds: null, exitReason: null, closedAt: null });
    }
  });
  it("what was not recorded stays explicitly missing, and nothing is filled in", () => {
    const a = buildAttribution(facts({ noConfidence: true }), null)!;
    expect(a.missing).toEqual(expect.arrayContaining(["mae_mfe", "slippage_reference_price", "regime_during_trade", "regime_at_decision", "confidence_at_decision"]));
    expect(a.confidenceScore).toBeNull(); expect(a.regime).toBeNull(); expect(a.dataQuality).toContain("NO_CONFIDENCE_ASSESSMENT");
  });
  it("the weakest provenance wins: any fixture price, fixture candidate or missing price source makes the record FIXTURE", () => {
    expect(dataSourceOf(facts({ sources: ["LIVE", "FIXTURE"] }))).toBe("FIXTURE"); expect(dataSourceOf(facts({ candidateData: "FIXTURE" }))).toBe("FIXTURE"); expect(dataSourceOf(facts({ sources: [] }))).toBe("FIXTURE");
    expect(dataSourceOf(facts({ sources: ["LIVE", "HISTORICAL"] }))).toBe("HISTORICAL"); expect(dataSourceOf(facts())).toBe("LIVE");
    expect(buildAttribution(facts({ sources: ["FIXTURE"] }), null)!.dataQuality).toContain("FIXTURE_PRICES");
  });
  it("flags a confidence score recorded after the position opened (look-ahead) and an outcome that disagrees with the position", () => {
    expect(buildAttribution(facts({ confidenceAfterOpen: true }), null)!.dataQuality).toContain("CONFIDENCE_RECORDED_AFTER_OPEN");
    expect(buildAttribution(facts({ pnl: "999.00" }), null)!.dataQuality).toContain("OUTCOME_PNL_MISMATCH");
    expect(buildAttribution(facts(), null)!.dataQuality).not.toContain("OUTCOME_PNL_MISMATCH");
  });
  it("is idempotent: an unchanged PARTIAL adds nothing; a FINAL is never silently rewritten", () => {
    const partial = { ...rec({ finality: "PARTIAL", outcomeId: null, exitPrice: null, closedAt: null, holdingSeconds: null, exitReason: null, rMultiple: null }), grossPnl: "180.00", netPnl: "160.00", costs: "20.00", dataQuality: ["FIXTURE_PRICES"] };
    const first = buildAttribution(facts({ status: "OPEN", sources: ["FIXTURE"] }), null)!;
    expect(buildAttribution(facts({ status: "OPEN", sources: ["FIXTURE"] }), { ...partial, exitPrice: null, netPnl: first.netPnl, grossPnl: first.grossPnl, costs: first.costs } as never)).toBeNull();
    const fin = rec({ finality: "FINAL" });
    expect(buildAttribution(facts({ pnl: "50.00" }), fin)).toBeNull();
  });
  it("a PARTIAL is superseded by the FINAL version, which names it and carries a reason", () => {
    const prev = rec({ finality: "PARTIAL", outcomeId: null, exitPrice: null, closedAt: null, holdingSeconds: null, exitReason: null, rMultiple: null, version: 1 });
    const next = buildAttribution(facts(), prev)!;
    expect(next).toMatchObject({ version: 2, supersedesId: prev.id, finality: "FINAL" }); expect(next.correctionReason!.length).toBeGreaterThanOrEqual(10);
  });
  it("a correction of a FINAL outcome is deliberate, reasoned and versioned; PARTIAL records and short reasons are refused", () => {
    const prev = rec({ finality: "FINAL", version: 1, netPnl: "100.00", grossPnl: "120.00" });
    const c = buildCorrection(facts(), prev, "the fee schedule used for this trade was corrected")!;
    expect(c).toMatchObject({ version: 2, supersedesId: prev.id, finality: "FINAL" }); expect(c.correctionReason).toMatch(/^correction: the fee schedule/);
    expect(() => buildCorrection(facts(), prev, "short")).toThrow(RangeError);
    expect(() => buildCorrection(facts(), rec({ finality: "PARTIAL" }), "a long enough reason here")).toThrow(RangeError);
    expect(() => buildCorrection(facts({ status: "OPEN" }), prev, "a long enough reason here")).toThrow(RangeError);
  });
});
