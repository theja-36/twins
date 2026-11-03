/**
 * The Kite market-data feed process (P0-3). READY BUT OFF: nothing starts it (compose profile `kite`, no timer enables it) until the owner decides to buy the Connect plan and approves a live run.
 *
 *   kite-ticker check-config     validates everything offline and prints a redacted summary (names and booleans, never values). No network. Exit 0, or 2 (configuration), 3 (plan is not
 *                                `connect`), 4 (no usable stored token).
 *   kite-ticker run              the market-day loop: sleeps outside the feed window (weekdays, 08:55-15:40 IST minus configured holidays), then loads the instruments dump and the index candles
 *                                (REST), connects the WebSocket ticker, and publishes one strict snapshot generation per interval (all-or-nothing). Stops when the token is rejected (exit 5).
 *
 * Reads: TWINS_KITE_API_KEY, TWINS_KITE_TOKEN_FILE (the 0600 file written by kite-login), TWINS_KITE_PLAN (must be `connect`), TWINS_KITE_HOLIDAYS, TWINS_KITE_UNDERLYINGS (default NIFTY,BANKNIFTY,SENSEX),
 * TWINS_KITE_OPTION_EXPIRIES (1-3, default 1), TWINS_KITE_EXPORT_INTERVAL_SECONDS (10-600, default 60 - UNAPPROVED), the wiring names of packages/kite, and TWINS_AGENT_SNAPSHOT_DIR /
 * TWINS_AGENT_SNAPSHOT_REQUIRED (where the generation is published). The shared live-trading guard runs first. Read-only: no order, GTT or portfolio path can be sent.
 */
import { pathToFileURL } from "node:url";
import { loadAgentRulesConfig } from "../../packages/agents/src/agents/rules";
import { loadSnapshotConfig } from "../../packages/agents/src/snapshots";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import {
  DEFAULT_FEED, KiteClient, KiteError, KiteFeedService, KiteTicker, KiteTokenStore, Session, SUPPORTED_UNDERLYINGS, builtinWebSocketFactory, getCandles, loadKiteConfig, loadKitePlan,
  loadKiteWiringConfig, loadMarketHours, marketState, runFeedLoop, websocketSource,
  type FeedLoopDeps, type KiteInstrument, type KiteUnderlying, type LoopEnd, type QuoteSource, type WsFactory,
} from "../../packages/kite/src/index";
import { DEFAULT_TOKEN_FILE } from "./kite-login";

export interface TickerDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  wsFactory?: WsFactory;
  shouldStop?: () => boolean;
  /** Test seam: replaces the real loop (which only ever sleeps and calls the service). */
  runLoop?: (deps: FeedLoopDeps) => Promise<LoopEnd>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}
const USAGE = "usage: kite-ticker check-config | run";
const EXIT = { ok: 0, failed: 1, config: 2, plan: 3, token: 4, authRejected: 5 } as const;

function parseUnderlyings(raw: string | undefined): KiteUnderlying[] {
  const list = (raw && raw.trim() ? raw : SUPPORTED_UNDERLYINGS.join(",")).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0 || list.some((u) => !(SUPPORTED_UNDERLYINGS as readonly string[]).includes(u)) || new Set(list).size !== list.length) throw new KiteError("CONFIG");
  return list as KiteUnderlying[];
}
function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return def;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new KiteError("CONFIG");
  return Number(raw);
}

