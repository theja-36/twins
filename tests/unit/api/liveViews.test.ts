import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProvidersView, readSnapshotView } from "../../../apps/api/src/liveApi";

const NOW = new Date("2026-11-05T09:00:00.000Z");
const tmp = () => mkdtempSync(join(tmpdir(), "live-"));
const w = (d: string, f: string, o: unknown) => writeFileSync(join(d, f), typeof o === "string" ? o : JSON.stringify(o));

describe("snapshot view", () => {
  it("reports an absent directory as not visible, never as healthy", () => {
    const v = readSnapshotView(join(tmpdir(), "nope-live-dir"), NOW);
    expect(v).toMatchObject({ visible: false, generation: null, indices: [], quoteCount: 0 }); expect(v.files.every((f) => !f.present)).toBe(true);
  });
  it("shows generation status, per-file age, index prices with the day's change, and quote counts", () => {
    const d = tmp();
    w(d, ".snapshot-generation.json", { status: "complete", generation: "kite-1" });
    w(d, "last-price.json", { format: "twins-last-price-v1", as_of: "2026-11-05T08:58:00.000Z", prices: { "NSE:NIFTY": { price: 24450, as_of: "2026-11-05T08:58:00.000Z" } } });
    w(d, "ohlc.json", { format: "twins-ohlc-v1", as_of: "2026-11-05T06:00:00.000Z", series: { "NSE:NIFTY": { bars: [{ t: "2026-11-04T00:00:00+05:30", o: 24060, h: 24300, l: 24000, c: 24200 }] } } });
    w(d, "quotes.json", { format: "twins-quotes-v1", as_of: "2026-11-05T08:58:00.000Z", quotes: { a: {}, b: {} } });
    w(d, "option-quotes.json", { as_of: "2026-11-05T08:58:00.000Z", quotes: { x: {} } });
    const v = readSnapshotView(d, NOW);
    expect(v.visible).toBe(true); expect(v.generation).toEqual({ status: "complete", id: "kite-1" });
    expect(v.files.find((f) => f.kind === "last-price")).toMatchObject({ present: true, ageSeconds: 120 }); expect(v.files.find((f) => f.kind === "option-chain")).toMatchObject({ present: false });
    expect(v.indices).toEqual([expect.objectContaining({ symbol: "NIFTY", level: 24450, previousClose: 24200, changePct1d: 1.033, ageSeconds: 120 })]); expect(v.quoteCount).toBe(2); expect(v.optionQuoteCount).toBe(1);
  });
  it("a corrupt or oversized file is reported absent-of-data, not trusted", () => {
    const d = tmp(); w(d, "last-price.json", "{not json"); w(d, "ohlc.json", "[]");
    expect(readSnapshotView(d, NOW).indices).toEqual([]);
  });
});

describe("provider files view", () => {
  it("lists each expected file with presence, as-of, age and item counts; missing ones are marked missing", () => {
    const d = tmp();
    w(d, "news.json", { format: "twins-news-v1", source: "gdelt-doc", as_of: "2026-11-05T08:30:00.000Z", items: [1, 2, 3] });
    w(d, "sentiment.json", { format: "twins-sentiment-v1", source: "gdelt-tone", as_of: "2026-11-05T08:30:00.000Z", entries: { "NSE:NIFTY": {} } });
    const v = readProvidersView(d, NOW);
    expect(v.find((x) => x.name === "news")).toMatchObject({ present: true, count: 3, ageSeconds: 1800, source: "gdelt-doc" }); expect(v.find((x) => x.name === "sentiment")).toMatchObject({ present: true, count: 1 });
    expect(v.find((x) => x.name === "macro-context")).toMatchObject({ present: false, count: null, asOf: null }); expect(v).toHaveLength(7);
  });
  it("a missing directory means nothing is present", () => { expect(readProvidersView(join(tmpdir(), "nope-prov-dir"), NOW).every((x) => !x.present)).toBe(true); });
});
