import { describe, expect, it } from "vitest";
import { KiteError, KiteTicker, PLAN_CAPABILITIES, Session } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, catalog, clientWith, ok } from "./helpers";

describe("Kite plan capabilities", () => {
  it("states Personal has no market data and Connect has realtime + historical", () => {
    expect(PLAN_CAPABILITIES.personal).toMatchObject({ account: true, marketData: false, websocket: false, historical: false });
    expect(PLAN_CAPABILITIES.connect).toMatchObject({ account: true, marketData: true, websocket: true, historical: true });
  });
  it("personal plan refuses market data and historical locally, before any request; account reads still work", async () => {
    const { client, session, calls } = clientWith([ok({ user_id: "AB1234" }), ok({})], { plan: "personal" });
    session.setToken(ACCESS_TOKEN);
    await expect(client.getJson("/quote/ltp", { i: "NSE:INFY" })).rejects.toMatchObject({ code: "PLAN_RESTRICTED" });
    await expect(client.getJson("/instruments/historical/256265/day", {})).rejects.toMatchObject({ code: "PLAN_RESTRICTED" });
    expect(calls).toHaveLength(0);
    await client.getAccountJson("/portfolio/holdings");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method ?? "GET").toBe("GET");
  });
  it("the default plan is personal (fail closed)", async () => {
    const { client, session, calls } = clientWith([ok({})], { plan: undefined });
    session.setToken(ACCESS_TOKEN);
    await expect(client.getJson("/quote/ltp", { i: "NSE:INFY" })).rejects.toBeInstanceOf(KiteError);
    expect(calls).toHaveLength(0);
  });
  it("account paths are refused by getJson and market paths by getAccountJson", async () => {
    const { client, session } = clientWith([], {});
    session.setToken(ACCESS_TOKEN);
    await expect(client.getJson("/orders")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(client.getAccountJson("/quote/ltp")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(client.getAccountJson("/orders/regular")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });
  it("the ticker does not open a socket on the personal plan", () => {
    const opened: string[] = [];
    const session = new Session();
    session.setToken(ACCESS_TOKEN);
    const ticker = new KiteTicker({ apiKey: API_KEY, session, catalog: catalog(), factory: (u: string) => { opened.push(u); throw new Error("must not connect"); } } as never);
    ticker.start();
    expect(opened).toEqual([]);
  });
  it("session invalidation notifies the alert hook once, and a throwing hook cannot break the caller", () => {
    const seen: string[] = [];
    const s = new Session(undefined, (r) => { seen.push(r); throw new Error("hook"); });
    s.setToken(ACCESS_TOKEN);
    expect(() => s.markInvalid()).not.toThrow();
    expect(seen).toEqual(["server_rejected"]);
  });
});
