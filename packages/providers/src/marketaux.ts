import { createHash } from "node:crypto";
import { NEWS_FORMAT, SENTIMENT_FORMAT } from "@twins/agents";
import { labelOf } from "./news";
import { ProviderFetchError, type Fetcher } from "./http";

/**
 * NEWS AND SENTIMENT FROM MARKETAUX (alternative to GDELT, D-109). OFFLINE-BUILT: nothing here is switched on by default and no host is allowed yet. What this is and is not:
 *  - Marketaux scores sentiment PER ENTITY (a company or index tagged in an article), -1..+1. That score is kept per entity: one news item per (article, entity), never one score per article
 *    and never an average of different companies applied to each of them. An entity with no numeric score is DROPPED (counted), so missing sentiment stays unavailable, never NEUTRAL.
 *  - Only symbols we know are kept: the three index tickers and stocks of a supplied universe (`SYMBOL.NS` -> NSE, `SYMBOL.BO` -> BSE). Anything else is counted as unmapped and dropped, so an
 *    unknown ticker can never become a supported instrument by appearing in a headline.
 *  - Provider-supplied: headline, URL, source, publication time, the entity score. Derived by us: the label (same thresholds as GDELT) and the per-entity aggregate in the sentiment file
 *    (mean of that ONE entity's own scores; sample size = distinct articles; as_of = newest contributing article; source label says "derived"). Category, impact and reliability are not
 *    supplied: "unclassified", LOW and 0.4 (a low placeholder so the agents' reliability floor downgrades these items).
 *  - Not stored: the article snippet or description (the terms on storage are unanswered).
 * Quota: the free plan allows 100 requests a day and 3 articles per request. A per-process daily cap (default 60) and a per-pass cap (default 2) apply; HTTP 402 or a rate-limited 429 stops the pass.
 */
export const MARKETAUX_HOST = "api.marketaux.com";
const KEY = /^[A-Za-z0-9]{16,64}$/;
export const MARKETAUX_RELIABILITY = 0.4;
export const INDEX_TICKERS: Readonly<Record<string, { symbol: string; market: string }>> = {
  "^NSEI": { symbol: "NIFTY", market: "NSE" }, "^NSEBANK": { symbol: "BANKNIFTY", market: "NSE" }, "^BSESN": { symbol: "SENSEX", market: "BSE" },
};

export class MarketauxDataError extends Error { constructor(what: string) { super(`the Marketaux response failed validation: ${what}`); this.name = "MarketauxDataError"; } }
export class MarketauxLimitError extends Error { constructor(readonly kind: "quota_exhausted" | "rate_limited") { super(kind); this.name = "MarketauxLimitError"; } }

/** Counts requests per UTC day for one process; the provider's own counter is not visible through the fetcher. */
export function createQuotaGuard(o: { dailyCap?: number; now: () => Date }): { take: () => boolean; used: () => number } {
  const cap = o.dailyCap ?? 60; let day = ""; let n = 0;
  return {
    take: () => { const d = o.now().toISOString().slice(0, 10); if (d !== day) { day = d; n = 0; } if (n >= cap) return false; n += 1; return true; },
    used: () => n,
  };
}

export type MapResult = { symbol: string; market: string } | "unmapped";
export function mapEntitySymbol(raw: unknown, universe: ReadonlySet<string>): MapResult {
  if (typeof raw !== "string") return "unmapped";
  const idx = INDEX_TICKERS[raw];
  if (idx) return idx;
  const m = /^([A-Z0-9&_-]{1,30})\.(NS|BO)$/.exec(raw);
  if (!m || !universe.has(m[1]!)) return "unmapped";
  return { symbol: m[1]!, market: m[2] === "NS" ? "NSE" : "BSE" };
}

export interface MarketauxStats { articles: number; kept: number; unmapped: number; noScore: number; stale: number; future: number; duplicates: number; requests: number }
export interface MarketauxBuild { items: Array<Record<string, unknown>>; stats: MarketauxStats; asOf: string }

const iso = (v: unknown): number | null => { if (typeof v !== "string") return null; const t = Date.parse(v); return Number.isNaN(t) || !/(Z|[+-]\d\d:?\d\d)$/.test(v) ? null : t; };
const cleanLabel = (s: string): string => s.replace(/[^A-Za-z0-9 &._-]/g, "_").slice(0, 40);
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ymdhms = (d: Date): string => d.toISOString().slice(0, 19);

export function marketauxUrl(apiKey: string, o: { publishedAfter: Date; page: number; limit?: number }): string {
  if (!KEY.test(apiKey)) throw new Error("Marketaux API key has an unexpected shape"); // never echoed
  const q = new URLSearchParams({ countries: "in", language: "en", filter_entities: "true", must_have_entities: "true", sort: "published_at", sort_order: "desc", published_after: ymdhms(o.publishedAfter), limit: String(o.limit ?? 3), page: String(o.page), api_token: apiKey });
  return `https://${MARKETAUX_HOST}/v1/news/all?${q.toString()}`;
}

