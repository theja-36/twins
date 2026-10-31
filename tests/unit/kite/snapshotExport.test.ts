import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileInstrumentReference } from "../../../packages/agents/src/agents/instrumentReference";
import { fileLastPriceProvider, fileOhlcProvider } from "../../../packages/agents/src/agents/ohlcProviders";
import { fileOptionsChainProvider, fileOptionsQuoteProvider, fileQuoteProvider } from "../../../packages/agents/src/agents/quoteProviders";
import { loadSnapshotConfig, listSnapshots, type SnapshotConfig } from "../../../packages/agents/src/snapshots";
import { buildSnapshotDocuments, mapCandles, publishGeneration, verifyGeneration, GENERATION_FILE, type ExportRequest, type ExportResult, type KiteInstrument, type QuoteSource } from "../../../packages/kite/src/index";
import { catalog, rest } from "./helpers";

const cat = catalog();
const EXPORT_NOW = new Date("2026-11-02T10:16:30.000Z");
const REQUIRED = "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc";
const rows = [["2026-10-28T00:00:00+0530", 24000, 24100, 23900, 24050, 0], ["2026-10-29T00:00:00+0530", 24050, 24200, 24000, 24150, 0], ["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]];
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const candles = new Map(((): Array<[string, NonNullable<ReturnType<typeof mapOk>>]> => [["NSE:NIFTY", mapOk() as never]])());
function mapOk() { const m = mapCandles({ instrument: nifty, interval: "day", candles: rows, fetchedAt: "2026-11-02T10:16:00.000Z", withOi: false }); return m.ok ? m.value : null; }

const cfgFor = (dir: string): SnapshotConfig => loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: REQUIRED });
const tmp = (): string => mkdtempSync(join(tmpdir(), "twins-kite-snap-"));
async function exportWith(source: QuoteSource, over: Partial<ExportRequest> = {}): Promise<ExportResult> {
  return buildSnapshotDocuments({
    catalog: cat, source, generationId: "gen-1", now: EXPORT_NOW, referenceAsOf: "2026-11-02T10:00:00.000Z",
    quoteInstruments: cat.instruments as readonly KiteInstrument[], chains: [{ underlying: "NIFTY", expiry: "2026-11-26" }], candleKeys: ["NSE:NIFTY"], candles, ...over,
  });
}

