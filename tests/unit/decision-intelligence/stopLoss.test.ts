import { describe, expect, it } from "vitest";
import { decide } from "../../../packages/decision-intelligence/src/decide";
import { persistDecisionIntelligence } from "../../../packages/decision-intelligence/src/persist";
import { StopLossInvariantError, validateStopLoss } from "../../../packages/stop-loss/src/index";
import { fixtureQuality, fixtureReport } from "./fixtures";

const instrument = (instrumentType = "equity") =>
  ({ id: "inst-1", symbol: "TEST", exchange: "NSE", instrumentType, name: null, isin: null, currency: "INR", lotSize: null, tickSize: null, isActive: true, metadata: null, createdAt: new Date(), updatedAt: new Date() }) as never;

/** A report whose evidence would otherwise justify APPROVE: only the signal's stop-loss / entry / direction vary. */
function report(signalOver: Record<string, unknown> = {}) {
  const base = fixtureReport({
    core: {
      telegramMessageQuality: fixtureQuality({ entityType: "telegram_messages", overallStatus: "trusted" }),
      macroContext: [{ id: "m1", source: "RBI", region: "IN", seriesCode: "REPO_RATE", observedAt: new Date(), receivedAt: new Date(), value: "6.5", unit: null, dataQualityStatus: "ok", rawPayload: null, createdAt: new Date() }],
      newsContext: [{ id: "n1", newsSourceId: "s1", newsEventId: null, sourceUrl: "https://x.invalid", headline: "headline", bodyExcerpt: null, sourceTimestamp: new Date(), receivedAt: new Date(), dedupeHash: "h", rawPayload: null, createdAt: new Date() }],
    } as never,
    entityContext: {
      company: { entityId: "ent-1", entityType: "company", canonicalName: "Test Co", strength: "structural", matchMethod: "deterministic_rule" },
      sector: null, market: null, country: null,
      relevantEvents: [{ id: "evt-div", title: "Dividend declared", eventType: "dividend", firstSeenAt: new Date() }],
    },
  });
  return { ...base, core: { ...base.core, signal: { ...base.core.signal, ...signalOver } } };
}
const run = (signalOver: Record<string, unknown> = {}, type = "equity") => {
  const r = report(signalOver);
  return decide(r.core.signal, instrument(type), r, { now: r.core.signal.signalTimestamp });
};

