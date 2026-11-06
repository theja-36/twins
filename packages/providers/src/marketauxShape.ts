import { buildMarketauxNews, createQuotaGuard, INDEX_TICKERS, type MarketauxStats } from "./marketaux";

/**
 * Shape report for the FIRST permitted live Marketaux request (runbook: docs/twins/MARKETAUX_FIRST_TEST_RUNBOOK.md). It answers: do the request parameters behave as assumed, and what does a real
 * answer look like? It reports field NAMES, TYPES, counts and ranges only: no headline, no URL, no snippet, no key. The adapter is also run over the same body (no network) to show what it would keep.
 */
const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function keyTypes(rows: unknown[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const r of rows) if (r && typeof r === "object") for (const [k, v] of Object.entries(r)) (out[k] ??= new Set()).add(typeOf(v));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].sort()]));
}
const OFFSET = /(Z|[+-]\d\d:?\d\d)$/;
export interface ShapeReport {
  articleCount: number; topLevelKeys: string[]; meta: unknown; articleKeyTypes: Record<string, string[]>; entityKeyTypes: Record<string, string[]>;
  checks: { dataIsList: boolean; everyArticleHasEntities: boolean; everyPublishedAtHasOffset: boolean; sortedNewestFirst: boolean; allWithinWindow: boolean; scoresNumeric: number; scoresMissing: number; scoresOutOfRange: number; countriesAllIndia: boolean | "no country field" };
  symbolPatterns: Record<string, number>; symbolsSeen: string[]; adapterDryRun: MarketauxStats | { refused: string };
}
export async function marketauxShapeReport(body: string, o: { now: Date; universe: ReadonlySet<string>; sinceHours?: number }): Promise<ShapeReport> {
  let j: unknown;
  try { j = JSON.parse(body); } catch { throw new Error("the answer is not JSON"); }
  const root = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  const data = Array.isArray(root["data"]) ? (root["data"] as Array<Record<string, unknown>>) : [];
  const ents = data.flatMap((a) => (Array.isArray(a?.["entities"]) ? (a["entities"] as Array<Record<string, unknown>>) : []));
  const times = data.map((a) => (typeof a?.["published_at"] === "string" ? Date.parse(a["published_at"] as string) : NaN));
  const from = o.now.getTime() - (o.sinceHours ?? 24) * 3_600_000;
  const scores = ents.map((e) => e?.["sentiment_score"]);
  const patterns: Record<string, number> = {};
  const symbols = new Set<string>();
  for (const e of ents) { const s = typeof e?.["symbol"] === "string" ? (e["symbol"] as string) : ""; symbols.add(s); const k = s in INDEX_TICKERS ? "index (known)" : s.startsWith("^") ? "index (other)" : /\.NS$/.test(s) ? ".NS" : /\.BO$/.test(s) ? ".BO" : "other"; patterns[k] = (patterns[k] ?? 0) + 1; }
  const countries = ents.map((e) => e?.["country"]).filter((c) => c !== undefined);
  let dry: ShapeReport["adapterDryRun"];
  try {
    let n = 0;
    const b = await buildMarketauxNews({ fetcher: async () => (n++ === 0 ? body : JSON.stringify({ data: [] })), apiKey: "x".repeat(32), universe: o.universe, now: () => o.now, quota: createQuotaGuard({ now: () => o.now }), ...(o.sinceHours ? { sinceHours: o.sinceHours } : {}) });
    dry = b.stats;
  } catch (e) { dry = { refused: e instanceof Error ? e.name : "error" }; }
  return {
    articleCount: data.length, topLevelKeys: Object.keys(root).sort(), meta: root["meta"] ?? null, articleKeyTypes: keyTypes(data), entityKeyTypes: keyTypes(ents),
    checks: {
      dataIsList: Array.isArray(root["data"]), everyArticleHasEntities: data.length > 0 && data.every((a) => Array.isArray(a?.["entities"]) && (a["entities"] as unknown[]).length > 0),
      everyPublishedAtHasOffset: data.every((a) => typeof a?.["published_at"] === "string" && OFFSET.test(a["published_at"] as string)),
      sortedNewestFirst: times.every((t, i) => i === 0 || (!Number.isNaN(t) && t <= times[i - 1]!)), allWithinWindow: times.every((t) => !Number.isNaN(t) && t >= from),
      scoresNumeric: scores.filter((s) => typeof s === "number" && Number.isFinite(s)).length, scoresMissing: scores.filter((s) => typeof s !== "number").length, scoresOutOfRange: scores.filter((s) => typeof s === "number" && (s < -1 || s > 1)).length,
      countriesAllIndia: countries.length === 0 ? "no country field" : countries.every((c) => c === "in"),
    },
    symbolPatterns: patterns, symbolsSeen: [...symbols].filter(Boolean).sort().slice(0, 30), adapterDryRun: dry,
  };
}
