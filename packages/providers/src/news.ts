import { createHash } from "node:crypto";
import { GdeltNewsAdapter, type GdeltTransport } from "@twins/adapter-news";
import { NEWS_FORMAT, SENTIMENT_FORMAT } from "@twins/agents";
import { ProviderFetchError, type Fetcher } from "./http";

/**
 * News and sentiment from GDELT (free, no key, one request per 5 seconds). WHAT THIS IS AND IS NOT:
 *  - Articles: GDELT supplies discovery metadata only (headline, URL, domain, first-seen time). It supplies NO per-article sentiment, impact or category, and `seendate` is not the publisher's
 *    publication time. The agents' news format requires those fields, so every article is written as the least informative honest value (NEUTRAL, no score, LOW, "unclassified") with a LOW source
 *    reliability (0.3) so a reliability floor can ignore it. These items are for discovery and context, never evidence of a pass.
 *  - Sentiment: the only real tone signal is GDELT's aggregate average-tone timeline for a query; it is turned into one entry per watched symbol with the article count as the sample size.
 *  - Symbols are tagged by simple keyword matching on the headline against the configured watch list; an article that matches nothing is tagged market-wide (`*`).
 */
export interface WatchEntry { symbol: string; market: string; keywords: string[] }
/** Sentiment is requested for the first entry only by default (the index-level tone costs two requests; GDELT limits hard). Add entries through the configured watch list. */
export const DEFAULT_WATCH: readonly WatchEntry[] = [
  { symbol: "NIFTY", market: "NSE", keywords: ["nifty 50", "nifty"] },
  { symbol: "BANKNIFTY", market: "NSE", keywords: ["bank nifty", "banknifty"] },
  { symbol: "SENSEX", market: "BSE", keywords: ["sensex"] },
];
// `sourcecountry:india` is the form verified against the live service (2026-11-05: an article list came back); `sourcecountry:IN` plus `sourcelang:english` returned an empty `{}`.
const BASE_FILTER = "sourcecountry:india";
const clean = (s: string): string => s.replace(/[^A-Za-z0-9 &._-]/g, "_");
const quote = (k: string): string => (/\s/.test(k) ? `"${k.replace(/"/g, "")}"` : k);
export const watchQuery = (w: readonly WatchEntry[]): string => `(${w.flatMap((e) => e.keywords).map(quote).join(" OR ")}) ${BASE_FILTER}`;

export class NewsDataError extends Error { constructor() { super("the news response failed validation"); this.name = "NewsDataError"; } }

export interface NewsBuild { document: Record<string, unknown>; items: number; tagged: number }
export async function buildNews(deps: { transport: GdeltTransport; watch?: readonly WatchEntry[]; now: () => Date; sinceHours?: number; maxItems?: number }): Promise<NewsBuild> {
  const watch = deps.watch ?? DEFAULT_WATCH;
  const now = deps.now();
  const adapter = new GdeltNewsAdapter({ transport: deps.transport, query: watchQuery(watch), maxItems: deps.maxItems ?? 100, now: deps.now });
  const { items: raw, report } = await adapter.fetchWithReport({ since: new Date(now.getTime() - (deps.sinceHours ?? 24) * 3_600_000) });
  if (report.status === "failed") throw new NewsDataError(); // a malformed answer must never become a valid-looking EMPTY file
  const seen = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  let tagged = 0;
  for (const n of raw) {
    const id = `gdelt:${createHash("sha256").update(n.sourceUrl).digest("hex").slice(0, 16)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const headline = n.headline.replace(/\s+/g, " ").trim().slice(0, 280);
    if (!headline) continue;
    const lower = headline.toLowerCase();
    const hit = watch.filter((w) => w.keywords.some((k) => lower.includes(k.toLowerCase())));
    if (hit.length) tagged += 1;
    items.push({
      id, published_at: n.sourceTimestamp.toISOString(), source_label: clean(n.sourceName).slice(0, 40) || "gdelt", headline,
      symbols: hit.length ? [...new Set(hit.map((h) => h.symbol))] : ["*"], markets: hit.length ? [...new Set(hit.map((h) => h.market))] : ["ALL"],
      sentiment_label: "NEUTRAL", impact: "LOW", category: "unclassified", source_reliability: 0.3,
      ...(n.sourceUrl.length <= 200 && /^[A-Za-z0-9_.:/#?=&%-]{1,200}$/.test(n.sourceUrl) ? { reference: n.sourceUrl } : {}),
    });
  }
  return { document: { format: NEWS_FORMAT, source: "gdelt-doc", as_of: now.toISOString(), items }, items: items.length, tagged };
}

// ── sentiment (aggregate tone) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
function firstSeries(body: string): number[] | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  const tl = (j as { timeline?: Array<{ data?: Array<{ value?: unknown }> }> } | null)?.timeline?.[0]?.data;
  if (!Array.isArray(tl)) return null;
  return tl.map((p) => num(p?.value)).filter((v): v is number => v !== null);
}
export const labelOf = (score: number): "POSITIVE" | "NEGATIVE" | "NEUTRAL" => (score >= 0.15 ? "POSITIVE" : score <= -0.15 ? "NEGATIVE" : "NEUTRAL");

export interface SentimentBuild { document: Record<string, unknown>; entries: number; skipped: string[]; errorCodes: string[] }
export async function buildSentiment(deps: { fetcher: Fetcher; watch?: readonly WatchEntry[]; now: () => Date; timespan?: string }): Promise<SentimentBuild> {
  const watch = deps.watch ?? DEFAULT_WATCH.slice(0, 1);
  const now = deps.now();
  const entries: Record<string, unknown> = {}, skipped: string[] = [], errorCodes: string[] = [];
  for (const w of watch) {
    const q = encodeURIComponent(`(${w.keywords.map(quote).join(" OR ")}) ${BASE_FILTER}`);
    const base = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&format=json&timespan=${deps.timespan ?? "24h"}`;
    try {
      const tone = firstSeries(await deps.fetcher(`${base}&mode=timelinetone`));
      const vol = firstSeries(await deps.fetcher(`${base}&mode=timelinevolraw`));
      const count = vol ? Math.round(vol.reduce((a, b) => a + b, 0)) : 0;
      if (!tone || tone.length === 0 || count <= 0) { skipped.push(w.symbol); continue; } // no data is NOT neutral: the entry is simply absent
      const avgTone = tone.reduce((a, b) => a + b, 0) / tone.length; // GDELT tone is roughly -10 .. +10
      const score = Math.max(-1, Math.min(1, avgTone / 10));
      entries[`${w.market}:${w.symbol}`] = { score: Math.round(score * 1000) / 1000, label: labelOf(score), sample_size: count, as_of: now.toISOString() };
    } catch (e) { skipped.push(w.symbol); errorCodes.push(e instanceof ProviderFetchError ? `${e.code}${e.status ? `_${e.status}` : ""}` : "error"); if (errorCodes[errorCodes.length - 1]!.startsWith("rate_limited")) break; } // a rate limit ends the pass: do not keep asking
  }
  return { document: { format: SENTIMENT_FORMAT, source: "gdelt-tone", as_of: now.toISOString(), entries }, entries: Object.keys(entries).length, skipped, errorCodes };
}
