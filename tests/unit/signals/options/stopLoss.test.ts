import { describe, expect, it } from "vitest";
import { analyzeOptionsText } from "../../../../packages/signals/src/options/parse";
import { assessOptionsClaim } from "../../../../packages/signals/src/options/assess";
import type { OptionsClaim } from "../../../../packages/signals/src/options/types";
import { loadStopLossConfig } from "../../../../packages/stop-loss/src/index";

const claim = (t: string): OptionsClaim => {
  const a = analyzeOptionsText(t);
  if (a.kind !== "options_claim") throw new Error(a.kind);
  return a.claim;
};
const assess = (t: string, config?: Parameters<typeof assessOptionsClaim>[3]) => assessOptionsClaim(claim(t), undefined, undefined, config);
const BASE = "NIFTY 24500 CE 29 OCT 2026";

describe("options claims: the mandatory stop-loss rule inside the assessment (an options claim is never approvable; the rule decides REJECT vs FLAG and feeds the review bot)", () => {
  it("a valid premium-basis stop-loss: VALID evidence, no stop_loss.* reason", async () => {
    const a = await assess(`BUY ${BASE} ABOVE 120 SL 90 TGT 150 premium`);
    expect(a.stopLoss).toMatchObject({ result: "VALID", reasonCode: null, normalizedStopLoss: 90, entryPrice: 120, levelBasis: "premium", side: "buy", optionType: "CE" });
    expect(a.reasons.some((r) => r.code.startsWith("stop_loss."))).toBe(false);
    expect(a.approvalPossible).toBe(false);
  });
  it("missing stop-loss: flagged (INSUFFICIENT_EVIDENCE) with MISSING_STOP_LOSS, never approvable", async () => {
    const a = await assess(`BUY ${BASE} ABOVE 120 TGT 150 premium`);
    expect(a.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.stopLoss).toMatchObject({ result: "MISSING", reasonCode: "MISSING_STOP_LOSS" });
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["levels.stop_missing", "stop_loss.missing_stop_loss"]));
    expect(a.approvalPossible).toBe(false);
  });
  it("a stop-loss on the wrong side of the entry premium (BUY CE and BUY PE) is REJECTED with STOP_LOSS_DIRECTION_INVALID", async () => {
    for (const type of ["CE", "PE"]) {
      const a = await assess(`BUY NIFTY 24500 ${type} 29 OCT 2026 ABOVE 120 SL 140 TGT 150 premium`);
      expect(a.outcome, type).toBe("REJECT");
      expect(a.stopLoss, type).toMatchObject({ result: "INVALID", reasonCode: "STOP_LOSS_DIRECTION_INVALID" });
      expect(a.reasons.map((r) => r.code), type).toContain("stop_loss.stop_loss_direction_invalid");
    }
  });
  it("a stop-loss equal to the entry premium is REJECTED", async () => {
    const a = await assess(`BUY ${BASE} ABOVE 120 SL 120 TGT 150 premium`);
    expect(a.stopLoss.reasonCode).toBe("STOP_LOSS_EQUALS_ENTRY");
    expect(a.outcome).toBe("REJECT");
  });
  it("a stop-loss beyond the maximum premium risk is REJECTED (default 70%; configurable)", async () => {
    const far = await assess(`BUY ${BASE} ABOVE 120 SL 20 TGT 150 premium`);
    expect(far.stopLoss.reasonCode).toBe("STOP_LOSS_TOO_FAR");
    expect(far.outcome).toBe("REJECT");
    const lenient = await assess(`BUY ${BASE} ABOVE 120 SL 20 TGT 150 premium`, loadStopLossConfig({ TWINS_STOPLOSS_MAX_RISK_PCT_OPTION: "90" }));
    expect(lenient.stopLoss.result).toBe("VALID");
    expect(lenient.stopLoss.maxRiskSource).toBe("env");
  });
  it("levels without a stated basis are flagged STOP_LOSS_BASIS_UNSPECIFIED (not valid); underlying-basis levels STOP_LOSS_NOT_PREMIUM_BASIS", async () => {
    const unspecified = await assess(`BUY ${BASE} ABOVE 120 SL 90 TGT 150`);
    expect(unspecified.stopLoss.reasonCode).toBe("STOP_LOSS_BASIS_UNSPECIFIED");
    expect(unspecified.outcome).toBe("INSUFFICIENT_EVIDENCE");
    const underlying = await assess(`BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 24550 SL 24400 TGT 24700 nifty spot`);
    expect(["STOP_LOSS_NOT_PREMIUM_BASIS", "STOP_LOSS_BASIS_UNSPECIFIED"]).toContain(underlying.stopLoss.reasonCode);
    expect(underlying.stopLoss.result).not.toBe("VALID");
  });
  it("no entry price (market order) cannot be validated: STOP_LOSS_REFERENCE_MISSING", async () => {
    const a = await assess(`BUY ${BASE} AT MARKET SL 90 TGT 150 premium`);
    expect(a.stopLoss.result).not.toBe("VALID");
  });
  it("whatever the stop-loss, no assessment ever allows approval", async () => {
    for (const text of [`BUY ${BASE} ABOVE 120 SL 90 TGT 150 premium`, `BUY ${BASE} ABOVE 120 TGT 150 premium`, `SELL ${BASE} ABOVE 120 SL 150 TGT 100 premium`]) {
      const a = await assess(text);
      expect(a.approvalPossible).toBe(false);
      expect(["INSUFFICIENT_EVIDENCE", "REJECT"]).toContain(a.outcome);
    }
  });
});
