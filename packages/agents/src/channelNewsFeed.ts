import { createHash } from "node:crypto";
import { buildChannelNewsFile, dedupeChannelNews, extractChannelNews, type ChannelMessage, type ChannelNewsItem, type ExtractContext, type NewsCluster, type SkipReason } from "./channelNews";

/**
 * Telegram news feed builder (Phase 3, owner-approved design: file only, hourly batch). PURE: rows in, a `twins-channel-news-v1` document out.
 * Message text is read in memory by `extractChannelNews` and is not part of any output; item ids are hashes of the internal message id, so not even an identifier from Telegram appears.
 * Output is capped (items per file and per symbol) so that a flood cannot grow the file without limit.
 */
export const FEED_WINDOW_HOURS = 48;
export const MAX_CANDIDATES = 5000;
export const MAX_TEXT_CHARS = 2000;
export const MAX_ITEMS = 500;
export const MAX_ITEMS_PER_SYMBOL = 50;

export interface CandidateRow { id: string; channel: string; at: Date; text: string }

/** Keeps recent messages only (inside the window, not in the future), newest first, bounded in number and text length. */
export function selectNewsCandidates(rows: readonly CandidateRow[], now: Date, opts: { windowHours?: number; maxCandidates?: number } = {}): ChannelMessage[] {
  const from = now.getTime() - (opts.windowHours ?? FEED_WINDOW_HOURS) * 3_600_000, to = now.getTime();
  return rows
    .filter((r) => r.at.getTime() >= from && r.at.getTime() <= to && typeof r.text === "string" && r.text.trim() !== "")
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, opts.maxCandidates ?? MAX_CANDIDATES)
    .map((r) => ({ id: itemId(r.id), channel: r.channel, at: r.at, text: r.text.slice(0, MAX_TEXT_CHARS) }));
}

export const itemId = (internalId: string): string => `tm-${createHash("sha256").update(internalId).digest("hex").slice(0, 16)}`;
export const clusterIdOf = (c: Pick<NewsCluster, "symbol" | "theme" | "bucketStart">): string => `cl-${createHash("sha256").update(`${c.symbol ?? ""}|${c.theme ?? ""}|${c.bucketStart}`).digest("hex").slice(0, 12)}`;

export interface FeedBuild { document: Record<string, unknown>; items: ChannelNewsItem[]; skipped: Record<SkipReason, number>; considered: number; capped: number }

export function buildChannelNewsFeed(candidates: readonly ChannelMessage[], ctx: ExtractContext, now: Date): FeedBuild {
  const skipped: Record<SkipReason, number> = { signal_or_claim: 0, result_report: 0, empty: 0, no_symbols_or_themes: 0 };
  const extracted: ChannelNewsItem[] = [];
  for (const m of candidates) {
    const r = extractChannelNews(m, ctx);
    if ("item" in r) extracted.push(r.item); else skipped[r.skipped] += 1;
  }
  // Newest first, then enforce the caps.
  const deduped = dedupeChannelNews(extracted).map(({ duplicates: _d, ...i }) => i).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? -1 : 1));
  const perSymbol = new Map<string, number>();
  const kept: ChannelNewsItem[] = [];
  for (const it of deduped) {
    if (kept.length >= MAX_ITEMS) break;
    if (it.symbols.some((s) => (perSymbol.get(s) ?? 0) >= MAX_ITEMS_PER_SYMBOL)) continue;
    for (const s of it.symbols) perSymbol.set(s, (perSymbol.get(s) ?? 0) + 1);
    kept.push(it);
  }
  return { document: buildChannelNewsFile(kept, now), items: kept, skipped, considered: candidates.length, capped: deduped.length - kept.length };
}