describe("snapshot documents", () => {
  it("builds the six versioned documents, each accepted by the consumer's strict parser; file as_of is the OLDEST upstream timestamp, never the export time", async () => {
    const r = await exportWith(await rest({ now: EXPORT_NOW.getTime() }));
    expect(Object.keys(r.documents).sort()).toEqual(["instrument-reference", "last-price", "ohlc", "option-chain", "option-quotes", "quotes"]);
    expect(r.report.complete).toBe(true);
    expect(r.report.sourceKind).toBe("rest");
    const byKind = Object.fromEntries(r.report.kinds.map((k) => [k.kind, k]));
    expect(byKind["quotes"]).toMatchObject({ status: "included", requested: 10, included: 10, asOf: "2026-11-02T10:15:56.000Z", missing: [] });
    expect(byKind["option-quotes"]).toMatchObject({ requested: 4, included: 4 });
    expect(byKind["last-price"]).toMatchObject({ requested: 3, included: 3 });
    expect(byKind["option-chain"]).toMatchObject({ requested: 1, included: 1, asOf: "2026-11-02T10:15:56.000Z" });
    expect(byKind["ohlc"]).toMatchObject({ included: 1, asOf: "2026-11-02T10:16:00.000Z" });
    expect(r.documents["quotes"]).toMatchObject({ format: "twins-quotes-v1", source: "kite-rest", as_of: "2026-11-02T10:15:56.000Z" });
    expect((r.documents["quotes"] as { quotes: Record<string, unknown> }).quotes["NSE:NIFTY:2026-11-26:24000:CE"]).toMatchObject({ bid: 412, ask: 413, open_interest: 1250000, as_of: "2026-11-02T10:15:56.000Z" });
    expect((r.documents["option-quotes"] as { quotes: Record<string, unknown> }).quotes["NSE:NIFTY:2026-11-26:24000:CE"]).toMatchObject({ iv: null, delta: null, underlying_price: 24350.5 });
    expect((r.documents["ohlc"] as { series: Record<string, { bars: unknown[] }> }).series["NSE:NIFTY"]?.bars).toHaveLength(3); // the forming 2026-11-02 bar is withheld
    expect(JSON.stringify(r.report)).not.toMatch(/access|token|api_key/i);
  });
  it("reports missing data explicitly and never marks an incomplete export complete", async () => {
    const r = await exportWith(await rest({ drop: ["NFO:BANKNIFTY26NOVFUT", "NFO:NIFTY26NOV24000PE"] }));
    expect(r.report.complete).toBe(false);
    const k = Object.fromEntries(r.report.kinds.map((x) => [x.kind, x]));
    expect(k["quotes"]).toMatchObject({ requested: 10, included: 8 });
    expect(k["quotes"]?.missing).toEqual(expect.arrayContaining([{ key: "NSE:BANKNIFTY:2026-11-26", reason: "missing_in_response" }, { key: "NSE:NIFTY:2026-11-26:24000:PE", reason: "missing_in_response" }]));
    expect(k["option-chain"]).toMatchObject({ status: "omitted", included: 0 }); // all-or-nothing
    expect(k["option-chain"]?.missing[0]?.reason).toBe("row_missing_in_response");
    expect(r.documents["option-chain"]).toBeUndefined();
  });
  it("stale or limited quotes are not exported; a request with nothing usable omits the kind", async () => {
    const r = await exportWith(await rest({ maxAgeMs: 1000, now: EXPORT_NOW.getTime() }));
    expect(r.documents["quotes"]).toBeUndefined();
    expect(r.report.kinds.find((x) => x.kind === "quotes")).toMatchObject({ status: "omitted", included: 0 });
    expect(r.report.kinds.find((x) => x.kind === "quotes")?.missing.every((m) => m.reason === "stale")).toBe(true);
    expect(r.report.complete).toBe(false);
    const nocandles = await exportWith(await rest(), { candleKeys: ["NSE:NIFTY", "NSE:BANKNIFTY"] });
    expect(nocandles.report.kinds.find((x) => x.kind === "ohlc")?.missing).toEqual([{ key: "NSE:BANKNIFTY", reason: "no_series" }]);
    expect(nocandles.report.complete).toBe(false);
  });
});

