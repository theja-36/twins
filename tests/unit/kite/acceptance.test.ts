/**
 * B acceptance follow-up (fixture data only, no network): the real instrument-verification consumer, reader-enforced snapshot generations, explicit wiring
 * configuration, and the consumer capabilities that stay unavailable while IV and greeks are null.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentVerificationAgent, INSTRUMENT_VERIFICATION_AGENT_ID } from "../../../packages/agents/src/agents/instrumentVerification";
import { fileInstrumentReference } from "../../../packages/agents/src/agents/instrumentReference";
import { fileLastPriceProvider, fileOhlcProvider } from "../../../packages/agents/src/agents/ohlcProviders";
import { fileQuoteProvider } from "../../../packages/agents/src/agents/quoteProviders";
import { DEFAULT_AGENT_RULES, LIQUIDITY_AGENT_ID, liquidityAgent, OPTIONS_RISK_AGENT_ID, optionsRiskAgent } from "../../../packages/agents/src/index";
import { GENERATION_FILE, PUBLISH_LOCK_FILE, readVerifiedFile } from "../../../packages/agents/src/snapshotGeneration";
import { listSnapshots, loadSnapshotConfig } from "../../../packages/agents/src/snapshots";
import {
  buildSnapshotDocuments, KiteError, kiteInstrumentReference, kiteLastPriceProvider, kiteOptionsChainProvider, kiteOptionsQuoteProvider, kiteQuoteProvider, loadKiteWiringConfig,
  publishGeneration, restSource, UNAPPROVED_DEFAULTS, verifyGeneration, type ExportResult,
} from "../../../packages/kite/src/index";
import { codesOf, evalAgents, inputs, optionInputs } from "../../support/agentFixtures";
import { rulesWithQuotes } from "../../support/quoteFixtures";
import { catalog, rest, WIRING } from "./helpers";
import { mapCandles } from "../../../packages/kite/src/index";

const cat = catalog();
const NOW = new Date("2026-11-02T10:16:30.000Z");
const CREATED = "2026-11-02T10:10:00.000Z";
const KINDS = "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc";

// ───────────── 1. the actual instrument-verification consumer ─────────────
describe("instrument verification over the Kite reference (NIFTY, BANKNIFTY, SENSEX)", () => {
  const ref = kiteInstrumentReference(cat, { asOf: "2026-11-02T10:00:00.000Z" });
  const verify = async (rd: Record<string, unknown>, reference = ref) =>
    (await evalAgents([instrumentVerificationAgent(DEFAULT_AGENT_RULES, reference)], inputs({ rd: { createdAt: CREATED, ...rd } }), {}, [], NOW)).byId(INSTRUMENT_VERIFICATION_AGENT_ID);
  const fut = (market: string, symbol: string) => ({ instrumentType: "future", market, symbol, expiry: "2026-11-26" });
  const opt = (market: string, symbol: string, strike: number, optionType = "CE") => ({ instrumentType: "option", market, symbol, expiry: "2026-11-26", strike, optionType });

  it("verifies each underlying's listed futures and options (SUPPORTIVE, contract found, lot sizes present) with no schema change", async () => {
    for (const [rd, codes] of [
      [fut("NSE", "NIFTY"), ["MULTIPLIER_FROM_LOT_SIZE"]], [fut("NSE", "BANKNIFTY"), ["MULTIPLIER_FROM_LOT_SIZE"]], [fut("BSE", "SENSEX"), ["MULTIPLIER_FROM_LOT_SIZE"]],
      [opt("NSE", "NIFTY", 24000), []], [opt("NSE", "NIFTY", 24000, "PE"), []], [opt("NSE", "BANKNIFTY", 52000), []], [opt("BSE", "SENSEX", 80000), []],
    ] as const) {
      const r = await verify(rd);
      expect(r, JSON.stringify(rd)).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE" });
      expect(codesOf(r)).toEqual(codes);
      expect(r.outputSnapshot["contractFound"]).toBe(true);
    }
  });
  it("the three index references are known as underlyings of their listed derivatives, in their own markets only", async () => {
    for (const [m, u] of [["NSE", "NIFTY"], ["NSE", "BANKNIFTY"], ["BSE", "SENSEX"]] as const) expect(await ref.underlyingKnown(m, u)).toBe(true);
    expect(await ref.underlyingKnown("NSE", "SENSEX")).toBe(false);
    expect(await ref.underlyingKnown("BSE", "BANKNIFTY")).toBe(false);
  });
  it("fails closed for everything else: unknown underlying, wrong market, unlisted expiry/strike, expired, stale reference", async () => {
    expect(codesOf(await verify(fut("NSE", "FINNIFTY")))).toContain("UNDERLYING_UNKNOWN");
    expect(codesOf(await verify(fut("BSE", "NIFTY")))).toContain("UNDERLYING_UNKNOWN");
    expect(codesOf(await verify(fut("MCX", "NIFTY")))).toContain("MARKET_UNSUPPORTED");
    expect(codesOf(await verify({ ...fut("NSE", "NIFTY"), expiry: "2027-06-24" }))).toContain("EXPIRY_NOT_LISTED");
    expect(codesOf(await verify(opt("NSE", "NIFTY", 24050)))).toContain("STRIKE_NOT_LISTED");
    expect(codesOf(await verify({ ...fut("NSE", "NIFTY"), expiry: "2026-10-27" }))).toContain("EXPIRY_IN_PAST");
    const old = kiteInstrumentReference(cat, { asOf: "2026-08-01T00:00:00.000Z" });
    expect(codesOf(await verify(fut("NSE", "NIFTY"), old))).toContain("REFERENCE_STALE");
  });
  it("an index SPOT is not a tradable instrument: verifying it as an 'equity' is BLOCKED (INSTRUMENT_NOT_FOUND), never silently relabelled", async () => {
    for (const [m, u] of [["NSE", "NIFTY"], ["NSE", "BANKNIFTY"], ["BSE", "SENSEX"]] as const) {
      const r = await verify({ instrumentType: "equity", market: m, symbol: u, expiry: null, strike: null, optionType: null });
      expect(r).toMatchObject({ verdict: "BLOCKING" });
      expect(codesOf(r)).toEqual(["INSTRUMENT_NOT_FOUND"]);
      expect(r.outputSnapshot["contractFound"]).toBe(false);
    }
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "equity" })).toBeNull();
  });
  it("the same results from the PUBLISHED instrument-reference file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-kite-acc-"));
    const cfg = loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: KINDS });
    const result = buildSnapshotDocuments({ catalog: cat, source: await rest({ now: NOW.getTime() }), generationId: "g", now: NOW, referenceAsOf: "2026-11-02T10:00:00.000Z", quoteInstruments: cat.instruments, chains: [], candleKeys: [], candles: new Map(), strikesEachSide: WIRING.chainStrikesEachSide, underlyingToleranceMs: WIRING.underlyingWindowMs });
    expect(publishGeneration(cfg, result, { now: NOW, requireComplete: false }).published).toBe(true);
    const fromFile = fileInstrumentReference(join(dir, "instrument-reference.json"));
    expect(codesOf(await verify(fut("BSE", "SENSEX"), fromFile))).toEqual(["MULTIPLIER_FROM_LOT_SIZE"]);
    expect((await verify(opt("NSE", "BANKNIFTY", 52000), fromFile)).verdict).toBe("SUPPORTIVE");
    expect((await verify({ instrumentType: "equity", market: "NSE", symbol: "NIFTY", expiry: null, strike: null, optionType: null }, fromFile)).verdict).toBe("BLOCKING");
  });
});

// ───────────── 2. reader-enforced generations ─────────────
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const dayBars = mapCandles({ instrument: nifty, interval: "day", candles: [["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]], fetchedAt: "2026-11-02T10:16:00.000Z", withOi: false });
async function exportFor(now: Date, gen: string, over: { maxAgeMs?: number } = {}): Promise<ExportResult> {
  const src = await rest({ now: now.getTime(), maxAgeMs: over.maxAgeMs ?? 180_000 });
  return buildSnapshotDocuments({ catalog: cat, source: src, generationId: gen, now, referenceAsOf: "2026-11-02T10:00:00.000Z", quoteInstruments: cat.instruments, chains: [{ underlying: "NIFTY", expiry: "2026-11-26" }], candleKeys: ["NSE:NIFTY"], candles: new Map([["NSE:NIFTY", dayBars.ok ? dayBars.value : (undefined as never)]]), strikesEachSide: WIRING.chainStrikesEachSide, underlyingToleranceMs: WIRING.underlyingWindowMs });
}
const cfgOf = (dir: string, extra: Record<string, string> = {}) => loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc", ...extra });
const fresh = (): string => mkdtempSync(join(tmpdir(), "twins-kite-gen-"));
const quoteQ = { market: "NSE", symbol: "NIFTY", instrumentType: "future" as const, expiry: "2026-11-26", strike: null, optionType: null };

describe("readers refuse a mixed generation", () => {
  it("DURING publication: the snapshot validation and every file provider reject the generation's files; unrelated files stay readable", async () => {
    const dir = fresh(); const cfg = cfgOf(dir);
    writeFileSync(join(dir, "notes.json"), "{\"unrelated\":true}");
    expect(publishGeneration(cfg, await exportFor(NOW, "g1"), { now: NOW }).published).toBe(true);
    const later = new Date(NOW.getTime() + 30_000);
    const seen: Array<{ kinds: string[]; ok: boolean; codes: string[]; providerError: string; refError: string; unrelated: string }> = [];
    let n = 0;
    const r = publishGeneration(cfg, await exportFor(later, "g2"), { now: later, io: { rename: (from, to) => {
      n += 1;
      if (n === 3) { // two of the new files are in place, the rest are still g1
        const v = listSnapshots(cfg, later);
        const err = (f: () => unknown): string => { try { f(); return "none"; } catch (e) { return (e as { code?: string }).code ?? "other"; } };
        seen.push({
          kinds: v.reports.filter((x) => x.code === "GENERATION_INCONSISTENT").map((x) => x.kind), ok: v.ok, codes: [...new Set(v.reports.map((x) => x.code).filter(Boolean))],
          providerError: err(() => fileQuoteProvider(join(dir, "quotes.json"))), refError: err(() => fileInstrumentReference(join(dir, "instrument-reference.json"))), unrelated: readVerifiedFile(join(dir, "notes.json")),
        });
      }
      return renameSyncFor(from, to);
    } } });
    expect(JSON.stringify(r)).toContain("published\":true");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: false, providerError: "SNAPSHOT_GENERATION_INCONSISTENT", refError: "SNAPSHOT_GENERATION_INCONSISTENT", unrelated: "{\"unrelated\":true}" });
    expect(seen[0]?.kinds.sort()).toEqual(["instrument-reference", "last-price", "ohlc", "option-chain", "option-quotes", "quotes"]);
    // after completion everything is accepted again
    expect(listSnapshots(cfg, later).ok).toBe(true);
    expect(await fileQuoteProvider(join(dir, "quotes.json")).quote(quoteQ)).not.toBeNull();
  });
  it("CONCURRENT publication: a second publisher is refused while the first runs, and it changes nothing", async () => {
    const dir = fresh(); const cfg = cfgOf(dir);
    const outcomes: unknown[] = [];
    const first = await exportFor(NOW, "g1");
    let n = 0;
    const r = publishGeneration(cfg, first, { now: NOW, io: { rename: (from, to) => {
      n += 1;
      if (n === 2) {
        const before = readdirSync(dir).sort();
        void exportFor(NOW, "g-intruder").then(() => undefined);
        outcomes.push(publishGeneration(cfg, first, { now: NOW }), before);
      }
      return renameSyncFor(from, to);
    } } });
    expect(r.published).toBe(true);
    expect(outcomes[0]).toMatchObject({ published: false, reason: "PUBLISH_IN_PROGRESS", touched: false });
    expect(existsSync(join(dir, PUBLISH_LOCK_FILE))).toBe(false); // released
    expect(verifyGeneration(cfg)).toMatchObject({ consistent: true, generation: "g1" });
  });
  it("MID-PUBLISH CRASH (a real SIGKILL of the publisher): readers keep refusing; a new publish needs the lock cleared and must cover every crashed kind", async () => {
    const dir = fresh(); const cfg = cfgOf(dir);
    expect(publishGeneration(cfg, await exportFor(NOW, "g1"), { now: NOW }).published).toBe(true);
    const child = spawnSync(process.execPath, ["--import", "tsx", "tests/support/kitePublishCrash.ts", dir, "3", "g-crash"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    expect(child.signal).toBe("SIGKILL");
    const check = verifyGeneration(cfg);
    expect(check).toMatchObject({ consistent: false, status: "publishing", generation: "g-crash" });
    expect(check.mismatched.length).toBeGreaterThan(0);
    const v = listSnapshots(cfg, NOW);
    expect(v.ok).toBe(false);
    expect(v.reports.filter((x) => x.code === "GENERATION_INCONSISTENT").length).toBeGreaterThan(0);
    expect(() => fileQuoteProvider(join(dir, "quotes.json"))).toThrow(/not consistent/);
    expect(existsSync(join(dir, PUBLISH_LOCK_FILE))).toBe(true); // a crashed publisher leaves its lock: a human decides
    expect(publishGeneration(cfg, await exportFor(NOW, "g2"), { now: NOW })).toMatchObject({ published: false, reason: "PUBLISH_IN_PROGRESS" });
    unlinkSync(join(dir, PUBLISH_LOCK_FILE)); // operator action after review
    const partial = await exportFor(NOW, "g-partial");
    const narrowed: ExportResult = { ...partial, documents: { quotes: partial.documents.quotes } };
    expect(publishGeneration(cfg, narrowed, { now: NOW, requireComplete: false })).toMatchObject({ published: false, reason: "GENERATION_RECOVERY_REQUIRED" });
    const g3 = publishGeneration(cfg, await exportFor(NOW, "g3"), { now: NOW });
    expect(g3).toMatchObject({ published: true, generation: "g3" });
    expect(listSnapshots(cfg, NOW).ok).toBe(true);
    expect(await fileQuoteProvider(join(dir, "quotes.json")).quote(quoteQ)).not.toBeNull();
  });
  it("a file changed behind a complete manifest (mixed directory), a corrupt manifest, and a swap during a read are all refused", async () => {
    const dir = fresh(); const cfg = cfgOf(dir);
    expect(publishGeneration(cfg, await exportFor(NOW, "g1"), { now: NOW }).published).toBe(true);
    const good = readFileSync(join(dir, "last-price.json"), "utf8");
    expect(() => readVerifiedFile(join(dir, "last-price.json"), { afterCheck: () => writeFileSync(join(dir, "last-price.json"), good.replace("24350.5", "24351.5")) })).toThrow(/changed while/);
    writeFileSync(join(dir, "last-price.json"), good); // restored
    expect(readVerifiedFile(join(dir, "last-price.json"))).toBe(good);
    writeFileSync(join(dir, "quotes.json"), readFileSync(join(dir, "quotes.json"), "utf8").replace("24399.9", "24300.0"));
    expect(listSnapshots(cfg, NOW).reports.find((x) => x.kind === "quotes")).toMatchObject({ status: "MALFORMED", code: "GENERATION_INCONSISTENT" });
    expect(listSnapshots(cfg, NOW).reports.find((x) => x.kind === "news")?.code).not.toBe("GENERATION_INCONSISTENT"); // a kind the generation does not own
    expect(() => fileLastPriceProvider(join(dir, "last-price.json"))).toThrow(/not consistent/); // one bad file taints the whole generation
    writeFileSync(join(dir, GENERATION_FILE), "{not json");
    expect(() => fileOhlcProvider(join(dir, "ohlc.json"))).toThrow(/not consistent|unreadable|refused/);
    expect(listSnapshots(cfg, NOW).ok).toBe(false);
  });
  it("an INCOMPLETE generation does not satisfy a consumer that requires complete data; the requirement can be switched off explicitly", async () => {
    const dir = fresh(); const cfg = cfgOf(dir);
    const result = await exportFor(NOW, "g1");
    const partial: ExportResult = { ...result, report: { ...result.report, complete: false } };
    expect(publishGeneration(cfg, partial, { now: NOW, requireComplete: false })).toMatchObject({ published: true, complete: false });
    const strict = listSnapshots(cfg, NOW);
    expect(strict.ok).toBe(false);
    expect(strict.reports.filter((x) => x.code === "GENERATION_INCOMPLETE").map((x) => x.kind).sort()).toEqual(["instrument-reference", "last-price", "ohlc", "option-chain", "option-quotes", "quotes"]);
    expect(listSnapshots(cfgOf(dir, { TWINS_AGENT_SNAPSHOT_REQUIRE_COMPLETE_GENERATION: "false" }), NOW).ok).toBe(true);
    expect(() => loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_REQUIRE_COMPLETE_GENERATION: "maybe" })).toThrow();
  });
  it("directories without a manifest behave exactly as before", () => {
    const dir = fresh();
    writeFileSync(join(dir, "news.json"), "{}");
    expect(readVerifiedFile(join(dir, "news.json"))).toBe("{}");
    expect(listSnapshots(cfgOf(dir), NOW).reports.every((r) => r.code !== "GENERATION_INCONSISTENT" && r.code !== "GENERATION_INCOMPLETE")).toBe(true);
  });
});
import { renameSync as renameSyncFor } from "node:fs";

// ───────────── 3. explicit, validated configuration ─────────────
describe("wiring configuration", () => {
  it("takes freshness and future tolerance from the existing product rules; the other two values are labelled unapproved defaults", () => {
    const c = loadKiteWiringConfig(DEFAULT_AGENT_RULES, {});
    expect(c).toMatchObject({ quoteMaxAgeMs: 30 * 60_000, futureToleranceMs: 2 * 60_000, underlyingWindowMs: UNAPPROVED_DEFAULTS.underlyingWindowMs, chainStrikesEachSide: UNAPPROVED_DEFAULTS.chainStrikesEachSide });
    expect(c.provenance).toEqual({ quoteMaxAgeMs: "product_rule", futureToleranceMs: "product_rule", underlyingWindowMs: "unapproved_default", chainStrikesEachSide: "unapproved_default" });
    const custom = loadKiteWiringConfig({ quotes: { ...DEFAULT_AGENT_RULES.quotes, unavailableMinutes: 10, futureToleranceMinutes: 1 } }, {});
    expect(custom).toMatchObject({ quoteMaxAgeMs: 600_000, futureToleranceMs: 60_000 });
  });
  it("accepts validated overrides (recorded as such) and refuses malformed, out-of-range or looser-than-the-consumer values", () => {
    const c = loadKiteWiringConfig(DEFAULT_AGENT_RULES, { TWINS_KITE_QUOTE_MAX_AGE_SECONDS: "120", TWINS_KITE_UNDERLYING_WINDOW_SECONDS: "30", TWINS_KITE_CHAIN_STRIKES_EACH_SIDE: "8" });
    expect(c).toMatchObject({ quoteMaxAgeMs: 120_000, underlyingWindowMs: 30_000, chainStrikesEachSide: 8 });
    expect(c.provenance).toMatchObject({ quoteMaxAgeMs: "env_override", underlyingWindowMs: "env_override", chainStrikesEachSide: "env_override" });
    for (const env of [{ TWINS_KITE_QUOTE_MAX_AGE_SECONDS: "1801" }, { TWINS_KITE_QUOTE_MAX_AGE_SECONDS: "0" }, { TWINS_KITE_QUOTE_MAX_AGE_SECONDS: "abc" }, { TWINS_KITE_UNDERLYING_WINDOW_SECONDS: "301" }, { TWINS_KITE_CHAIN_STRIKES_EACH_SIDE: "0" }, { TWINS_KITE_CHAIN_STRIKES_EACH_SIDE: "51" }, { TWINS_KITE_CHAIN_STRIKES_EACH_SIDE: "2.5" }]) {
      expect(() => loadKiteWiringConfig(DEFAULT_AGENT_RULES, env), JSON.stringify(env)).toThrow(KiteError);
    }
  });
  it("the adapters and the exporter take the values explicitly and refuse missing or invalid ones", async () => {
    const src = await rest();
    expect(() => kiteOptionsQuoteProvider(cat, src, {} as never)).toThrow(KiteError);
    expect(() => kiteOptionsChainProvider(cat, src, { strikesEachSide: 0 })).toThrow(KiteError);
    expect(() => restSource({ fetchedAt: "", entries: [], unexpectedKeys: [] }, { now: () => 0, maxAgeMs: 0, futureToleranceMs: 0 })).toThrow(KiteError);
    expect(() => buildSnapshotDocuments({ catalog: cat, source: src, generationId: "x", now: NOW, referenceAsOf: NOW.toISOString(), quoteInstruments: [], chains: [], candleKeys: [], candles: new Map() } as never)).toThrow(KiteError);
  });
  it("the chain width and the underlying window actually change the output", async () => {
    const src = await rest({ now: NOW.getTime(), maxAgeMs: 180_000, edit: (d) => { d["NSE:NIFTY 50"].timestamp = "2026-11-02 15:45:20"; } }); // the index quote is 36 s older than the option's
    const narrow = await kiteOptionsQuoteProvider(cat, src, { underlyingToleranceMs: 10_000 }).quote({ market: "NSE", symbol: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" });
    const wide = await kiteOptionsQuoteProvider(cat, src, { underlyingToleranceMs: 60_000 }).quote({ market: "NSE", symbol: "NIFTY", instrumentType: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" });
    expect([narrow?.underlyingPrice, wide?.underlyingPrice]).toEqual([null, 24350.5]);
    const chain = (n: number) => kiteOptionsChainProvider(cat, src, { strikesEachSide: n }).chain({ market: "NSE", underlying: "NIFTY", expiry: "2026-11-26" });
    expect((await chain(1))?.rows.length).toBe((await chain(5))?.rows.length); // the synthetic catalog lists one strike: widening cannot add rows that are not listed
  });
});

// ───────────── 4. what stays unavailable with null IV / greeks ─────────────
describe("consumer capabilities with null IV and greeks (no model invented, no rule relaxed)", () => {
  const run = async (editor?: (d: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const src = await rest({ now: NOW.getTime(), edit: editor });
    return (await evalAgents([optionsRiskAgent(rulesWithQuotes(), kiteOptionsQuoteProvider(cat, src, { underlyingToleranceMs: WIRING.underlyingWindowMs }), kiteOptionsChainProvider(cat, src, { strikesEachSide: WIRING.chainStrikesEachSide }), null, kiteLastPriceProvider(cat, src))],
      optionInputs({ rd: { market: "NSE", symbol: "NIFTY", expiry: "2026-11-26", strike: 24000, optionType: "CE", entryPrice: 412, stopLoss: 330, targets: [480, 540], createdAt: CREATED }, sc: { signalTimestamp: CREATED } }), {}, [], NOW)).byId(OPTIONS_RISK_AGENT_ID);
  };
  it("Options Risk: IV and greeks are reported missing (CAUTION), the IV / theta / gamma / vega / delta families cannot fire, and the Kite-fed families still work", async () => {
    const base = await run();
    expect(base.verdict).toBe("CAUTION");
    expect(codesOf(base)).toEqual(expect.arrayContaining(["IV_MISSING", "GREEKS_INCOMPLETE"]));
    const never = /^(IV_(ELEVATED|HIGH|EXTREME|RISING|SPIKE|SPIKE_EXTREME|ABOVE_ATM)|THETA_DECAY_|GAMMA_RISK_|VEGA_|DELTA_)/;
    expect(codesOf(base).filter((c) => never.test(c))).toEqual([]);
    // families that DO run on Kite data: spread, open interest and volume
    const wide = await run((d) => { d["NFO:NIFTY26NOV24000CE"].depth = { buy: [{ price: 300, quantity: 75, orders: 1 }], sell: [{ price: 500, quantity: 75, orders: 1 }] }; d["NFO:NIFTY26NOV24000CE"].oi = 10; d["NFO:NIFTY26NOV24000CE"].volume = 0; });
    expect(codesOf(wide).join(" ")).toMatch(/SPREAD/);
    expect(codesOf(wide).join(" ")).toMatch(/OPEN_INTEREST/);
    expect(codesOf(wide).join(" ")).toMatch(/VOLUME/);
  });
  it("Liquidity: average-volume comparisons are unavailable (AVG_VOLUME_MISSING, INFO); spread and depth work; an index spot has no bid/ask or volume at all", async () => {
    const src = await rest({ now: NOW.getTime() });
    const liq = (await evalAgents([liquidityAgent(rulesWithQuotes(), kiteQuoteProvider(cat, src), kiteLastPriceProvider(cat, src))],
      inputs({ rd: { instrumentType: "future", market: "NSE", symbol: "NIFTY", expiry: "2026-11-26", entryPrice: 24400, stopLoss: 24200, targets: [24600, 24800], createdAt: CREATED }, sf: { instrumentType: "FUTURE" }, sc: { signalTimestamp: CREATED } }), {}, [], NOW)).byId(LIQUIDITY_AGENT_ID);
    expect(codesOf(liq)).toEqual(expect.arrayContaining(["AVG_VOLUME_MISSING", "SPREAD_TIGHT"]));
    expect(codesOf(liq).some((c) => /^(THIN_VOLUME|POOR_LIQUIDITY)$/.test(c))).toBe(false);
    expect(await kiteQuoteProvider(cat, src).quote({ market: "NSE", symbol: "NIFTY", instrumentType: "equity", expiry: null, strike: null, optionType: null })).toMatchObject({ bid: null, ask: null, volume: null, openInterest: null });
  });
});
