import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clusterChannelNews, clusterIdOf, parseChannelNewsFile, type ChannelNewsItem } from "@twins/agents";

/**
 * Read model for GET /news/telegram. It reads ONE file, `channel-news.json` (`twins-channel-news-v1`, written by the worker-side exporter), through the agents' strict parser, and nothing else:
 * this module has no database access and no Telegram message text exists in the file. A missing, stale or unreadable file is reported as such (never as "no news").
 */
export const CHANNEL_NEWS_FILE = "channel-news.json";
export const STALE_AFTER_SECONDS = 3 * 3600; // the writer runs hourly
const MAX_BYTES = 2_000_000;

export type ChannelNewsStatus = "ok" | "stale" | "missing" | "invalid";
export interface ChannelNewsView {
  status: ChannelNewsStatus;
  reason: string | null;
  asOf: string | null;
  ageSeconds: number | null;
  items: Array<{ id: string; publishedAt: string; channel: string; symbols: string[]; themes: string[]; polarity: number; reliability: number }>;
  clusters: Array<{ clusterId: string; symbol: string | null; theme: string | null; bucketStart: string; items: number; channels: number; polarity: number; mixed: boolean }>;
}

const empty = (status: ChannelNewsStatus, reason: string, asOf: string | null = null, ageSeconds: number | null = null): ChannelNewsView => ({ status, reason, asOf, ageSeconds, items: [], clusters: [] });

export function readChannelNews(dir: string, now: Date, opts: { symbol?: string; limit: number }): ChannelNewsView {
  const path = join(dir, CHANNEL_NEWS_FILE);
  let text: string;
  try {
    if (statSync(path).size > MAX_BYTES) return empty("invalid", "file_too_large");
    text = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? empty("missing", "file_missing") : empty("invalid", "file_unreadable");
  }
  let items: ChannelNewsItem[], asOf: string;
  try {
    const raw = JSON.parse(text) as { as_of?: string };
    items = parseChannelNewsFile(raw);
    asOf = String(raw.as_of);
  } catch { return empty("invalid", "format_invalid"); }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(asOf)) / 1000));
  const status: ChannelNewsStatus = ageSeconds > STALE_AFTER_SECONDS ? "stale" : "ok";
  const chosen = opts.symbol ? items.filter((i) => i.symbols.includes(opts.symbol as string)) : items;
  const newest = [...chosen].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? -1 : 1));
  return {
    status, reason: status === "stale" ? "export_stale" : null, asOf, ageSeconds,
    items: newest.slice(0, opts.limit).map((i) => ({ id: i.id, publishedAt: i.publishedAt, channel: i.channel, symbols: i.symbols, themes: i.themes, polarity: i.polarity, reliability: i.reliability })),
    clusters: clusterChannelNews(chosen).map((c) => ({ clusterId: clusterIdOf(c), symbol: c.symbol, theme: c.theme, bucketStart: c.bucketStart, items: c.items, channels: c.channels, polarity: c.polarity, mixed: c.mixed })),
  };
}
