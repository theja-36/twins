import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPaperRoutes } from "../../../apps/api/src/paperApi";
import { PaperTradeError, snapshotPriceSource, tradeFromDecision } from "../../../packages/paper/src/index";

const dir = (doc: unknown): string => { const d = mkdtempSync(join(tmpdir(), "paper-prices-")); writeFileSync(join(d, "last-price.json"), typeof doc === "string" ? doc : JSON.stringify(doc)); return d; };
const good = { format: "twins-last-price-v1", prices: { "NSE:NIFTY": { price: 24400.5, as_of: "2026-11-06T04:00:00.000Z" }, "BSE:SENSEX": { price: 78000, as_of: "2026-11-06T04:00:00.000Z" } } };

describe("snapshot price source", () => {
  it("resolves bare symbols on NSE/BSE/NFO and exact keys, returning price and its own timestamp", async () => {
    const s = snapshotPriceSource(dir(good));
    expect(await s.last("NIFTY")).toEqual({ price: 24400.5, at: "2026-11-06T04:00:00.000Z" }); expect((await s.last("SENSEX"))?.price).toBe(78000); expect((await s.last("NSE:NIFTY"))?.price).toBe(24400.5);
    expect(await s.last("BANKNIFTY")).toBeNull(); expect(await s.last("__proto__")).toBeNull();
  });
  it("returns null for a missing file, other formats, bad JSON and bad entries (nothing is guessed)", async () => {
    expect(await snapshotPriceSource(join(tmpdir(), "no-such-dir-paper")).last("NIFTY")).toBeNull();
    expect(await snapshotPriceSource(dir({ ...good, format: "other" })).last("NIFTY")).toBeNull(); expect(await snapshotPriceSource(dir("{not json")).last("NIFTY")).toBeNull();
    expect(await snapshotPriceSource(dir({ format: "twins-last-price-v1", prices: { "NSE:A": { price: -1, as_of: "2026-11-06T04:00:00Z" }, "NSE:B": { price: 5, as_of: "bad" }, "NSE:C": { price: "5", as_of: "2026-11-06T04:00:00Z" } } })).last("A")).toBeNull();
  });
});

describe("tradeFromDecision", () => {
  const d = (o: Record<string, unknown> = {}) => ({ id: "11111111-1111-1111-1111-111111111111", effectiveStatus: "APPROVED_FOR_REVIEW", symbol: "NIFTY", side: "BUY", entryPrice: "100", stopLoss: "95", target1: "110", target2: "120", target3: null, plannedQuantity: "50", ...o }) as never;
  it("maps an approved, current decision to a pending trade with its levels", () => {
    expect(tradeFromDecision(d(), "2026-11-06T04:00:00.000Z").trade).toMatchObject({ state: "PENDING_ENTRY", symbol: "NIFTY", side: "BUY", quantity: 50, entryPrice: 100, initialStop: 95, targets: [110, 120] });
  });
  it("refuses decisions that are not current or are incomplete / incoherent", () => {
    for (const o of [{ effectiveStatus: "SUPERSEDED" }, { effectiveStatus: "PENDING" }, { side: null }, { entryPrice: null }, { stopLoss: null }, { plannedQuantity: null }, { plannedQuantity: "2.5" }, { target1: null, target2: null }, { stopLoss: "105" }]) expect(() => tradeFromDecision(d(o), "2026-11-06T04:00:00.000Z")).toThrow(PaperTradeError);
  });
});

describe("paper API", () => {
  const app = Fastify(); registerPaperRoutes(app, { db: {} as never, authorized: (h) => h === "Bearer ok" });
  const auth = { authorization: "Bearer ok" };
  it("is bearer-protected on every route", async () => {
    for (const url of ["/paper/status", "/paper/summary", "/paper/positions", "/paper/outcomes", "/paper/outcomes/stats", "/paper/trades/11111111-1111-1111-1111-111111111111/events"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
  });
  it("validates input before touching the database", async () => {
    for (const url of ["/paper/positions?state=NOPE", "/paper/positions?limit=0", "/paper/outcomes?limit=9999", "/paper/trades/not-a-uuid/events"]) expect((await app.inject({ method: "GET", url, headers: auth })).statusCode, url).toBe(400);
  });
  it("has no write route: POST/PUT/PATCH/DELETE on any /paper path is not routed", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) for (const url of ["/paper/positions", "/paper/orders", "/paper/trades", "/paper/status"]) expect((await app.inject({ method, url, headers: auth })).statusCode, `${method} ${url}`).toBe(404);
  });
});