describe("publication", () => {
  it("publishes a complete generation that the consumer's snapshot validation accepts, and the consumer's file providers read it", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    const src = await rest({ now: EXPORT_NOW.getTime() });
    const result = await exportWith(src);
    const p = publishGeneration(cfg, result, { now: EXPORT_NOW });
    expect(p).toMatchObject({ published: true, generation: "gen-1", complete: true });
    const v = listSnapshots(cfg, EXPORT_NOW);
    expect(v.reports.filter((r) => REQUIRED.split(",").includes(r.kind)).map((r) => r.status)).toEqual(Array(6).fill("OK"));
    expect(verifyGeneration(cfg)).toEqual({ consistent: true, status: "complete", generation: "gen-1", mismatched: [] });
    expect(readdirSync(dir).filter((n) => n.startsWith(".staging") || n.endsWith(".tmp"))).toEqual([]);
    // the real consumers
    const f = (k: string): string => join(dir, `${k}.json`);
    const q = await fileQuoteProvider(f("quotes")).quote({ market: "NSE", symbol: "NIFTY", instrumentType: "future", expiry: "2026-11-26", strike: null, optionType: null });
    expect(q).toMatchObject({ last: 24400, bid: 24399.9, asOf: "2026-11-02T10:15:56.000Z" });
    expect(await fileOptionsQuoteProvider(f("option-quotes")).quote({ market: "NSE", symbol: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" })).toMatchObject({ premium: 412.35, iv: null });
    expect((await fileOptionsChainProvider(f("option-chain")).chain({ market: "NSE", underlying: "NIFTY", expiry: "2026-11-26" }))?.rows).toHaveLength(2);
    expect(await fileLastPriceProvider(f("last-price")).price({ market: "BSE", symbol: "SENSEX" })).toEqual({ price: 79120.5, asOf: "2026-11-02T10:15:58.000Z" });
    expect((await fileOhlcProvider(f("ohlc")).candles({ market: "NSE", symbol: "NIFTY", limit: 10, to: "2030-01-01T00:00:00.000Z" }))?.bars).toHaveLength(3);
    const ref = fileInstrumentReference(f("instrument-reference"));
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "future", expiry: "2026-11-26" })).toMatchObject({ lotSize: 75 });
    expect(await ref.underlyingKnown("NSE", "FINNIFTY")).toBe(false);
  });
  it("refuses an incomplete export by default and touches nothing; with requireComplete=false it publishes the valid part and records complete:false", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    const partial = await exportWith(await rest({ drop: ["NFO:NIFTY26NOV24000PE"] }));
    const refused = publishGeneration(cfg, partial, { now: EXPORT_NOW });
    expect(refused).toMatchObject({ published: false, reason: "INCOMPLETE_EXPORT", touched: false });
    expect(readdirSync(dir)).toEqual([]);
    const forced = publishGeneration(cfg, partial, { now: EXPORT_NOW, requireComplete: false });
    expect(forced).toMatchObject({ published: true, complete: false });
    expect(JSON.parse(readFileSync(join(dir, GENERATION_FILE), "utf8"))).toMatchObject({ status: "complete", complete: false });
    expect(existsSync(join(dir, "option-chain.json"))).toBe(false); // never a half chain
  });
  it("export time does not refresh data: upstream-stale documents are refused at staging by the consumer's own freshness rules", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    const src = await rest({ maxAgeMs: 3_600_000, now: EXPORT_NOW.getTime() + 20 * 60_000 }); // usable by the adapter's own limit, but 20+ minutes old
    const late = new Date(EXPORT_NOW.getTime() + 20 * 60_000);
    const result = buildSnapshotDocuments({ catalog: cat, source: src, generationId: "gen-late", now: late, referenceAsOf: "2026-11-02T10:00:00.000Z", quoteInstruments: cat.instruments, chains: [], candleKeys: [], candles: new Map() });
    const p = publishGeneration(cfg, result, { now: late, requireComplete: false });
    expect(p).toMatchObject({ published: false, reason: "STAGED_SNAPSHOT_NOT_OK", touched: false });
    expect((p as { detail: string[] }).detail.some((d) => d.startsWith("quotes:"))).toBe(true);
    expect(existsSync(join(dir, "quotes.json"))).toBe(false);
  });
  it("rejects a document the consumer's strict parser would reject, and unsafe directories", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    const bad: ExportResult = { documents: { quotes: { format: "twins-quotes-v1", source: "x", as_of: "2026-11-02T10:16:00.000Z", quotes: { "NSE:NIFTY": { bid: 2, ask: 1, last: 1, as_of: "2026-11-02T10:16:00.000Z" } } } }, report: { generationId: "bad", sourceKind: "rest", exportedAt: EXPORT_NOW.toISOString(), kinds: [], complete: true } };
    expect(publishGeneration(cfg, bad, { now: EXPORT_NOW })).toMatchObject({ published: false, reason: "STAGED_SNAPSHOT_NOT_OK" });
    const real = tmp(); const link = join(tmp(), "link"); symlinkSync(real, link);
    const good = await exportWith(await rest({ now: EXPORT_NOW.getTime() }));
    expect(publishGeneration(cfgFor(link), good, { now: EXPORT_NOW })).toMatchObject({ published: false, reason: "DIRECTORY_UNSAFE" });
  });
  it("a second generation replaces the first (previous kept) and other kinds' files are untouched", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    writeFileSync(join(dir, "news.json"), "{\"keep\":true}");
    const first = publishGeneration(cfg, await exportWith(await rest({ now: EXPORT_NOW.getTime() })), { now: EXPORT_NOW });
    expect(first.published).toBe(true);
    const later = new Date(EXPORT_NOW.getTime() + 60_000);
    const second = publishGeneration(cfg, { ...(await exportWith(await rest({ now: later.getTime(), maxAgeMs: 180_000 }), { generationId: "gen-2", now: later })) }, { now: later });
    expect(second).toMatchObject({ published: true, generation: "gen-2" });
    expect(verifyGeneration(cfg)).toMatchObject({ consistent: true, generation: "gen-2" });
    expect(readFileSync(join(dir, "news.json"), "utf8")).toBe("{\"keep\":true}");
    expect(existsSync(join(dir, ".previous", "quotes.json"))).toBe(true);
  });
  it("a failure part-way restores the previous generation completely (files and manifest); nothing from the failed generation remains", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    expect(publishGeneration(cfg, await exportWith(await rest({ now: EXPORT_NOW.getTime() })), { now: EXPORT_NOW }).published).toBe(true);
    const before = Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => [n, readFileSync(join(dir, n), "utf8")]));
    const later = new Date(EXPORT_NOW.getTime() + 60_000);
    const next = await exportWith(await rest({ now: later.getTime(), maxAgeMs: 180_000, edit: (d) => { d["NSE:NIFTY 50"].last_price = 24999; } }), { generationId: "gen-2", now: later });
    let renames = 0;
    const p = publishGeneration(cfg, next, { now: later, io: { rename: (from, to) => { renames += 1; if (renames === 3) throw new Error("disk full"); return require_rename(from, to); } } });
    expect(p).toMatchObject({ published: false, reason: "SNAPSHOT_WRITE_FAILED", rolledBack: true, touched: true });
    const after = Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => [n, readFileSync(join(dir, n), "utf8")]));
    expect(after).toEqual(before);
    expect(verifyGeneration(cfg)).toMatchObject({ consistent: true, generation: "gen-1", status: "complete" });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".rollback") || n.startsWith(".staging"))).toEqual([]);
  });
  it("a failure on a FIRST publish removes the files it created", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    let renames = 0;
    const p = publishGeneration(cfg, await exportWith(await rest({ now: EXPORT_NOW.getTime() })), { now: EXPORT_NOW, io: { rename: (from, to) => { renames += 1; if (renames === 4) throw new Error("boom"); return require_rename(from, to); } } });
    expect(p).toMatchObject({ published: false, rolledBack: true });
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect(verifyGeneration(cfg).status).toBe("none");
  });
  it("an interrupted publish (crash between files) is DETECTED as an inconsistent mixed generation", async () => {
    const dir = tmp(); const cfg = cfgFor(dir);
    expect(publishGeneration(cfg, await exportWith(await rest({ now: EXPORT_NOW.getTime() })), { now: EXPORT_NOW }).published).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, GENERATION_FILE), "utf8")) as Record<string, unknown>;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, GENERATION_FILE), JSON.stringify({ ...manifest, generation: "gen-crash", status: "publishing" })); // the marker a crashed publish leaves
    writeFileSync(join(dir, "quotes.json"), "{\"format\":\"twins-quotes-v1\"}"); // one new file landed, the rest are old
    const check = verifyGeneration(cfg);
    expect(check.consistent).toBe(false);
    expect(check).toMatchObject({ status: "publishing", generation: "gen-crash" });
    expect(check.mismatched).toContain("quotes");
  });
});
import { renameSync } from "node:fs";
const require_rename = renameSync;
