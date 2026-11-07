import { assessNewsImpact, type NewsEvent, type NewsImpact, type NewsImpactPolicy, DEFAULT_NEWS_POLICY } from "./newsImpact";

/**
 * Telegram channel news (Phase 3 design, built offline). PURE: turns the non-signal commentary of captured channels into STRUCTURED items (symbols matched against the instrument reference, fixed theme
 * codes, a polarity from fixed word lists) so that NO channel sentence ever reaches an agent or a file. The message text is read here, in memory, to classify it, and is not part of any output. Messages
 * the parser treats as signals, claims or result reports are skipped (they have their own paths). Corroboration with API news raises confidence; channel-only evidence can never escalate beyond CAUTION.
 * Reliability starts low and is supplied by the caller (it should follow the channel's scorecard tier). Nothing here approves, sizes or blocks anything.
 */
export const CHANNEL_NEWS_VERSION = "channel-news-v1";
export const CHANNEL_NEWS_FORMAT = "twins-channel-news-v1";
export const DEFAULT_CHANNEL_RELIABILITY = 0.3;
export const THEMES = ["earnings", "rates", "oil", "policy", "global", "geopolitics", "banking", "currency", "regulation", "corporate_action"] as const;
export type Theme = (typeof THEMES)[number];

const THEME_WORDS: Record<Theme, RegExp> = {
  earnings: /(?<![A-Z])(?:EARNINGS|QUARTERLY|Q[1-4]|RESULTS? (?:DAY|DECLARED|ANNOUNCED)|PROFIT WARNING|GUIDANCE)(?![A-Z])/,
  rates: /(?<![A-Z])(?:RATE (?:CUT|HIKE)|REPO|FED|FOMC|INTEREST RATES?|YIELDS?|INFLATION|CPI)(?![A-Z])/,
  oil: /(?<![A-Z])(?:CRUDE|BRENT|OIL PRICES?|OPEC)(?![A-Z])/,
  policy: /(?<![A-Z])(?:BUDGET|GOVERNMENT|SUBSIDY|TARIFFS?|GST|POLICY)(?![A-Z])/,
  global: /(?<![A-Z])(?:DOW|NASDAQ|S&P|WALL STREET|ASIAN MARKETS|EUROPEAN MARKETS|GLOBAL CUES|SGX)(?![A-Z])/,
  geopolitics: /(?<![A-Z])(?:WAR|CONFLICT|SANCTIONS?|ELECTIONS?|TENSIONS?)(?![A-Z])/,
  banking: /(?<![A-Z])(?:NPA|BANKING|RBI|CREDIT GROWTH|LOAN)(?![A-Z])/,
  currency: /(?<![A-Z])(?:RUPEE|USDINR|DOLLAR INDEX|DXY)(?![A-Z])/,
  regulation: /(?<![A-Z])(?:SEBI|PROBE|INVESTIGATION|PENALTY|BAN|RAID|FRAUD)(?![A-Z])/,
  corporate_action: /(?<![A-Z])(?:DIVIDEND|BONUS|SPLIT|BUYBACK|MERGER|ACQUISITION|DEMERGER|RIGHTS ISSUE)(?![A-Z])/,
};
const NEG = /(?<![A-Z])(?:FALL|FALLS|FALLING|CRASH|DROP|DROPS|PLUNGE|WEAK|WEAKNESS|LOSS|LOSSES|SELLOFF|DOWNGRADE|DOWNGRADED|PROBE|FRAUD|DEFAULT|MISS|MISSED|CUT|CUTS|BAN|PENALTY|RAID|WARNING|SLUMP|DECLINE)(?![A-Z])/g;
const POS = /(?<![A-Z])(?:RISE|RISES|RALLY|SURGE|SURGES|STRONG|STRENGTH|UPGRADE|UPGRADED|BEAT|BEATS|RECORD|BUYBACK|DIVIDEND|BONUS|APPROVAL|APPROVED|GROWTH|JUMP|JUMPS|GAINS)(?![A-Z])/g;
const TOKEN = /(?<![A-Z0-9&.-])[A-Z][A-Z0-9&.-]{1,19}(?![A-Z0-9&.-])/g;

export interface ChannelMessage { id: string; /** Masked channel label, e.g. ***2544. */ channel: string; at: Date; /** Read in memory only; never copied to an output. */ text: string }
export interface ChannelNewsItem { id: string; channel: string; publishedAt: string; symbols: string[]; themes: Theme[]; /** -1 to +1, 0 when neutral or balanced. */ polarity: number; reliability: number }
export type SkipReason = "signal_or_claim" | "result_report" | "empty" | "no_symbols_or_themes";
/** Classifies a message with the intake parser (injected so this package holds no dependency on it): `none` = commentary, `signal_or_claim`, `result_report`. */
export type MessageClassifier = (text: string) => "none" | "signal_or_claim" | "result_report";
export interface ExtractContext { symbols: ReadonlySet<string>; classify: MessageClassifier; reliability?: number }

