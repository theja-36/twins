/**
 * Channel news writer (Phase 3, owner-approved design: file only, hourly with the exporter). READ-ONLY toward the database (one SELECT of recent messages); writes ONE file,
 * `channel-news.json` (`twins-channel-news-v1`), atomically into the providers folder. It contacts no Telegram, provider or broker, and prints COUNTS only: never message text.
 * The file holds structured fields only (hashed item id, masked channel, time, symbols, fixed theme codes, polarity, reliability). If anything fails, the previous file stays in place.
 *
 *   channel-news-export [--dir <providers folder>]      (default: TWINS_PROVIDERS_DIR; DATABASE_URL must be set)
 *
 * NOT installed anywhere yet. Exit codes: 0 ok, 1 failure, 2 usage.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, gte } from "drizzle-orm";
import { buildChannelNewsFeed, parseChannelNewsFile, selectNewsCandidates, FEED_WINDOW_HOURS, type MessageClassifier } from "../../packages/agents/src/index";
import { analyzeTelegramText } from "../../packages/signals/src/index";
import { publishJson } from "../../packages/providers/src/publish";
import { createBoundedDb, schema, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
}
const USAGE = "usage: channel-news-export [--dir <providers folder>]";
const INDEX_NAMES = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
const SYMBOL = /^[A-Z][A-Z0-9&.-]{1,19}$/;

export const classify: MessageClassifier = (text) => {
  const a = analyzeTelegramText(text);
  if (a.kind === "none") return a.reason === "result_report" ? "result_report" : "none";
  return "signal_or_claim";
};

/** Symbols the instrument reference knows: the index names plus every constituent in index-constituents.json (absent or unreadable file = indices only). */
export function loadSymbols(dir: string): Set<string> {
  const set = new Set(INDEX_NAMES);
  try {
    const raw = JSON.parse(readFileSync(join(dir, "index-constituents.json"), "utf8")) as { indices?: Record<string, { constituents?: Array<{ symbol?: unknown }> }> };
    for (const idx of Object.values(raw.indices ?? {})) for (const c of idx.constituents ?? []) if (typeof c.symbol === "string" && SYMBOL.test(c.symbol)) set.add(c.symbol);
  } catch { /* indices only */ }
  return set;
}

const mask = (id: string): string => (id.length > 4 ? `***${id.slice(-4)}` : "***");

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let dir = deps.env["TWINS_PROVIDERS_DIR"];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i]; else { deps.err(USAGE); return 2; }
  }
  if (!dir) { deps.err(USAGE); return 2; }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
  const now = (deps.now ?? (() => new Date()))();
  const handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
  try {
    const M = schema.telegramMessages, S = schema.telegramSources;
    const since = new Date(now.getTime() - FEED_WINDOW_HOURS * 3_600_000);
    const rows = await handle.db.select({ id: M.id, channel: S.channelIdentifier, at: M.messageTimestamp, text: M.rawText }).from(M).innerJoin(S, eq(S.id, M.telegramSourceId)).where(and(gte(M.messageTimestamp, since)));
    const candidates = selectNewsCandidates(rows.map((r) => ({ id: String(r.id), channel: mask(String(r.channel)), at: r.at, text: r.text ?? "" })), now);
    const build = buildChannelNewsFeed(candidates, { symbols: loadSymbols(resolve(dir)), classify }, now);
    const { bytes } = publishJson(resolve(dir), "channel-news.json", build.document, parseChannelNewsFile);
    const s = build.skipped;
    deps.out(`channel-news-v1: ${rows.length} rows read, ${build.considered} considered -> ${build.items.length} items (${build.capped} over caps); skipped: signal/claim ${s.signal_or_claim}, result report ${s.result_report}, empty ${s.empty}, no symbols or themes ${s.no_symbols_or_themes}; wrote channel-news.json (${bytes} bytes)`);
    return 0;
  } catch (error) {
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`); // the previous file is untouched
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("channel-news-export");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
