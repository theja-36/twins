import type { SnapshotConfig } from "@twins/agents/src/snapshots";
import { KiteError } from "./errors";
import { mapCandles, type KiteInterval, type MappedCandles, type RawCandles } from "./historical";
import { parseInstrumentsCsv, SUPPORTED_UNDERLYINGS, type InstrumentCatalog, type KiteInstrument, type KiteUnderlying } from "./instruments";
import type { QuoteSource } from "./quoteBook";
import { buildSnapshotDocuments, type ExportResult } from "./twinsExport";
import { publishGeneration, type PublishResult } from "./twinsPublish";
import { spotKey } from "./twinsMapping";
import type { KiteWiringConfig } from "./wiringConfig";

/**
 * The market-day orchestration around the ticker (P0-3, dormant until the owner starts it): one process owns ONE snapshot generation per cycle, because readers refuse a mixed generation.
 *   prepareDay()  once per trading day, inside the feed window: the instruments dump (one REST call) -> catalog, the daily candles of the index spots (a few REST calls), and the subscription
 *                 of the indices to the WebSocket ticker.
 *   cycle()       every export interval: subscribes the near-the-money options of the nearest expiries (the window follows the index), then exports everything in one generation and
 *                 publishes it with the strict, all-or-nothing publisher. An incomplete export (any requested entry missing or stale) publishes NOTHING and reports why: stale data is never served.
 * Every external effect is injected, so the whole flow is exercised with fixtures; nothing here opens a socket or reads a clock by itself.
 */
export interface FeedConfig {
  underlyings: readonly KiteUnderlying[];
  /** How many of the nearest listed option expiries per underlying are subscribed and exported as chains. UNAPPROVED default 1. */
  optionExpiries: number;
  /** Candle interval and look-back for the ohlc snapshot. UNAPPROVED defaults: day, 30 days. */
  candleInterval: KiteInterval;
  candleLookbackDays: number;
  wiring: KiteWiringConfig;
}
export const DEFAULT_FEED = { optionExpiries: 1, candleInterval: "day" as KiteInterval, candleLookbackDays: 30 } as const;

export interface FeedDeps {
  now: () => Date;
  fetchInstrumentsCsv: () => Promise<string>;
  fetchCandles: (instrument: KiteInstrument, from: Date, to: Date, interval: KiteInterval) => Promise<RawCandles>;
  /** Called once the day's catalog is loaded and BEFORE any subscription: the process creates and starts the ticker here (the ticker needs the catalog). */
  onCatalog?: (catalog: InstrumentCatalog) => void;
  /** Subscribes instruments on the ticker (the real wiring passes `ticker.subscribe`). */
  subscribe: (instruments: readonly KiteInstrument[]) => void;
  source: QuoteSource;
  snapshotCfg: SnapshotConfig;
  publish?: (cfg: SnapshotConfig, result: ExportResult, opts: { now: Date; requireComplete: boolean }) => PublishResult;
  log: (event: string, fields?: Record<string, unknown>) => void;
  newGenerationId?: (now: Date) => string;
}

export type CycleOutcome =
  | { published: true; generation: string; kinds: string[] }
  | { published: false; reason: string; detail: string[] };

