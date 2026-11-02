import { describe, expect, it } from "vitest";
import { KiteError, parseCsv, parseInstrumentsCsv } from "../../../packages/kite/src/index";
import { csv } from "./helpers";

const HEADER = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange";
const IDX = "256265,1001,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE\n260105,1016,NIFTY BANK,NIFTY BANK,0,,0,0,0,EQ,INDICES,NSE\n265,1,SENSEX,SENSEX,0,,0,0,0,EQ,INDICES,BSE";
const code = (f: () => unknown): string => { try { f(); return "no error"; } catch (e) { return e instanceof KiteError ? e.code : "other"; } };

describe("instruments CSV (synthetic fixture)", () => {
  const cat = parseInstrumentsCsv(csv());
  it("keeps only NIFTY 50, BANKNIFTY and SENSEX references and their futures/options; counts everything else", () => {
    expect(cat.instruments.map((i) => i.tradingSymbol).sort()).toEqual([
      "BANKNIFTY26NOV52000CE", "BANKNIFTY26NOVFUT", "NIFTY 50", "NIFTY BANK", "NIFTY26NOV24000CE", "NIFTY26NOV24000PE", "NIFTY26NOVFUT", "SENSEX", "SENSEX26NOV80000CE", "SENSEX26NOVFUT",
    ]);
    expect(cat.stats).toMatchObject({ rows: 13, inScope: 10, outOfScope: 3 }); // FINNIFTY option, RELIANCE equity, RELIANCE option with a quoted comma
    expect(cat.stats.rejected).toEqual([]);
  });
  it("looks up exact contracts and index references", () => {
    expect(cat.lookup({ underlying: "nifty", kind: "index" })?.token).toBe(256265);
    expect(cat.lookup({ underlying: "BANKNIFTY", kind: "index" })?.token).toBe(260105);
    expect(cat.lookup({ underlying: "SENSEX", kind: "index" })?.exchange).toBe("BSE");
    expect(cat.lookup({ underlying: "NIFTY", kind: "option", expiry: "2026-11-26", strike: 24000, optionType: "pe" })).toMatchObject({ token: 9000003, lotSize: 75, strike: 24000, optionType: "PE", exchange: "NFO" });
    expect(cat.lookup({ underlying: "SENSEX", kind: "future", expiry: "2026-11-26" })).toMatchObject({ token: 9000007, exchange: "BFO" });
    expect(cat.listedExpiries("NIFTY", "option")).toEqual(["2026-11-26"]);
  });
  it("fails closed: unlisted contracts are null/UNSUPPORTED_CONTRACT; unsupported underlyings THROW UNSUPPORTED_UNDERLYING (never null)", () => {
    expect(cat.lookup({ underlying: "NIFTY", kind: "option", expiry: "2026-11-26", strike: 24050, optionType: "CE" })).toBeNull();
    expect(cat.lookup({ underlying: "NIFTY", kind: "option", expiry: "2026-12-31", strike: 24000, optionType: "CE" })).toBeNull();
    expect(cat.lookup({ underlying: "NIFTY", kind: "option", expiry: "2026-11-26", strike: 24000, optionType: null })).toBeNull();
    expect(cat.lookup({ underlying: "NIFTY", kind: "future", expiry: "26-11-2026" })).toBeNull();
    expect(code(() => cat.require({ underlying: "NIFTY", kind: "future", expiry: "2027-01-28" }))).toBe("UNSUPPORTED_CONTRACT");
    for (const u of ["FINNIFTY", "RELIANCE", "MIDCPNIFTY", "", "NIFTY BANK", "BANKEX"]) {
      expect(code(() => cat.lookup({ underlying: u, kind: "index" }))).toBe("UNSUPPORTED_UNDERLYING");
      expect(code(() => cat.listedExpiries(u, "option"))).toBe("UNSUPPORTED_UNDERLYING");
    }
    expect(cat.underlyingKnown("FINNIFTY")).toBe(false);
    expect(cat.underlyingKnown("banknifty")).toBe(true);
  });
  it("does not let a look-alike row in the wrong exchange/segment into scope", () => {
    const sneaky = `${HEADER}\n${IDX}\n9,9,NIFTY26NOV24000CE,NIFTY,0,2026-11-26,24000,0.05,75,CE,BFO-OPT,BFO\n10,10,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,BSE`;
    const c = parseInstrumentsCsv(sneaky);
    expect(c.instruments).toHaveLength(3);
    expect(c.stats.outOfScope).toBe(2);
  });
});