export function extractChannelNews(m: ChannelMessage, ctx: ExtractContext): { item: ChannelNewsItem } | { skipped: SkipReason } {
  const text = m.text.replace(/\s+/g, " ").trim().toUpperCase();
  if (text === "") return { skipped: "empty" };
  const kind = ctx.classify(m.text);
  if (kind === "result_report") return { skipped: "result_report" };
  if (kind === "signal_or_claim") return { skipped: "signal_or_claim" };
  const symbols = [...new Set((text.match(TOKEN) ?? []).filter((t) => ctx.symbols.has(t)))].sort().slice(0, 8);
  const themes = THEMES.filter((t) => THEME_WORDS[t].test(text));
  if (symbols.length === 0 && themes.length === 0) return { skipped: "no_symbols_or_themes" };
  const neg = (text.match(NEG) ?? []).length, pos = (text.match(POS) ?? []).length;
  const polarity = neg + pos === 0 ? 0 : Math.round(((pos - neg) / (pos + neg)) * 100) / 100;
  const rel = ctx.reliability ?? DEFAULT_CHANNEL_RELIABILITY;
  return { item: { id: m.id, channel: m.channel, publishedAt: m.at.toISOString(), symbols, themes, polarity, reliability: Math.min(1, Math.max(0, rel)) } };
}

/** Collapses near-duplicates: same channel, same symbols and themes, same polarity sign, inside `windowMinutes`. Keeps the first and counts the rest. */
export function dedupeChannelNews(items: readonly ChannelNewsItem[], windowMinutes = 30): Array<ChannelNewsItem & { duplicates: number }> {
  const sorted = [...items].sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1));
  const out: Array<ChannelNewsItem & { duplicates: number }> = [];
  const lastByKey = new Map<string, number>();
  for (const it of sorted) {
    const key = `${it.channel}|${it.symbols.join(",")}|${it.themes.join(",")}|${Math.sign(it.polarity)}`;
    const idx = lastByKey.get(key);
    if (idx !== undefined && Date.parse(it.publishedAt) - Date.parse((out[idx] as ChannelNewsItem).publishedAt) <= windowMinutes * 60_000) { (out[idx] as { duplicates: number }).duplicates += 1; continue; }
    lastByKey.set(key, out.length);
    out.push({ ...it, duplicates: 0 });
  }
  return out;
}

export interface NewsCluster { symbol: string | null; theme: Theme | null; bucketStart: string; items: number; channels: number; polarity: number; mixed: boolean }
/** Clusters by (symbol, theme) inside fixed windows (default 2 hours). An item with several symbols/themes joins each cluster. A cluster is MIXED when strong views disagree. */
export function clusterChannelNews(items: readonly ChannelNewsItem[], windowMinutes = 120): NewsCluster[] {
  const w = windowMinutes * 60_000;
  const groups = new Map<string, { symbol: string | null; theme: Theme | null; start: number; items: ChannelNewsItem[] }>();
  for (const it of items) {
    const t = Date.parse(it.publishedAt), start = Math.floor(t / w) * w;
    const syms: Array<string | null> = it.symbols.length ? it.symbols : [null], ths: Array<Theme | null> = it.themes.length ? it.themes : [null];
    for (const s of syms) for (const th of ths) { const k = `${s}|${th}|${start}`; (groups.get(k) ?? groups.set(k, { symbol: s, theme: th, start, items: [] }).get(k)!).items.push(it); }
  }
  return [...groups.values()].map((g) => {
    const pols = g.items.map((i) => i.polarity), mean = pols.reduce((a, b) => a + b, 0) / pols.length;
    return { symbol: g.symbol, theme: g.theme, bucketStart: new Date(g.start).toISOString(), items: g.items.length, channels: new Set(g.items.map((i) => i.channel)).size, polarity: Math.round(mean * 100) / 100, mixed: pols.some((p) => p >= 0.5) && pols.some((p) => p <= -0.5) };
  }).sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : (a.symbol ?? "") < (b.symbol ?? "") ? -1 : 1));
}