const istDate = (d: Date): string => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const defaultGen = (d: Date): string => `kite-${d.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;

export class KiteFeedService {
  private catalog: InstrumentCatalog | null = null;
  private referenceAsOf: string | null = null;
  private candles = new Map<string, MappedCandles>();
  private readonly subscribed = new Set<number>();
  private preparedFor: string | null = null;

  constructor(private readonly cfg: FeedConfig, private readonly d: FeedDeps) {
    if (cfg.underlyings.length === 0 || cfg.underlyings.some((u) => !(SUPPORTED_UNDERLYINGS as readonly string[]).includes(u))) throw new KiteError("CONFIG");
    if (!Number.isInteger(cfg.optionExpiries) || cfg.optionExpiries < 1 || cfg.optionExpiries > 3) throw new KiteError("CONFIG");
  }

  /** True once the day's reference data is loaded. */
  ready(): boolean { return this.catalog !== null && this.preparedFor === istDate(this.d.now()); }

  async prepareDay(): Promise<void> {
    const now = this.d.now();
    const today = istDate(now);
    if (this.preparedFor === today && this.catalog) return;
    const catalog = parseInstrumentsCsv(await this.d.fetchInstrumentsCsv()); // an unusable dump THROWS (CONFIG-class error): nothing is subscribed on a bad reference
    const candles = new Map<string, MappedCandles>();
    const from = new Date(now.getTime() - this.cfg.candleLookbackDays * 86_400_000);
    for (const u of this.cfg.underlyings) {
      const index = catalog.lookup({ underlying: u, kind: "index" });
      if (!index) { this.d.log("kite.feed.index_not_listed", { underlying: u }); continue; }
      const mapped = mapCandles(await this.d.fetchCandles(index, from, now, this.cfg.candleInterval));
      if (mapped.ok) candles.set(spotKey(u), mapped.value); else this.d.log("kite.feed.candles_unusable", { underlying: u, reason: mapped.reason });
    }
    this.catalog = catalog; this.candles = candles; this.referenceAsOf = now.toISOString(); this.preparedFor = today; this.subscribed.clear();
    const indices = this.cfg.underlyings.map((u) => catalog.lookup({ underlying: u, kind: "index" })).filter((i): i is KiteInstrument => i !== null);
    this.d.onCatalog?.(catalog);
    this.d.subscribe(indices);
    for (const i of indices) this.subscribed.add(i.token);
    this.d.log("kite.feed.day_prepared", { date: today, instruments: catalog.instruments.length, indices: indices.length, candleSeries: candles.size });
  }

  /** The expiries (nearest first, not in the past) whose option chains are subscribed and exported. */
  expiries(): Array<{ underlying: KiteUnderlying; expiry: string }> {
    if (!this.catalog) return [];
    const today = istDate(this.d.now());
    return this.cfg.underlyings.flatMap((u) => this.catalog?.listedExpiries(u, "option").filter((e) => e >= today).slice(0, this.cfg.optionExpiries).map((expiry) => ({ underlying: u, expiry })) ?? []);
  }

  /** Subscribes the strike window around the index's current price (idempotent; the window moves with the index). Needs a usable index reading first. */
  private subscribeOptions(): number {
    const catalog = this.catalog as InstrumentCatalog;
    let added = 0;
    for (const { underlying, expiry } of this.expiries()) {
      const index = catalog.lookup({ underlying, kind: "index" });
      const spot = index ? this.d.source.read(index) : null;
      if (!spot || spot.status !== "usable" || spot.quote.last === null) continue;
      const options = catalog.instruments.filter((i) => i.underlying === underlying && i.kind === "option" && i.expiry === expiry);
      const strikes = [...new Set(options.map((i) => i.strike as number))].sort((a, b) => a - b);
      if (strikes.length === 0) continue;
      const last = spot.quote.last;
      const atm = strikes.reduce((best, s) => (Math.abs(s - last) < Math.abs(best - last) ? s : best), strikes[0] as number);
      const at = strikes.indexOf(atm);
      const keep = new Set(strikes.slice(Math.max(0, at - this.cfg.wiring.chainStrikesEachSide - 1), at + this.cfg.wiring.chainStrikesEachSide + 2));
      const fresh = options.filter((i) => keep.has(i.strike as number) && !this.subscribed.has(i.token));
      if (fresh.length) { this.d.subscribe(fresh); for (const i of fresh) this.subscribed.add(i.token); added += fresh.length; }
    }
    return added;
  }

  async cycle(): Promise<CycleOutcome> {
    if (!this.catalog || !this.referenceAsOf) return { published: false, reason: "day_not_prepared", detail: [] };
    const now = this.d.now();
    const added = this.subscribeOptions();
    const catalog = this.catalog;
    const chains = this.expiries();
    const subscribedInstruments = catalog.instruments.filter((i) => this.subscribed.has(i.token));
    const result = buildSnapshotDocuments({
      catalog, source: this.d.source, generationId: (this.d.newGenerationId ?? defaultGen)(now), now, referenceAsOf: this.referenceAsOf,
      quoteInstruments: subscribedInstruments, chains, strikesEachSide: this.cfg.wiring.chainStrikesEachSide,
      candleKeys: [...this.candles.keys()], candles: this.candles, underlyingToleranceMs: this.cfg.wiring.underlyingWindowMs,
    });
    const published = (this.d.publish ?? ((c, r, o) => publishGeneration(c, r, o)))(this.d.snapshotCfg, result, { now, requireComplete: true });
    if (published.published) {
      this.d.log("kite.feed.published", { generation: published.generation, kinds: published.kinds, subscribedNow: added });
      return { published: true, generation: published.generation, kinds: published.kinds };
    }
    this.d.log("kite.feed.not_published", { reason: published.reason, detail: published.detail.slice(0, 10), touched: published.touched });
    return { published: false, reason: published.reason, detail: published.detail };
  }
}