export async function buildMarketauxNews(deps: { fetcher: Fetcher; apiKey: string; universe: ReadonlySet<string>; now: () => Date; quota: ReturnType<typeof createQuotaGuard>; sinceHours?: number; maxRequests?: number; futureToleranceMinutes?: number }): Promise<MarketauxBuild> {
  const now = deps.now(), nowMs = now.getTime();
  const from = nowMs - (deps.sinceHours ?? 24) * 3_600_000, to = nowMs + (deps.futureToleranceMinutes ?? 5) * 60_000;
  const stats: MarketauxStats = { articles: 0, kept: 0, unmapped: 0, noScore: 0, stale: 0, future: 0, duplicates: 0, requests: 0 };
  const items: Array<Record<string, unknown>> = [];
  const ids = new Set<string>(), texts = new Set<string>();
  for (let page = 1; page <= (deps.maxRequests ?? 2); page += 1) {
    if (!deps.quota.take()) { if (stats.requests === 0) throw new MarketauxLimitError("quota_exhausted"); break; }
    let body: string;
    try { body = await deps.fetcher(marketauxUrl(deps.apiKey, { publishedAfter: new Date(from), page })); stats.requests += 1; }
    catch (e) {
      if (e instanceof ProviderFetchError && e.code === "rate_limited") throw new MarketauxLimitError("rate_limited");
      if (e instanceof ProviderFetchError && e.code === "http_error" && e.status === 402) throw new MarketauxLimitError("quota_exhausted");
      throw e;
    }
    let j: unknown;
    try { j = JSON.parse(body); } catch { throw new MarketauxDataError("not JSON"); }
    const data = (j as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new MarketauxDataError("no data list"); // a malformed answer must never become a valid-looking EMPTY file
    for (const a of data as Array<Record<string, unknown> | null>) {
      if (!a || typeof a !== "object" || typeof a["uuid"] !== "string" || typeof a["title"] !== "string" || typeof a["url"] !== "string" || typeof a["source"] !== "string" || !Array.isArray(a["entities"])) throw new MarketauxDataError("article shape");
      const at = iso(a["published_at"]);
      if (at === null) throw new MarketauxDataError("published_at");
      stats.articles += 1;
      if (at < from) { stats.stale += 1; continue; }
      if (at > to) { stats.future += 1; continue; }
      const headline = a["title"].replace(/\s+/g, " ").trim().slice(0, 280);
      if (!headline) continue;
      for (const e of a["entities"] as Array<Record<string, unknown> | null>) {
        const m = e && typeof e === "object" ? mapEntitySymbol(e["symbol"], deps.universe) : "unmapped";
        if (m === "unmapped") { stats.unmapped += 1; continue; }
        const s = e!["sentiment_score"];
        if (typeof s !== "number" || !Number.isFinite(s) || s < -1 || s > 1) { stats.noScore += 1; continue; } // missing sentiment stays missing
        const id = `mx:${createHash("sha256").update(`${a["uuid"]}|${m.market}|${m.symbol}`).digest("hex").slice(0, 24)}`;
        const tk = `${norm(headline)}|${m.market}|${m.symbol}`;
        if (ids.has(id) || texts.has(tk)) { stats.duplicates += 1; continue; }
        ids.add(id); texts.add(tk);
        const url = a["url"] as string;
        items.push({
          id, published_at: new Date(at).toISOString(), source_label: cleanLabel(a["source"] as string) || "marketaux", headline,
          symbols: [m.symbol], markets: [m.market], sentiment_score: s, sentiment_label: labelOf(s), impact: "LOW", category: "unclassified", source_reliability: MARKETAUX_RELIABILITY,
          ...(url.length <= 200 && /^[A-Za-z0-9_.:/#?=&%-]{1,200}$/.test(url) ? { reference: url } : {}),
        });
        stats.kept += 1;
      }
    }
  }
  return { items, stats, asOf: now.toISOString() };
}

export function marketauxNewsDocument(b: MarketauxBuild): Record<string, unknown> {
  return { format: NEWS_FORMAT, source: "marketaux", as_of: b.asOf, items: b.items };
}

/** Per-entity aggregate DERIVED from the items (mean of that one entity's own provider scores). Entities with no scored item get no entry (unavailable). */
export function marketauxSentimentDocument(b: MarketauxBuild): { document: Record<string, unknown>; entries: number } {
  const by = new Map<string, { sum: number; n: number; newest: number }>();
  for (const it of b.items) {
    const key = `${(it["markets"] as string[])[0]}:${(it["symbols"] as string[])[0]}`;
    const t = Date.parse(it["published_at"] as string), score = it["sentiment_score"] as number;
    const g = by.get(key) ?? { sum: 0, n: 0, newest: 0 };
    g.sum += score; g.n += 1; g.newest = Math.max(g.newest, t); by.set(key, g);
  }
  const entries: Record<string, unknown> = {};
  for (const [k, g] of [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) { const mean = g.sum / g.n; entries[k] = { score: Math.round(mean * 10_000) / 10_000, label: labelOf(mean), sample_size: g.n, as_of: new Date(g.newest).toISOString() }; }
  return { document: { format: SENTIMENT_FORMAT, source: "marketaux-derived-entity-mean", as_of: b.asOf, entries }, entries: by.size };
}
