import { describe, expect, it } from "vitest";
import { buildDataset } from "../../../packages/historical/src/outcomes/dataset";
import { BarsDatasetError, buildBarsDataset } from "../../../packages/kite/src/barsDataset";
import type { KiteInstrument } from "../../../packages/kite/src/instruments";
import type { MappedCandles } from "../../../packages/kite/src/historical";

// SYNTHETIC candles; no Kite call was made.
const inst = (o: Partial<KiteInstrument> = {}): KiteInstrument => ({ token: 1, exchangeToken: 1, tradingSymbol: "NIFTY 50", underlying: "NIFTY", kind: "index", exchange: "NSE", segment: "INDICES", expiry: null, strike: null, optionType: null, lotSize: null, tickSize: 0.05, ...o });
const bar = (d: number, c = 100) => ({ t: `2031-10-${String(d).padStart(2, "0")}T00:00:00+05:30`, open: c, high: c + 2, low: c - 2, close: c, volume: null as number | null });
const mapped = (bars = [bar(20), bar(21), bar(22)], o: Partial<MappedCandles> = {}): MappedCandles => ({ series: { symbol: "NIFTY 50", intervalSeconds: 86_400, bars }, openInterest: null, duplicatesRemoved: 0, fetchedAt: "2031-10-23T00:00:00Z", lastBarMayBeOpen: false, ...o });
const ID = { providerId: "kite", datasetId: "d1", datasetVersion: "1" };

describe("buildBarsDataset (pure)", () => {
  it("produces a document the evaluator's strict dataset parser accepts", () => {
    const doc = buildBarsDataset({ ...ID, inputs: [{ instrument: inst(), mapped: mapped() }] });
    const ds = buildDataset(doc, "x".repeat(64));
    expect(ds.series[0]).toMatchObject({ key: { kind: "underlying_price", symbol: "NIFTY", market: "NSE" } });
    expect(ds.series[0]?.bars).toHaveLength(3);
  });
  it("carries option contract fields and open interest", () => {
    const o = inst({ kind: "option", tradingSymbol: "NIFTY31OCT24500CE", exchange: "NFO", expiry: "2031-10-30", strike: 24500, optionType: "CE" });
    const doc = buildBarsDataset({ ...ID, inputs: [{ instrument: o, mapped: mapped([bar(20, 50), bar(21, 55)], { openInterest: [10, null] }) }] });
    const ds = buildDataset(doc, "y".repeat(64));
    expect(ds.series[0]?.key).toMatchObject({ kind: "option_premium", strike: 24500, optionType: "CE", expiry: "2031-10-30" });
    expect(ds.series[0]?.bars[0]?.openInterest).toBe(10);
    expect(ds.series[0]?.bars[1]?.openInterest).toBeNull();
  });
  it("drops a possibly-open last bar and refuses futures and empty input", () => {
    const doc = buildBarsDataset({ ...ID, inputs: [{ instrument: inst(), mapped: mapped(undefined, { lastBarMayBeOpen: true }) }] });
    expect((doc["series"] as Array<{ bars: unknown[] }>)[0]?.bars).toHaveLength(2);
    expect(() => buildBarsDataset({ ...ID, inputs: [{ instrument: inst({ kind: "future" }), mapped: mapped() }] })).toThrow(BarsDatasetError);
    expect(() => buildBarsDataset({ ...ID, inputs: [] })).toThrow(BarsDatasetError);
    expect(() => buildBarsDataset({ ...ID, inputs: [{ instrument: inst(), mapped: mapped([bar(20)], { lastBarMayBeOpen: true }) }] })).toThrow(BarsDatasetError);
  });
});
