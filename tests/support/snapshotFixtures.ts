import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patternKeys } from "@twins/historical";
import { FEATURES } from "./agentHistoryFixtures";
import { SNAPSHOT_KINDS, type SnapshotKind } from "../../packages/agents/src/index";
import { NOW } from "./agentFixtures";

/** SYNTHETIC valid snapshot documents for every kind, stamped `as_of` (default: one hour before NOW). */
const KEY4 = patternKeys(FEATURES)[3]?.keyText as string;
export const iso = (hoursBeforeNow: number): string => new Date(NOW.getTime() - hoursBeforeNow * 3_600_000).toISOString();
export function snapshotDoc(kind: SnapshotKind, asOf: string = iso(1)): Record<string, unknown> {
  const head = (format: string) => ({ format, source: "synthetic", as_of: asOf });
  switch (kind) {
    case "holiday-calendar": return { ...head("twins-holiday-calendar-v1"), markets: { NSE: { from: "2025-01-01", to: "2025-12-31", days: [{ date: "2025-03-14", holiday: true, name: "Holi" }] } } };
    case "economic-calendar": return { ...head("twins-economic-calendar-v1"), coverage: { from: "2025-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z" }, events: [{ id: "ev-1", name: "Rate decision", at: "2025-02-07T04:30:00Z", impact: "HIGH", markets: ["NSE"], category: "central_bank" }] };
    case "macro-context": return { ...head("twins-macro-context-v1"), contexts: { "NSE:*": { index: { symbol: "NIFTY", level: 24500, previous_close: 24400, open: 24450, recent_closes: [24100, 24200, 24300, 24400] } } } };
    case "news": return { ...head("twins-news-v1"), items: [{ id: "n1", published_at: asOf, source_label: "Wire", headline: "A synthetic headline", symbols: ["ACME"], markets: ["NSE"], sentiment_label: "NEUTRAL", impact: "LOW", category: "earnings" }] };
    case "sentiment": return { ...head("twins-sentiment-v1"), entries: { "NSE:ACME": { score: 0.1, label: "NEUTRAL", sample_size: 10, as_of: asOf } } };
    case "constituents": return { ...head("twins-index-constituents-v1"), indices: { NIFTY: { as_of: asOf, constituents: [{ symbol: "ACME", weight: 50, sector: "Energy", data_as_of: asOf }] } } };
    case "market-data": return { ...head("twins-market-quotes-v1"), quotes: { "NSE:ACME": { change_pct_1d: -0.8, as_of: asOf } } };
    case "quotes": return { ...head("twins-quotes-v1"), quotes: { "NSE:ACME": { bid: 99.9, ask: 100.1, last: 100, volume: 1000, avg_volume: 5000, as_of: asOf } } };
    case "option-quotes": return { ...head("twins-option-quotes-v1"), quotes: { "NSE:NIFTY:2025-01-30:24500:CE": { premium: 120, bid: 119, ask: 121, iv: 15, delta: 0.5, as_of: asOf } } };
    case "option-chain": return { ...head("twins-option-chain-v1"), chains: { "NSE:NIFTY:2025-01-30": { underlying_price: 24500, as_of: asOf, rows: [{ strike: 24500, option_type: "CE", iv: 15, open_interest: 1, volume: 1 }] } } };
    case "ohlc": return { ...head("twins-ohlc-v1"), series: { "NSE:ACME": { interval_seconds: 86400, bars: [
      { t: "2025-01-02T03:45:00Z", o: 100, h: 102, l: 99, c: 101 }, { t: "2025-01-03T03:45:00Z", o: 101, h: 103, l: 100, c: 102 }, { t: "2025-01-06T03:45:00Z", o: 102, h: 104, l: 101, c: 103 }] } } };
    case "last-price": return { ...head("twins-last-price-v1"), prices: { "NSE:ACME": { price: 100, as_of: asOf } } };
    case "instrument-reference": return { ...head("twins-instrument-reference-v1"), markets: ["NSE"], instruments: [{ market: "NSE", underlying: "ACME", instrument_type: "equity", lot_size: 1, active: true }] };
    case "historical-patterns": return { ...head("twins-historical-patterns-v1"), patterns: { [KEY4]: { level: 4, status: "SUFFICIENT", sample_size: 120, as_of: asOf, first_observed: "2022-01-01T00:00:00Z", last_observed: "2024-12-01T00:00:00Z", regime_mix: { TRENDING: 0.6, RANGE: 0.4 }, volatility_mix: { LOW: 0.2, NORMAL: 0.6, HIGH: 0.2 } } } };
    case "historical-outcomes": return { ...head("twins-historical-outcomes-v1"), outcomes: { [KEY4]: { evaluable: 120, entered: 100, wins: 65, losses: 35, no_entry: 15, expired_after_entry: 0, unverifiable: 10, net_expectancy_r: 0.3, net_expectancy_lower_bound_r: 0.1, average_winner_r: 1.5, average_loser_r: -1, as_of: asOf } } };
  }
}
export const tmpSnapshotDir = (): string => { const d = mkdtempSync(join(tmpdir(), "twins-snap-")); mkdirSync(join(d, "snaps")); return join(d, "snaps"); };
/** Writes valid documents for the given kinds (default: all) into `dir`. */
/** The quote-like kinds have a 30-minute maximum age, so by default they are stamped 3 minutes old and the rest one hour old. */
export const FAST_KINDS: readonly SnapshotKind[] = ["quotes", "option-quotes", "option-chain"];
export function populate(dir: string, kinds: readonly SnapshotKind[] = SNAPSHOT_KINDS, asOf?: string): void {
  for (const k of kinds) writeFileSync(join(dir, `${k}.json`), JSON.stringify(snapshotDoc(k, asOf ?? (FAST_KINDS.includes(k) ? iso(0.05) : iso(1)))));
}