/** Channel items as `NewsEvent`s for `assessNewsImpact` (relevance fixed at 0.5: channel text is never a precise match). */
export function channelItemsToEvents(items: readonly ChannelNewsItem[]): NewsEvent[] {
  return items.map((i) => ({ id: `ch:${i.channel}:${i.id}`, publishedAt: i.publishedAt, sentiment: i.polarity, relevance: 0.5, reliability: i.reliability, symbols: i.symbols, themes: [...i.themes] }));
}

export type Corroboration = "API_AND_CHANNEL" | "API_ONLY" | "CHANNEL_ONLY" | "NONE";
export interface CombinedNewsImpact { impact: NewsImpact; corroboration: Corroboration; channelOnlyCapped: boolean }
/** Combined view. Corroborated = both classes present with the same sign. Channel-only evidence is capped at CAUTION: it can never recommend a review of new entries. Good news still recommends nothing. */
export function combinedNewsImpact(apiEvents: readonly NewsEvent[], channelItems: readonly ChannelNewsItem[], target: { symbol: string; themes?: readonly string[] }, now: Date, policy: NewsImpactPolicy = DEFAULT_NEWS_POLICY): CombinedNewsImpact {
  const ch = channelItemsToEvents(channelItems);
  const apiI = assessNewsImpact(apiEvents, target, now, policy), chI = assessNewsImpact(ch, target, now, policy);
  const all = assessNewsImpact([...apiEvents, ...ch], target, now, policy);
  const apiHas = apiI.used > 0, chHas = chI.used > 0;
  const corroboration: Corroboration = apiHas && chHas && apiI.impact !== null && chI.impact !== null && Math.sign(apiI.impact) === Math.sign(chI.impact) && apiI.impact !== 0 ? "API_AND_CHANNEL" : apiHas ? "API_ONLY" : chHas ? "CHANNEL_ONLY" : "NONE";
  if (corroboration === "CHANNEL_ONLY" && all.recommendation === "REVIEW_NEW_ENTRIES") return { impact: { ...all, recommendation: "CAUTION" }, corroboration, channelOnlyCapped: true };
  return { impact: all, corroboration, channelOnlyCapped: false };
}

/** `twins-channel-news-v1`: structured items only. */
export function buildChannelNewsFile(items: readonly ChannelNewsItem[], asOf: Date): Record<string, unknown> {
  return { format: CHANNEL_NEWS_FORMAT, source: "telegram-channels", as_of: asOf.toISOString(), items: items.map((i) => ({ id: i.id, channel: i.channel, published_at: i.publishedAt, symbols: i.symbols, themes: i.themes, polarity: i.polarity, reliability: i.reliability })) };
}
export class ChannelNewsFormatError extends Error { constructor(m: string) { super(m); this.name = "ChannelNewsFormatError"; } }
export function parseChannelNewsFile(raw: unknown): ChannelNewsItem[] {
  const bad = (w: string): never => { throw new ChannelNewsFormatError(w); };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== CHANNEL_NEWS_FORMAT) bad("unsupported format");
  if (typeof r["as_of"] !== "string" || Number.isNaN(Date.parse(r["as_of"]))) bad("as_of");
  if (!Array.isArray(r["items"]) || r["items"].length > 50_000) bad("items");
  const seen = new Set<string>();
  return (r["items"] as unknown[]).map((x, i) => {
    const o = (typeof x === "object" && x !== null ? x : bad(`items[${i}]`)) as Record<string, unknown>;
    const id = o["id"], ch = o["channel"], at = o["published_at"], sy = o["symbols"], th = o["themes"], pol = o["polarity"], rel = o["reliability"];
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(id) || seen.has(`${String(ch)}|${id}`)) bad(`items[${i}] id`);
    if (typeof ch !== "string" || !/^[*A-Za-z0-9_.:@ -]{1,80}$/.test(ch)) bad(`items[${i}] channel`);
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) bad(`items[${i}] published_at`);
    if (!Array.isArray(sy) || sy.length > 8 || !sy.every((s) => typeof s === "string" && /^[A-Z][A-Z0-9&.-]{1,19}$/.test(s))) bad(`items[${i}] symbols`);
    if (!Array.isArray(th) || !th.every((t) => (THEMES as readonly unknown[]).includes(t))) bad(`items[${i}] themes`);
    if (typeof pol !== "number" || !Number.isFinite(pol) || Math.abs(pol) > 1 || typeof rel !== "number" || !Number.isFinite(rel) || rel < 0 || rel > 1) bad(`items[${i}] numbers`);
    seen.add(`${String(ch)}|${String(id)}`);
    return { id: id as string, channel: ch as string, publishedAt: at as string, symbols: sy as string[], themes: th as Theme[], polarity: pol as number, reliability: rel as number };
  });
}