describe("malformed input", () => {
  const withRows = (...rows: string[]): string => `${HEADER}\n${IDX}\n${rows.join("\n")}\n`;
  it("rejects (reports, never repairs) malformed in-scope rows", () => {
    const c = parseInstrumentsCsv(withRows(
      "1,1,NIFTY26NOV24000CE,NIFTY,0,2026-11-26,abc,0.05,75,CE,NFO-OPT,NFO",
      "2,2,NIFTY26NOV24100CE,NIFTY,0,2026-02-31,24100,0.05,75,CE,NFO-OPT,NFO",
      "3,3,NIFTY26NOV24200CE,NIFTY,0,2026-11-26,24200,0.05,0,CE,NFO-OPT,NFO",
      "4,4,NIFTY26NOV24300XX,NIFTY,0,2026-11-26,24300,0.05,75,XX,NFO-OPT,NFO",
      "5,5,NIFTY26NOVFUT,NIFTY,0,2026-11-26,0,0.1,75,CE,NFO-FUT,NFO",
      "x,6,NIFTY26NOV24400CE,NIFTY,0,2026-11-26,24400,0.05,75,CE,NFO-OPT,NFO",
      "7,7,NIFTY26NOV24500CE,NIFTY,0,2026-11-26,-5,0.05,75,CE,NFO-OPT,NFO",
      "8,8,short",
    ));
    expect(c.stats.rejected.map((r) => r.reason)).toEqual(["bad_strike", "bad_expiry", "bad_lot_size", "bad_instrument_type", "bad_instrument_type", "bad_number", "bad_strike"]);
    expect(c.instruments).toHaveLength(3);
  });
  it("treats a whole dump as unusable when ambiguous or incomplete", () => {
    expect(code(() => parseInstrumentsCsv(""))).toBe("INSTRUMENTS_INVALID");
    expect(code(() => parseInstrumentsCsv("a,b,c\n1,2,3"))).toBe("INSTRUMENTS_INVALID");
    expect(code(() => parseInstrumentsCsv(`${HEADER}\n`))).toBe("INSTRUMENTS_INVALID"); // no index references
    expect(code(() => parseInstrumentsCsv(`${HEADER}\n256265,1001,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE\n260105,1016,NIFTY BANK,NIFTY BANK,0,,0,0,0,EQ,INDICES,NSE`))).toBe("INSTRUMENTS_INVALID"); // SENSEX missing
    expect(code(() => parseInstrumentsCsv(withRows("256265,9,NIFTY26NOVFUT,NIFTY,0,2026-11-26,0,0.1,75,FUT,NFO-FUT,NFO")))).toBe("INSTRUMENTS_INVALID"); // duplicate token
    expect(code(() => parseInstrumentsCsv(withRows("11,1,A,NIFTY,0,2026-11-26,0,0.1,75,FUT,NFO-FUT,NFO", "12,2,B,NIFTY,0,2026-11-26,0,0.1,75,FUT,NFO-FUT,NFO")))).toBe("INSTRUMENTS_INVALID"); // duplicate contract
    expect(code(() => parseInstrumentsCsv(`${HEADER}\n"unterminated`))).toBe("INSTRUMENTS_INVALID");
  });
  it("parses quoted fields, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"']]);
    const c = parseInstrumentsCsv(`﻿${HEADER}\r\n${IDX.replace(/\n/g, "\r\n")}\r\n`);
    expect(c.instruments).toHaveLength(3);
  });
});
