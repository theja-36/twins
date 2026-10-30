import { AgentContractError } from "../contract";
import { isoInstant, readJsonFile } from "./newsProviders";

/**
 * Index-constituent and market-data providers (Stage 5 / Task 4): INJECTABLE interfaces for the Index-Constituent Impact Agent. No external API is integrated; the shipped
 * implementations are in-memory (tests) and file-based over a pre-exported snapshot. A provider returns `null` / nothing for what it does not cover and throws on failure.
 */
export interface Constituent {
  symbol: string;
  index: string;
  /** Percent weight in the index (0-100]. */
  weight: number;
  sector: string;
  /** The constituent provider's own recent change in percent, or null. A market-data quote takes precedence. */
  recentChangePct: number | null;
  /** When the constituent's data was captured (ISO). */
  dataAsOf: string;
  /** Reference ids of recent news about the constituent (informational). */
  newsRefs: string[];
}
export interface ConstituentSet { index: string; asOf: string; constituents: Constituent[] }
export interface ConstituentProvider {
  readonly name: string;
  /** Does the provider describe this index at all? (false = the underlying is not an index it covers) */
  knowsIndex(index: string): Promise<boolean>;
  constituents(index: string): Promise<ConstituentSet | null>;
}
export interface Quote { changePct1d: number; asOf: string }
export interface MarketDataProvider {
  readonly name: string;
  /** Quotes by upper-case symbol; symbols without a quote are absent. */
  quotes(q: { market: string; symbols: string[] }): Promise<Record<string, Quote>>;
}

const up = (s: string): string => s.trim().toUpperCase();
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_CONSTITUENT_DATA", `${kind}: ${what}`); };

export function memoryConstituentProvider(o: { name?: string; sets: ConstituentSet[] }): ConstituentProvider {
  const m = new Map(o.sets.map((s) => [up(s.index), s]));
  return { name: o.name ?? "memory-constituents", knowsIndex: async (i) => m.has(up(i)), constituents: async (i) => m.get(up(i)) ?? null };
}
export function memoryMarketData(o: { name?: string; quotes: Record<string, Quote> }): MarketDataProvider {
  const m = new Map(Object.entries(o.quotes).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-quotes", quotes: async (q) => Object.fromEntries(q.symbols.flatMap((s) => { const v = m.get(`${up(q.market)}:${up(s)}`); return v ? [[up(s), v] as const] : []; })) };
}

export const CONSTITUENTS_FORMAT = "twins-index-constituents-v1";
export const QUOTES_FORMAT = "twins-market-quotes-v1";
const srcName = (r: Record<string, unknown>): string => (typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file");
/**
 * `twins-index-constituents-v1` (JSON): { "format", "source", "as_of", "indices": { "NIFTY": { "as_of": "<ISO>", "constituents": [ { "symbol": "ACME", "weight": 9.5, "sector": "Energy",
 *   "recent_change_pct": 0.8 (optional), "data_as_of": "<ISO>", "news_refs": ["id"] (optional) } ] } } }
 * Strict: weights must be in (0, 100] and total at most 100.5, symbols unique, timestamps ISO with an offset; nothing is repaired.
 */
export function parseConstituentsFile(raw: unknown): ConstituentProvider {
  const k = "index constituents file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== CONSTITUENTS_FORMAT) bad(k, "unsupported format");
  if (isoInstant(r["as_of"]) === null) bad(k, "as_of must be an ISO instant with an offset");
  const src = r["indices"];
  if (typeof src !== "object" || src === null || Array.isArray(src) || Object.keys(src).length === 0) return bad(k, "indices must be an object");
  const sets: ConstituentSet[] = [];
  for (const [index, v] of Object.entries(src as Record<string, unknown>)) {
    if (!/^[A-Z0-9&._-]{1,30}$/.test(index)) bad(k, "index name");
    const o = v as Record<string, unknown> | null;
    const asOf = o ? isoInstant(o["as_of"]) : null;
    if (!o || asOf === null || !Array.isArray(o["constituents"]) || o["constituents"].length === 0 || o["constituents"].length > 1000) return bad(k, `${index}: as_of / constituents`);
    const seen = new Set<string>();
    let total = 0;
    const constituents = (o["constituents"] as Array<Record<string, unknown>>).map((c, i): Constituent => {
      const w = `${index}.constituents[${i}]`;
      if (!c || typeof c !== "object" || typeof c["symbol"] !== "string" || !/^[A-Z0-9&._-]{1,30}$/.test(c["symbol"])) return bad(k, `${w}: symbol`);
      if (seen.has(c["symbol"])) bad(k, `${w}: duplicate symbol`);
      seen.add(c["symbol"]);
      if (!fin(c["weight"]) || c["weight"] <= 0 || c["weight"] > 100) bad(k, `${w}: weight`);
      total += c["weight"] as number;
      if (typeof c["sector"] !== "string" || !/^[A-Za-z0-9 &._-]{1,40}$/.test(c["sector"])) bad(k, `${w}: sector`);
      const rc = c["recent_change_pct"] ?? null;
      if (rc !== null && (!fin(rc) || Math.abs(rc) > 100)) bad(k, `${w}: recent_change_pct`);
      const dAsOf = isoInstant(c["data_as_of"]) ?? bad(k, `${w}: data_as_of`);
      const refs = c["news_refs"] ?? [];
      if (!Array.isArray(refs) || refs.length > 20 || refs.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(x))) bad(k, `${w}: news_refs`);
      return { symbol: c["symbol"] as string, index, weight: c["weight"] as number, sector: c["sector"] as string, recentChangePct: rc as number | null, dataAsOf: dAsOf, newsRefs: refs as string[] };
    });
    if (total > 100.5) bad(k, `${index}: weights total more than 100`);
    sets.push({ index, asOf, constituents });
  }
  return memoryConstituentProvider({ name: srcName(r), sets });
}
/** `twins-market-quotes-v1` (JSON): { "format", "source", "as_of", "quotes": { "NSE:ACME": { "change_pct_1d": -0.8, "as_of": "<ISO>" } } } */
export function parseQuotesFile(raw: unknown): MarketDataProvider {
  const k = "market quotes file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== QUOTES_FORMAT) bad(k, "unsupported format");
  if (isoInstant(r["as_of"]) === null) bad(k, "as_of must be an ISO instant with an offset");
  const src = r["quotes"];
  if (typeof src !== "object" || src === null || Array.isArray(src)) return bad(k, "quotes must be an object");
  const quotes: Record<string, Quote> = {};
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    const o = v as Record<string, unknown> | null;
    const asOf = o ? isoInstant(o["as_of"]) : null;
    if (!/^[A-Z0-9]{2,20}:[A-Z0-9&._-]{1,30}$/.test(key) || !o || !fin(o["change_pct_1d"]) || Math.abs(o["change_pct_1d"]) > 100 || asOf === null) bad(k, `quote ${key.slice(0, 40)}`);
    quotes[key] = { changePct1d: (o as Record<string, unknown>)["change_pct_1d"] as number, asOf: asOf as string };
  }
  return memoryMarketData({ name: srcName(r), quotes });
}
export const fileConstituentProvider = (path: string): ConstituentProvider => parseConstituentsFile(readJsonFile(path, "the index constituents file"));
export const fileMarketData = (path: string): MarketDataProvider => parseQuotesFile(readJsonFile(path, "the market quotes file"));