export async function main(argv: string[], deps: TickerDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if ((cmd !== "check-config" && cmd !== "run") || rest.length > 0) { deps.err(USAGE); return EXIT.config; }
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let cfg, plan, hours, wiring, snapshotCfg, underlyings, optionExpiries, intervalSeconds, store;
  try {
    cfg = loadKiteConfig(deps.env);
    plan = loadKitePlan(deps.env);
    hours = loadMarketHours(deps.env);
    wiring = loadKiteWiringConfig(loadAgentRulesConfig(deps.env), deps.env);
    if (!deps.env["TWINS_AGENT_SNAPSHOT_DIR"]) throw new KiteError("CONFIG"); // the feed publishes snapshots: a directory is mandatory
    snapshotCfg = loadSnapshotConfig(deps.env);
    underlyings = parseUnderlyings(deps.env["TWINS_KITE_UNDERLYINGS"]);
    optionExpiries = intEnv(deps.env["TWINS_KITE_OPTION_EXPIRIES"], DEFAULT_FEED.optionExpiries, 1, 3);
    intervalSeconds = intEnv(deps.env["TWINS_KITE_EXPORT_INTERVAL_SECONDS"], 60, 10, 600);
    store = new KiteTokenStore(deps.env["TWINS_KITE_TOKEN_FILE"] || DEFAULT_TOKEN_FILE, now);
  } catch (e) { deps.err(JSON.stringify({ failed: true, stage: "configuration", code: e instanceof KiteError ? e.code : "ERROR" })); return EXIT.config; }

  if (plan !== "connect") { log("kite.feed.plan_restricted", { plan }); deps.err(JSON.stringify({ failed: true, code: "PLAN_RESTRICTED", plan })); return EXIT.plan; }
  const status = store.status();
  const stored = status.present && !status.advisoryExpired ? store.load(cfg.apiKey) : null;
  if (!stored) {
    const reason = !status.present ? status.reason : status.advisoryExpired ? "token_expired" : "token_for_another_key";
    log("kite.session.invalidated", { reason });
    deps.err(JSON.stringify({ failed: true, code: "NO_USABLE_TOKEN", reason }));
    return EXIT.token;
  }
  if (cmd === "check-config") {
    deps.out(JSON.stringify({ ok: true, plan, underlyings, optionExpiries, exportIntervalSeconds: intervalSeconds, marketStateNow: marketState(now(), hours), holidays: hours.holidays.size, token: { present: true, ...("advisoryExpiresAt" in status ? { advisoryExpiresAt: status.advisoryExpiresAt } : {}) }, snapshotDirConfigured: true, wiringProvenance: wiring.provenance }));
    return EXIT.ok;
  }

  // ── run ──
  const session = new Session(now, (reason) => { store.clear(); log("kite.session.invalidated", { reason }); });
  session.setToken(stored.accessToken);
  const client = new KiteClient({ apiKey: cfg.apiKey, session, plan, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const holder: { ticker?: KiteTicker; source?: QuoteSource } = {};
  const source: QuoteSource = {
    kind: "websocket", name: "kite-websocket",
    read: (i) => (holder.source ? holder.source.read(i) : { status: "unusable", source: "websocket", reason: "ticker_not_started" }),
  };
  const service = new KiteFeedService({ underlyings, optionExpiries, candleInterval: DEFAULT_FEED.candleInterval, candleLookbackDays: DEFAULT_FEED.candleLookbackDays, wiring }, {
    now, log, snapshotCfg, source,
    fetchInstrumentsCsv: () => client.getText("/instruments"),
    fetchCandles: (i: KiteInstrument, from, to, interval) => getCandles(client, i, { interval, from, to }, now),
    onCatalog: (catalog) => {
      holder.ticker?.dispose();
      holder.ticker = new KiteTicker({ apiKey: cfg.apiKey, session, catalog, plan, factory: deps.wsFactory ?? builtinWebSocketFactory(), log, checkSession: () => client.verifySession(), maxInstruments: 400 });
      holder.source = websocketSource(holder.ticker, { maxAgeMs: wiring.quoteMaxAgeMs });
      holder.ticker.start();
    },
    subscribe: (instruments) => holder.ticker?.subscribe(instruments, "full"),
  });
  const loopDeps: FeedLoopDeps = {
    service, hours, now, log, intervalMs: intervalSeconds * 1000,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    shouldStop: deps.shouldStop ?? (() => false),
    onWindowClose: () => holder.ticker?.stop(),
    health: () => { const s = holder.ticker?.state(); return s === "auth_failed" ? "auth_failed" : s === "failed" ? "ticker_failed" : null; },
  };
  const end = await (deps.runLoop ?? runFeedLoop)(loopDeps);
  holder.ticker?.dispose();
  if (end === "stopped") return EXIT.ok;
  deps.err(JSON.stringify({ stopped: true, reason: end.stoppedBecause }));
  return end.stoppedBecause === "auth_failed" ? EXIT.authRejected : EXIT.failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  enforceLiveTradingGuard("kite-ticker");
  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stop = true; });
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), shouldStop: () => stop, log: (e, f) => console.error(JSON.stringify({ level: "info", event: e, ...f })) }).then((c) => process.exit(c));
}
