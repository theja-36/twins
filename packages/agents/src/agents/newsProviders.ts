import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkFile } from "@twins/historical";
import { AgentContractError } from "../contract";
import { sanitizeText } from "../sanitize";
import type { Level } from "./common";
import type { EventImpact } from "./calendarProviders";

/**
 * News and sentiment providers (Stage 5 / Task 4): the INJECTABLE interfaces the News/Sentiment and Index-Constituent agents use. No external API is integrated; the shipped implementations
 * are in-memory (tests) and file-based over a pre-exported snapshot. News items are structured provider records - raw Telegram message text is never a news input. A provider never invents
 * data: what it does not cover is empty / `null`, a failure throws, and the agents re-validate whatever a provider returns.
 */
export type SentimentLabel = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";
export const SENTIMENT_LABELS: readonly SentimentLabel[] = ["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"];
export interface NewsItem {
  id: string;
  /** ISO instant with an offset. */
  publishedAt: string;
  sourceLabel: string;
  /** A safe, short summary (never used in findings; only for duplicate detection). */
  headline: string;
  /** Affected underlyings; "*" = market-wide. */
  symbols: string[];
  /** Affected market codes; "ALL" = every market. */
  markets: string[];
  sentimentLabel: SentimentLabel;
  /** -1 (negative) .. +1 (positive), or null when the provider gives only a label. */
  sentimentScore: number | null;
  impact: EventImpact;
  category: string;
  /** A safe reference id, or null. */
  reference: string | null;
  /** 0..1, or null when unknown. */
  sourceReliability: number | null;
}
export interface NewsQuery { from: string; to: string; market: string; symbols: string[] }
export interface NewsProvider {
  readonly name: string;
  readonly asOf: string | null;
  items(q: NewsQuery): Promise<NewsItem[]>;
}
export interface SentimentSnapshot { score: number; label: SentimentLabel; sampleSize: number; asOf: string }
export interface SentimentProvider {
  readonly name: string;
  sentiment(q: { market: string; symbol: string }): Promise<SentimentSnapshot | null>;
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const isoInstant = (s: unknown): string | null => (typeof s === "string" && ISO_OFFSET.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T"))) ? new Date(s.replace(" ", "T")).toISOString() : null);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const up = (s: string): string => s.trim().toUpperCase();
const IMPACTS: readonly EventImpact[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** Validates one item (also used by the agents on whatever a provider returns). Returns null when malformed. */
export function validateNewsItem(x: unknown): NewsItem | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const at = isoInstant(o["publishedAt"]);
  if (typeof o["id"] !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(o["id"]) || at === null) return null;
  if (typeof o["sourceLabel"] !== "string" || !/^[A-Za-z0-9 &._-]{1,40}$/.test(o["sourceLabel"])) return null;
  if (typeof o["headline"] !== "string" || o["headline"].trim().length === 0 || o["headline"].length > 300) return null;
  const list = (v: unknown, re: RegExp, max: number): string[] | null => (Array.isArray(v) && v.length > 0 && v.length <= max && v.every((s) => typeof s === "string" && re.test(s)) ? (v as string[]) : null);
  const symbols = list(o["symbols"], /^(?:\*|[A-Z0-9&._-]{1,30})$/, 50), markets = list(o["markets"], /^[A-Z0-9]{2,20}$/, 20);
  if (!symbols || !markets) return null;
  if (!SENTIMENT_LABELS.includes(o["sentimentLabel"] as SentimentLabel) || !IMPACTS.includes(o["impact"] as EventImpact)) return null;
  const score = o["sentimentScore"] ?? null;
  if (score !== null && (!fin(score) || score < -1 || score > 1)) return null;
  if (typeof o["category"] !== "string" || !/^[a-z0-9_]{1,40}$/.test(o["category"])) return null;
  const ref = o["reference"] ?? null;
  if (ref !== null && (typeof ref !== "string" || !/^[A-Za-z0-9_.:/#?=&%-]{1,200}$/.test(ref))) return null;
  const rel = o["sourceReliability"] ?? null;
  if (rel !== null && (!fin(rel) || rel < 0 || rel > 1)) return null;
  return { id: o["id"], publishedAt: at, sourceLabel: o["sourceLabel"], headline: sanitizeText(o["headline"], 200), symbols: [...symbols], markets: [...markets], sentimentLabel: o["sentimentLabel"] as SentimentLabel, sentimentScore: score as number | null, impact: o["impact"] as EventImpact, category: o["category"], reference: ref as string | null, sourceReliability: rel as number | null };
}

export function memoryNewsProvider(o: { name?: string; asOf?: string | null; items: unknown[] }): NewsProvider {
  return {
    name: o.name ?? "memory-news", asOf: o.asOf === undefined ? null : o.asOf,
    // malformed entries are passed through unfiltered so the agent can see (and reject) them
    async items(q) {
      return (o.items as NewsItem[]).filter((i) => {
        const v = validateNewsItem(i);
        if (v === null) return true;
        const t = Date.parse(v.publishedAt);
        return t >= Date.parse(q.from) && t <= Date.parse(q.to) && (v.markets.includes("ALL") || v.markets.includes(up(q.market))) && v.symbols.some((s) => s === "*" || q.symbols.map(up).includes(s));
      });
    },
  };
}
export function memorySentimentProvider(o: { name?: string; entries: Record<string, SentimentSnapshot> }): SentimentProvider {
  const m = new Map(Object.entries(o.entries).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-sentiment", sentiment: async (q) => m.get(`${up(q.market)}:${up(q.symbol)}`) ?? null };
}

const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_NEWS_DATA", `${kind}: ${what}`); };
export const NEWS_FORMAT = "twins-news-v1";
export const SENTIMENT_FORMAT = "twins-sentiment-v1";
const srcName = (r: Record<string, unknown>): string => (typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file");
/**
 * `twins-news-v1` (JSON): { "format", "source", "as_of": "<ISO>", "items": [ { "id", "published_at", "source_label", "headline", "symbols": ["RELIANCE"|"*"], "markets": ["NSE"|"ALL"],
 *   "sentiment_label": "NEGATIVE", "sentiment_score": -0.6 (optional), "impact": "HIGH", "category": "earnings", "reference": "ref-1" (optional), "source_reliability": 0.8 (optional) } ] }
 * Strict: malformed items, duplicate ids and bad timestamps are rejected at load; nothing is repaired.
 */
export function parseNewsFile(raw: unknown): NewsProvider {
  const k = "news file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== NEWS_FORMAT) bad(k, "unsupported format");
  const asOf = isoInstant(r["as_of"]) ?? bad(k, "as_of must be an ISO instant with an offset");
  if (!Array.isArray(r["items"]) || r["items"].length > 50_000) bad(k, "items must be a list");
  const seen = new Set<string>();
  const items = (r["items"] as Array<Record<string, unknown>>).map((x, i) => {
    const o = x && typeof x === "object" ? x : {};
    const item = validateNewsItem({ id: o["id"], publishedAt: o["published_at"], sourceLabel: o["source_label"], headline: o["headline"], symbols: o["symbols"], markets: o["markets"], sentimentLabel: o["sentiment_label"], sentimentScore: o["sentiment_score"], impact: o["impact"], category: o["category"], reference: o["reference"], sourceReliability: o["source_reliability"] }) ?? bad(k, `items[${i}] is malformed`);
    if (seen.has(item.id)) bad(k, `items[${i}]: duplicate id`);
    seen.add(item.id);
    return item;
  });
  return memoryNewsProvider({ name: srcName(r), asOf, items });
}
/** `twins-sentiment-v1` (JSON): { "format", "source", "as_of", "entries": { "NSE:RELIANCE": { "score": -0.4, "label": "NEGATIVE", "sample_size": 25, "as_of": "<ISO>" } } } */
export function parseSentimentFile(raw: unknown): SentimentProvider {
  const k = "sentiment file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== SENTIMENT_FORMAT) bad(k, "unsupported format");
  if (isoInstant(r["as_of"]) === null) bad(k, "as_of must be an ISO instant with an offset");
  const src = r["entries"];
  if (typeof src !== "object" || src === null || Array.isArray(src)) return bad(k, "entries must be an object");
  const entries: Record<string, SentimentSnapshot> = {};
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    const o = v as Record<string, unknown> | null;
    const asOf = o ? isoInstant(o["as_of"]) : null;
    if (!/^[A-Z0-9]{2,20}:[A-Z0-9&._-]{1,30}$/.test(key) || !o || !fin(o["score"]) || o["score"] < -1 || o["score"] > 1 || !SENTIMENT_LABELS.includes(o["label"] as SentimentLabel) || !Number.isInteger(o["sample_size"]) || (o["sample_size"] as number) < 0 || asOf === null) bad(k, `entry ${key.slice(0, 40)}`);
    entries[key] = { score: (o as Record<string, unknown>)["score"] as number, label: (o as Record<string, unknown>)["label"] as SentimentLabel, sampleSize: (o as Record<string, unknown>)["sample_size"] as number, asOf: asOf as string };
  }
  return memorySentimentProvider({ name: srcName(r), entries });
}
export function readJsonFile(path: string, what: string): unknown {
  let info;
  try { info = checkFile(path); } catch { throw new AgentContractError("INVALID_NEWS_DATA", `${what} ${basename(path)} is unreadable or refused`); }
  if (info.format !== "json") throw new AgentContractError("INVALID_NEWS_DATA", `${what} must be a .json file`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new AgentContractError("INVALID_NEWS_DATA", `${what} is not valid JSON`); }
}
export const fileNewsProvider = (path: string): NewsProvider => parseNewsFile(readJsonFile(path, "the news file"));
export const fileSentimentProvider = (path: string): SentimentProvider => parseSentimentFile(readJsonFile(path, "the sentiment file"));

// ── shared classification (used by both agents) ──
export interface NewsPolicy { nearTermMinutes: number; sentimentThreshold: number; minReliability: number; criticalAdverse: "ADVERSE" | "BLOCKING" }
export type Stance = "adverse" | "supportive" | "neutral" | "mixed";
export interface Classified { item: NewsItem; stance: Stance; level: Level; ageMinutes: number; nearTerm: boolean; downgraded: boolean }
const DOWN: Record<Level, Level> = { BLOCKING: "ADVERSE", ADVERSE: "CAUTION", CAUTION: "INFO", INFO: "INFO" };
/** The item's signed sentiment: its score when present, else +/-1 for POSITIVE / NEGATIVE, 0 otherwise. */
export const sentimentValue = (i: NewsItem): number => (i.sentimentScore !== null ? i.sentimentScore : i.sentimentLabel === "POSITIVE" ? 1 : i.sentimentLabel === "NEGATIVE" ? -1 : 0);
/** Classifies one item against a signal direction (+1 bullish / -1 bearish). Evidence only: no causation is inferred. */
export function classifyItem(item: NewsItem, dir: 1 | -1, nowMs: number, p: NewsPolicy): Classified {
  const ageMinutes = (nowMs - Date.parse(item.publishedAt)) / 60_000;
  const nearTerm = ageMinutes <= p.nearTermMinutes;
  const aligned = dir * sentimentValue(item);
  const stance: Stance = item.sentimentLabel === "MIXED" ? "mixed" : aligned <= -p.sentimentThreshold ? "adverse" : aligned >= p.sentimentThreshold ? "supportive" : "neutral";
  let level: Level = "INFO";
  let downgraded = false;
  if (stance === "adverse") {
    level = item.impact === "CRITICAL" ? (nearTerm ? p.criticalAdverse : "ADVERSE") : item.impact === "HIGH" ? "ADVERSE" : item.impact === "MEDIUM" ? "CAUTION" : "INFO";
    if (item.sourceReliability !== null && item.sourceReliability < p.minReliability) { level = DOWN[level]; downgraded = true; }
  }
  return { item, stance, level, ageMinutes, nearTerm, downgraded };
}
/** Drops items that repeat an id or the same source + headline; returns the unique items and how many were dropped. */
export function dedupeNews(items: NewsItem[]): { unique: NewsItem[]; duplicates: number } {
  const ids = new Set<string>(), keys = new Set<string>();
  const unique: NewsItem[] = [];
  for (const i of items) {
    const key = `${i.sourceLabel.toLowerCase()}|${i.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (ids.has(i.id) || keys.has(key)) continue;
    ids.add(i.id); keys.add(key); unique.push(i);
  }
  return { unique, duplicates: items.length - unique.length };
}
