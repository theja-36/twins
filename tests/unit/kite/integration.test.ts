/**
 * End to end with FIXTURE data: Kite responses -> real client -> adapters / exporter -> the actual TWINS consumers (agents through the real orchestrator,
 * the snapshot validation, and the file providers). No network, no credentials; this is not live compatibility evidence.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liquidityAgent, LIQUIDITY_AGENT_ID, optionsRiskAgent, OPTIONS_RISK_AGENT_ID } from "../../../packages/agents/src/index";
import { fileLastPriceProvider } from "../../../packages/agents/src/agents/ohlcProviders";
import { fileOptionsChainProvider, fileOptionsQuoteProvider, fileQuoteProvider } from "../../../packages/agents/src/agents/quoteProviders";
import { listSnapshots, loadSnapshotConfig } from "../../../packages/agents/src/snapshots";
import { buildSnapshotDocuments, kiteLastPriceProvider, kiteOptionsChainProvider, kiteOptionsQuoteProvider, kiteQuoteProvider, publishGeneration } from "../../../packages/kite/src/index";
import { codesOf, evalAgents, inputs, optionInputs } from "../../support/agentFixtures";
import { rulesWithQuotes } from "../../support/quoteFixtures";
import { catalog, rest } from "./helpers";

const cat = catalog();
const NOW = new Date("2026-11-02T10:16:30.000Z");
const CREATED = "2026-11-02T10:10:00.000Z";
const sc = { signalTimestamp: CREATED };
const futInputs = () => inputs({ rd: { instrumentType: "future", market: "NSE", symbol: "NIFTY", expiry: "2026-11-26", entryPrice: 24400, stopLoss: 24200, targets: [24600, 24800], createdAt: CREATED }, sf: { instrumentType: "FUTURE" }, sc });
const optInputs = () => optionInputs({ rd: { market: "NSE", symbol: "NIFTY", expiry: "2026-11-26", strike: 24000, optionType: "CE", entryPrice: 412, stopLoss: 330, targets: [480, 540], createdAt: CREATED }, sc });
const rules = () => rulesWithQuotes();

const runLiquidity = async (quotes: Parameters<typeof liquidityAgent>[1], prices: Parameters<typeof liquidityAgent>[2], inp = futInputs()) =>
  (await evalAgents([liquidityAgent(rules(), quotes, prices)], inp, {}, [], NOW)).byId(LIQUIDITY_AGENT_ID);
const runOptions = async (quotes: Parameters<typeof optionsRiskAgent>[1], chain: Parameters<typeof optionsRiskAgent>[2], prices: Parameters<typeof optionsRiskAgent>[4]) =>
  (await evalAgents([optionsRiskAgent(rules(), quotes, chain, null, prices)], optInputs(), {}, [], NOW)).byId(OPTIONS_RISK_AGENT_ID);

describe("Kite adapters -> the real Liquidity and Options Risk agents", () => {
  it("fixture REST data reaches the agents and is assessed on the upstream quote time", async () => {
    const src = await rest({ now: NOW.getTime() });
    const liq = await runLiquidity(kiteQuoteProvider(cat, src), kiteLastPriceProvider(cat, src));
    expect(liq.status).toBe("COMPLETED");
    expect(liq.outputSnapshot).toMatchObject({ provider: "kite-rest", instrumentType: "future", bid: 24399.9, ask: 24400.1, quoteAgeMinutes: 1 });
    expect(liq.verdict).not.toBe("UNAVAILABLE");
    const opt = await runOptions(kiteOptionsQuoteProvider(cat, src), kiteOptionsChainProvider(cat, src), kiteLastPriceProvider(cat, src));
    expect(opt.status).toBe("COMPLETED");
    expect(opt.outputSnapshot).toMatchObject({ provider: "kite-options-rest", chainProvider: "kite-chain-rest", premium: 412.5, strike: 24000, optionType: "CE", underlyingPrice: 24350.5 });
    expect(opt.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "option_quote"]));
  });
  it("stale, missing and limited Kite data stays unusable to the agents (no quote is invented)", async () => {
    const stale = await rest({ now: NOW.getTime() + 10 * 60_000, maxAgeMs: 60_000 });
    const staleRun = await runLiquidity(kiteQuoteProvider(cat, stale), null);
    const missing = await runLiquidity(kiteQuoteProvider(cat, await rest({ now: NOW.getTime(), drop: ["NFO:NIFTY26NOVFUT"] })), null);
    const limited = await runLiquidity(kiteQuoteProvider(cat, await rest({ now: NOW.getTime(), edit: (d) => { delete d["NFO:NIFTY26NOVFUT"].timestamp; } })), null);
    for (const r of [staleRun, missing, limited]) expect(r).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE" }); // an unusable Kite quote means NO assessment, not a softer one
    const optStale = await runOptions(kiteOptionsQuoteProvider(cat, stale), kiteOptionsChainProvider(cat, stale), null);
    expect(optStale).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE" });
  });
});

describe("Kite export -> published snapshots -> the same consumers", () => {
  it("agents fed from the PUBLISHED files reach the same assessments as agents fed by the live adapters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-kite-int-"));
    const cfg = loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: "instrument-reference,quotes,option-quotes,option-chain,last-price" });
    const src = await rest({ now: NOW.getTime() });
    const exported = buildSnapshotDocuments({ catalog: cat, source: src, generationId: "gen-int", now: NOW, referenceAsOf: "2026-11-02T10:00:00.000Z", quoteInstruments: cat.instruments, chains: [{ underlying: "NIFTY", expiry: "2026-11-26" }], candleKeys: [], candles: new Map() });
    expect(exported.report.complete).toBe(true);
    expect(publishGeneration(cfg, exported, { now: NOW })).toMatchObject({ published: true });
    expect(listSnapshots(cfg, NOW).ok).toBe(true);
    const f = (k: string): string => join(dir, `${k}.json`);
    const fromFiles = await runLiquidity(fileQuoteProvider(f("quotes")), fileLastPriceProvider(f("last-price")));
    const fromAdapter = await runLiquidity(kiteQuoteProvider(cat, src), kiteLastPriceProvider(cat, src));
    expect({ v: fromFiles.verdict, c: codesOf(fromFiles), bid: fromFiles.outputSnapshot["bid"], ask: fromFiles.outputSnapshot["ask"] }).toEqual({ v: fromAdapter.verdict, c: codesOf(fromAdapter), bid: fromAdapter.outputSnapshot["bid"], ask: fromAdapter.outputSnapshot["ask"] });
    const optFiles = await runOptions(fileOptionsQuoteProvider(f("option-quotes")), fileOptionsChainProvider(f("option-chain")), fileLastPriceProvider(f("last-price")));
    const optAdapter = await runOptions(kiteOptionsQuoteProvider(cat, src), kiteOptionsChainProvider(cat, src), kiteLastPriceProvider(cat, src));
    expect({ v: optFiles.verdict, c: codesOf(optFiles), p: optFiles.outputSnapshot["premium"], u: optFiles.outputSnapshot["underlyingPrice"] }).toEqual({ v: optAdapter.verdict, c: codesOf(optAdapter), p: optAdapter.outputSnapshot["premium"], u: optAdapter.outputSnapshot["underlyingPrice"] });
    expect(optFiles.status).toBe("COMPLETED");
  });
});
