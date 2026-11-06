import { describe, expect, it } from "vitest";
import { parseOptionChainFile, parseOptionQuotesFile } from "@twins/agents";
import { convertDhanOptionChain, DhanChainError } from "../../../packages/providers/src/dhanOptionChain";

// SYNTHETIC fixture in the assumed Dhan response shape; not a recorded response.
const leg = (o: Record<string, unknown> = {}) => ({ implied_volatility: 14.2, last_price: 120.5, oi: 90000, volume: 12000, top_bid_price: 120, top_ask_price: 121, greeks: { delta: 0.52, theta: -8.1, gamma: 0.0012, vega: 11.3 }, ...o });
const resp = (oc: Record<string, unknown>, last = 24500) => ({ status: "success", data: { last_price: last, oc } });
const IN = { market: "NSE", underlying: "NIFTY", expiry: "2031-10-29", asOf: new Date("2031-10-27T05:00:00Z") };

describe("convertDhanOptionChain (pure, synthetic)", () => {
  it("builds both provider files that the agents' own parsers accept", () => {
    const r = convertDhanOptionChain(resp({ "24500.000000": { ce: leg(), pe: leg({ greeks: { delta: -0.48, theta: -7.9, gamma: 0.0012, vega: 11.3 } }) }, "24600.000000": { ce: leg({ last_price: 80 }) } }), IN);
    expect(r.quoteCount).toBe(3);
    const qp = parseOptionQuotesFile(r.quotesDoc);
    expect(qp.name).toBe("file:dhan-option-chain");
    expect(Object.keys(r.quotesDoc["quotes"] as object)).toContain("NSE:NIFTY:2031-10-29:24500:PE");
    parseOptionChainFile(r.chainDoc);
    expect((r.chainDoc["chains"] as Record<string, { rows: unknown[] }>)["NSE:NIFTY:2031-10-29"]?.rows).toHaveLength(3);
  });
  it("turns zero prices into nulls and drops a crossed market instead of publishing it", () => {
    const r = convertDhanOptionChain(resp({ "24500.000000": { ce: leg({ top_bid_price: 0, top_ask_price: 0, volume: 0 }), pe: leg({ top_bid_price: 130, top_ask_price: 120, greeks: { delta: -0.4, theta: -1, gamma: 0, vega: 1 } }) } }), IN);
    const q = r.quotesDoc["quotes"] as Record<string, Record<string, unknown>>;
    expect(q["NSE:NIFTY:2031-10-29:24500:CE"]).toMatchObject({ bid: null, ask: null, volume: 0 });
    expect(q["NSE:NIFTY:2031-10-29:24500:PE"]).toMatchObject({ bid: null, ask: null });
  });
  it("skips and lists a leg the agent would reject (wrong delta sign) rather than publishing it", () => {
    const r = convertDhanOptionChain(resp({ "24500.000000": { ce: leg(), pe: leg({ greeks: { delta: 0.5, theta: -1, gamma: 0, vega: 1 } }) } }), IN);
    expect(r.quoteCount).toBe(1);
    expect(r.skipped).toEqual([{ strike: 24500, optionType: "PE", reason: "delta" }]);
  });
  it("never invents previous IV or missing greeks", () => {
    const r = convertDhanOptionChain(resp({ "24500.000000": { ce: leg({ greeks: undefined }) } }), IN);
    expect((r.quotesDoc["quotes"] as Record<string, Record<string, unknown>>)["NSE:NIFTY:2031-10-29:24500:CE"]).toMatchObject({ iv_previous: null, delta: null, theta: null });
  });
  it("refuses malformed responses and bad input", () => {
    for (const bad of [null, [], { status: "failure" }, { status: "success", data: {} }, resp({}), resp({ "1": {} }, 0), resp({ "24500": { ce: leg({ last_price: 0, implied_volatility: 0 }) } })]) {
      expect(() => convertDhanOptionChain(bad, IN)).toThrow(DhanChainError);
    }
    expect(() => convertDhanOptionChain(resp({ "1": { ce: leg() } }), { ...IN, expiry: "29-10-2031" })).toThrow(DhanChainError);
  });
  it("is deterministic and holds no credential or network access", () => {
    const a = JSON.stringify(convertDhanOptionChain(resp({ "24500.000000": { ce: leg() } }), IN));
    expect(JSON.stringify(convertDhanOptionChain(resp({ "24500.000000": { ce: leg() } }), IN))).toBe(a);
  });
});
