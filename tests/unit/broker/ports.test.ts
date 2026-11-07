import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrokerPortError, createFakeReadOnlyBroker } from "../../../adapters/broker/src/ports";

const ref = { exchange: "NSE", tradingSymbol: "NIFTY 50", token: "256265" };

describe("read-only broker ports", () => {
  it("serves data from the fake without any I/O", async () => {
    const b = createFakeReadOnlyBroker({
      instruments: [ref],
      quotes: [{ ref, lastPrice: 100, asOf: "2026-11-09T04:00:00Z" }],
      candles: [
        { start: "2026-11-09T03:45:00Z", open: 1, high: 2, low: 1, close: 2, volume: 5 },
        { start: "2026-11-09T05:00:00Z", open: 1, high: 2, low: 1, close: 2, volume: 5 },
      ],
      funds: { availableCash: 1000 },
    });
    expect(await b.instruments()).toHaveLength(1);
    expect(await b.quotes([ref])).toHaveLength(1);
    expect(await b.candles(ref, "15minute", new Date("2026-11-09T03:00:00Z"), new Date("2026-11-09T04:00:00Z"))).toHaveLength(1);
    expect((await b.funds()).availableCash).toBe(1000);
    expect(await b.status()).toEqual({ valid: true, expiresAt: null });
  });

  it("fails closed with a fixed code when the session is invalid", async () => {
    const b = createFakeReadOnlyBroker({ sessionValid: false });
    await expect(b.quotes([ref])).rejects.toMatchObject({ code: "session_invalid", message: "session_invalid" });
    await expect(b.positions()).rejects.toBeInstanceOf(BrokerPortError);
  });

  it("exposes no order-writing method and no network or env access in the source", () => {
    const b = createFakeReadOnlyBroker();
    for (const k of Object.keys(b)) expect(k).not.toMatch(/order|place|cancel|modify|execute/i);
    const src = readFileSync("adapters/broker/src/ports.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/fetch\(|http|process\.env|node:|import /);
  });
});