describe("decide: a valid stop-loss is required for APPROVE", () => {
  it("control: an otherwise approvable BUY with a valid stop-loss is approved and carries its stop-loss evidence", () => {
    const result = run();
    expect(result.outcome).toBe("APPROVE");
    expect(result.stopLoss).toMatchObject({ result: "VALID", reasonCode: null, normalizedStopLoss: 95, entryPrice: 100, side: "buy", instrumentKind: "equity" });
    expect(result.stopLossReasonCode).toBeUndefined();
  });
  it("accepts a valid SELL stop-loss (the verdict then depends only on the evidence; this fixture's evidence supports a BUY) and approves a valid future", () => {
    const sell = run({ direction: "sell", stopLoss: "105" });
    expect(sell.stopLoss).toMatchObject({ result: "VALID", expectedStopSide: "above" });
    expect(sell.structuralIssues).toEqual([]);
    expect(run({}, "future").outcome).toBe("APPROVE");
  });

  it.each([
    ["missing", { stopLoss: null }, "REJECT", "MISSING_STOP_LOSS"],
    ["empty", { stopLoss: "" }, "REJECT", "MISSING_STOP_LOSS"],
    ["zero", { stopLoss: "0" }, "REJECT", "INVALID_STOP_LOSS"],
    ["negative", { stopLoss: "-5" }, "REJECT", "INVALID_STOP_LOSS"],
    ["non-numeric", { stopLoss: "abc" }, "REJECT", "INVALID_STOP_LOSS"],
    ["NaN", { stopLoss: Number.NaN }, "REJECT", "INVALID_STOP_LOSS"],
    ["Infinity", { stopLoss: Number.POSITIVE_INFINITY }, "REJECT", "INVALID_STOP_LOSS"],
    ["equal to the entry", { stopLoss: "100" }, "REJECT", "STOP_LOSS_EQUALS_ENTRY"],
    ["wrong side for BUY", { stopLoss: "105" }, "REJECT", "STOP_LOSS_DIRECTION_INVALID"],
    ["wrong side for SELL", { direction: "sell", stopLoss: "95" }, "REJECT", "STOP_LOSS_DIRECTION_INVALID"],
    ["beyond the maximum risk distance", { stopLoss: "80" }, "REJECT", "STOP_LOSS_TOO_FAR"],
    ["no entry/reference price (cannot be validated: flagged, not approved)", { entryPrice: null }, "INSUFFICIENT_EVIDENCE", "STOP_LOSS_REFERENCE_MISSING"],
  ])("%s -> %s with %s, never APPROVE", (_n, over, outcome, code) => {
    const result = run(over);
    expect(result.outcome).toBe(outcome);
    expect(result.stopLossReasonCode).toBe(code);
    expect(result.stopLoss.reasonCode).toBe(code);
    expect(result.rationale).toContain(outcome === "REJECT" ? "Rejected" : "mandatory stop-loss");
    if (outcome === "REJECT") expect(result.structuralIssues.some((i) => i.ruleId === `structural.stop_loss.${code.toLowerCase()}`)).toBe(true);
  });

  it("the old gap is closed: a bare signal (no entry, no stop, no targets) was a non-blocking observation before and is now REJECTed", () => {
    const result = run({ entryPrice: null, stopLoss: null, targets: [] });
    expect(result.outcome).toBe("REJECT");
    expect(result.stopLossReasonCode).toBe("MISSING_STOP_LOSS");
  });
  it("an unsupported instrument type is flagged, not approved", () => {
    for (const type of ["index", "fx", "commodity"]) {
      const result = run({}, type);
      expect(result.outcome).not.toBe("APPROVE");
      expect(result.stopLossReasonCode).toBe("UNSUPPORTED_INSTRUMENT_TYPE");
    }
  });
  it("the stop-loss evidence is computed even when another rule already rejects (stale signal), so the record is complete", () => {
    const r = report({ stopLoss: null });
    const result = decide(r.core.signal, instrument(), r, { now: new Date(r.core.signal.signalTimestamp.getTime() + 400 * 86_400_000) });
    expect(result.outcome).toBe("REJECT");
    expect(result.stopLoss.reasonCode).toBe("MISSING_STOP_LOSS");
  });

  it("PROPERTY: over a grid of stop-loss values, sides and instrument types, decide returns APPROVE if and only if the shared rule says VALID (and the other evidence allows it)", () => {
    const values: unknown[] = [undefined, null, "", " ", "abc", "NaN", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, "0", -1, "-1", 0.0001, 1, 50, 89.9, 90, 94.99, 95, 99.99, 100, 100.01, 105, 110, 110.01, 1000, 1e12];
    let approvals = 0;
    for (const type of ["equity", "future", "option", "index"]) {
      for (const direction of ["buy", "sell"] as const) {
        for (const stopLoss of values) {
          const r = report({ direction, stopLoss, entryPrice: "100" });
          const result = decide(r.core.signal, instrument(type), r, { now: r.core.signal.signalTimestamp });
          const rule = validateStopLoss({ instrumentType: type, side: direction, stopLoss, entryPrice: "100", levelBasis: "price" });
          if (result.outcome === "APPROVE") {
            approvals += 1;
            expect(rule.result, `${type}/${direction}/${String(stopLoss)}`).toBe("VALID");
          }
          if (rule.result !== "VALID") expect(result.outcome, `${type}/${direction}/${String(stopLoss)}`).not.toBe("APPROVE");
        }
      }
    }
    expect(approvals).toBeGreaterThan(0); // the grid does contain approvable cases (the property is not vacuous)
  });
});

describe("persistDecisionIntelligence refuses an approval without a VALID stop-loss before touching the database", () => {
  const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`database touched (${String(p)})`); } }) as never;
  it("APPROVE with an invalid, missing or absent validation throws StopLossInvariantError", async () => {
    const approved = run();
    for (const stopLoss of [validateStopLoss({ instrumentType: "equity", side: "buy", stopLoss: null, entryPrice: 100 }), validateStopLoss({ instrumentType: "equity", side: "buy", stopLoss: 105, entryPrice: 100 }), undefined]) {
      await expect(persistDecisionIntelligence(untouchable, { ...approved, stopLoss: stopLoss as never })).rejects.toBeInstanceOf(StopLossInvariantError);
    }
  });
});
