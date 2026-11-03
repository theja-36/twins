import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSnapshotConfig } from "../../../packages/agents/src/snapshots";
import { GENERATION_FILE, KiteError, KiteFeedService, DEFAULT_FEED, type FeedDeps, type KiteInstrument, type RawCandles } from "../../../packages/kite/src/index";
import { catalog, csv, rest, NOW_MS, WIRING } from "./helpers";

const NOW = new Date(NOW_MS);
const KINDS = "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc";
const cat = catalog();
const candlesFor = (i: KiteInstrument): RawCandles => ({ instrument: i, interval: "day", candles: [["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]], fetchedAt: NOW.toISOString(), withOi: false });

async function harness(over: Partial<FeedDeps> = {}, underlyings: Array<"NIFTY" | "BANKNIFTY" | "SENSEX"> = ["NIFTY"]) {
  const dir = mkdtempSync(join(tmpdir(), "twins-feed-"));
  const subscribed: number[][] = [];
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const calls = { csv: 0, candles: 0 };
  const deps: FeedDeps = {
    now: () => NOW,
    fetchInstrumentsCsv: async () => { calls.csv += 1; return csv(); },
    fetchCandles: async (i) => { calls.candles += 1; return candlesFor(i); },
    subscribe: (ins) => { subscribed.push(ins.map((i) => i.token)); },
    source: await rest({ now: NOW_MS, maxAgeMs: 180_000 }),
    snapshotCfg: loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: KINDS }),
    log: (e, f) => { logs.push([e, f]); },
    ...over,
  };
  const svc = new KiteFeedService({ underlyings, ...DEFAULT_FEED, wiring: WIRING }, deps);
  return { svc, dir, subscribed, logs, calls };
}

describe("KiteFeedService (fixtures only, no network)", () => {
  it("prepareDay: one instruments fetch, one candle fetch per underlying, the indices subscribed; repeating it the same day does nothing", async () => {
    const h = await harness();
    expect(h.svc.ready()).toBe(false);
    await h.svc.prepareDay();
    expect(h.svc.ready()).toBe(true);
    expect(h.calls).toEqual({ csv: 1, candles: 1 });
    expect(h.subscribed).toEqual([[cat.require({ underlying: "NIFTY", kind: "index" }).token]]);
    await h.svc.prepareDay();
    expect(h.calls).toEqual({ csv: 1, candles: 1 });
  });
  it("cycle before prepareDay refuses to publish anything", async () => {
    const h = await harness();
    expect(await h.svc.cycle()).toEqual({ published: false, reason: "day_not_prepared", detail: [] });
    expect(readdirSync(h.dir)).toEqual([]);
  });
  it("cycle subscribes the near-the-money option window of the nearest expiry (once) and publishes one complete generation of all six kinds", async () => {
    const h = await harness();
    await h.svc.prepareDay();
    const first = await h.svc.cycle();
    expect(first.published, JSON.stringify(first)).toBe(true);
    if (first.published) expect([...first.kinds].sort()).toEqual(KINDS.split(",").sort());
    expect(h.subscribed.length).toBeGreaterThanOrEqual(2); // indices, then the option window
    const files = readdirSync(h.dir).filter((f) => f.endsWith(".json")).sort();
    for (const k of KINDS.split(",")) expect(files, k).toContain(`${k}.json`);
    const quotes = JSON.parse(readFileSync(join(h.dir, "quotes.json"), "utf8")) as { source: string; quotes: Record<string, unknown> };
    expect(quotes.source).toBe("kite-rest"); // the fixture source here; the process wiring passes the websocket source
    // a second cycle subscribes nothing new and publishes a new generation
    const before = h.subscribed.length;
    const second = await h.svc.cycle();
    expect(second.published).toBe(true);
    expect(h.subscribed.length).toBe(before);
  });
  it("a stale or missing quote means NOTHING is published (all-or-nothing), with the reason; the previous generation stays untouched", async () => {
    const good = await harness();
    await good.svc.prepareDay();
    expect((await good.svc.cycle()).published).toBe(true);
    const manifest = readFileSync(join(good.dir, GENERATION_FILE), "utf8");
    const stale = await rest({ now: NOW_MS + 10 * 60_000, maxAgeMs: 180_000 }); // ten minutes later: every upstream timestamp is too old
    const bad = await harness({ source: stale, snapshotCfg: loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: good.dir, TWINS_AGENT_SNAPSHOT_REQUIRED: KINDS }) });
    await bad.svc.prepareDay();
    const r = await bad.svc.cycle();
    expect(r.published).toBe(false);
    expect(readFileSync(join(good.dir, GENERATION_FILE), "utf8")).toBe(manifest);
    expect(bad.logs.some(([e]) => e === "kite.feed.not_published")).toBe(true);
  });
  it("an unusable instruments dump stops the day: nothing is subscribed and the error is raised", async () => {
    const h = await harness({ fetchInstrumentsCsv: async () => "not,a,dump\n" });
    await expect(h.svc.prepareDay()).rejects.toBeInstanceOf(KiteError);
    expect(h.subscribed).toEqual([]);
    expect(h.svc.ready()).toBe(false);
  });
  it("rejects a nonsensical configuration (no underlyings, unsupported underlying, absurd expiry count)", async () => {
    const h = await harness();
    const mk = (c: object) => () => new KiteFeedService({ underlyings: ["NIFTY"], ...DEFAULT_FEED, wiring: WIRING, ...c } as never, {} as never);
    expect(mk({ underlyings: [] })).toThrow(KiteError);
    expect(mk({ underlyings: ["RELIANCE"] })).toThrow(KiteError);
    expect(mk({ optionExpiries: 9 })).toThrow(KiteError);
    void h;
  });
});
