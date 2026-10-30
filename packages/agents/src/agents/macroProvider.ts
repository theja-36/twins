import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkFile } from "@twins/historical";
import { AgentContractError } from "../contract";
import { validateCalendarEvent, type CalendarEvent } from "./calendarProviders";

/**
 * Macro / global market context provider (Stage 5 / Task 3): the INJECTABLE interface the Macro/Global Market Agent uses. No external API is integrated; the shipped implementations are
 * in-memory (tests) and file-based over a pre-exported snapshot. A provider never invents data: a missing section is `null`, a context it cannot supply is `null`, a failure throws.
 */
export interface MacroIndex {
  symbol: string;
  /** Latest level. */
  level: number;
  /** Previous session's close and this session's open (for the gap); null when unknown. */
  previousClose: number | null;
  open: number | null;
  /** Daily closes, oldest first; the trend over N sessions is `level / closes[length - N] - 1`. */
  recentCloses: number[];
}
export interface MacroSnapshot {
  /** When the data was captured (ISO). */
  asOf: string;
  index: MacroIndex | null;
  breadth: { advancers: number; decliners: number } | null;
  volatilityIndex: { name: string; level: number; changePct1d: number | null } | null;
  currency: { pair: string; changePct1d: number } | null;
  global: Array<{ name: string; sessionStatus: "open" | "closed"; changePct1d: number }>;
  releases: CalendarEvent[];
}
export interface MacroContextProvider {
  readonly name: string;
  /** The snapshot for the market / underlying, or null when the provider has nothing for it. */
  context(q: { market: string; underlying: string }): Promise<MacroSnapshot | null>;
}

const bad = (what: string): never => { throw new AgentContractError("INVALID_MACRO_DATA", `macro context: ${what}`); };
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const upper = (s: string): string => s.trim().toUpperCase();
const instant = (s: unknown): string | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T"))) ? new Date(s.replace(" ", "T")).toISOString() : null);
const label = (v: unknown, what: string): string => (typeof v === "string" && /^[A-Za-z0-9 &._-]{1,40}$/.test(v) ? v : bad(what));

/** In-memory provider (tests and tools): contexts keyed by `MARKET:UNDERLYING`, falling back to `MARKET:*`. */
export function memoryMacroProvider(o: { name?: string; contexts: Record<string, MacroSnapshot> }): MacroContextProvider {
  const m = new Map(Object.entries(o.contexts).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: o.name ?? "memory-macro", context: async (q) => m.get(`${upper(q.market)}:${upper(q.underlying)}`) ?? m.get(`${upper(q.market)}:*`) ?? null };
}

export const MACRO_CONTEXT_FORMAT = "twins-macro-context-v1";
/**
 * `twins-macro-context-v1` (JSON): { "format", "source", "as_of": "<ISO>", "contexts": { "NSE:*": {
 *     "index": { "symbol": "NIFTY", "level": 24500, "previous_close": 24400, "open": 24450, "recent_closes": [24100, 24200, 24300, 24400] },
 *     "breadth": { "advancers": 1200, "decliners": 800 }, "volatility_index": { "name": "INDIAVIX", "level": 14.2, "change_pct_1d": -1.5 },
 *     "currency": { "pair": "USDINR", "change_pct_1d": 0.1 },
 *     "global": [ { "name": "SP500", "session_status": "closed", "change_pct_1d": 0.4 } ],
 *     "releases": [ { "id": "...", "name": "...", "at": "<ISO>", "impact": "HIGH", "markets": ["NSE"] } ] } } }
 * Every section except the index is optional. Strict: non-finite or non-positive levels, malformed releases and bad timestamps are rejected; nothing is repaired.
 */
export function parseMacroContext(raw: unknown): MacroContextProvider {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== MACRO_CONTEXT_FORMAT) bad("unsupported format");
  const asOf = instant(r["as_of"]) ?? bad("as_of must be an ISO instant with an offset");
  const src = r["contexts"];
  if (typeof src !== "object" || src === null || Array.isArray(src) || Object.keys(src).length === 0) bad("contexts must be an object");
  const contexts: Record<string, MacroSnapshot> = {};
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    if (!/^[A-Z0-9]{2,20}:(?:\*|[A-Z0-9&._-]{1,30})$/.test(key)) bad("context key");
    const o = v as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o)) return bad(`${key}: not an object`);
    let index: MacroIndex | null = null;
    if (o["index"] !== undefined && o["index"] !== null) {
      const i = o["index"] as Record<string, unknown>;
      const closes = i["recent_closes"];
      if (!fin(i["level"]) || i["level"] <= 0 || !Array.isArray(closes) || closes.length > 400 || closes.some((c) => !fin(c) || c <= 0)) bad(`${key}: index`);
      const opt = (x: unknown, w: string): number | null => (x === undefined || x === null ? null : fin(x) && x > 0 ? x : bad(`${key}: ${w}`));
      index = { symbol: label(i["symbol"], `${key}: index symbol`), level: i["level"] as number, previousClose: opt(i["previous_close"], "previous_close"), open: opt(i["open"], "open"), recentCloses: closes as number[] };
    }
    const b = o["breadth"] as Record<string, unknown> | null | undefined;
    if (b != null && (!Number.isInteger(b["advancers"]) || !Number.isInteger(b["decliners"]) || (b["advancers"] as number) < 0 || (b["decliners"] as number) < 0)) bad(`${key}: breadth`);
    const vi = o["volatility_index"] as Record<string, unknown> | null | undefined;
    if (vi != null && (!fin(vi["level"]) || (vi["level"] as number) < 0 || (vi["change_pct_1d"] != null && !fin(vi["change_pct_1d"])))) bad(`${key}: volatility_index`);
    const cu = o["currency"] as Record<string, unknown> | null | undefined;
    if (cu != null && !fin(cu["change_pct_1d"])) bad(`${key}: currency`);
    const gl = o["global"] ?? [];
    if (!Array.isArray(gl) || gl.length > 20) bad(`${key}: global`);
    const rel = o["releases"] ?? [];
    if (!Array.isArray(rel) || rel.length > 200) bad(`${key}: releases`);
    contexts[key] = {
      asOf, index,
      breadth: b == null ? null : { advancers: b["advancers"] as number, decliners: b["decliners"] as number },
      volatilityIndex: vi == null ? null : { name: label(vi["name"], `${key}: volatility name`), level: vi["level"] as number, changePct1d: vi["change_pct_1d"] == null ? null : (vi["change_pct_1d"] as number) },
      currency: cu == null ? null : { pair: label(cu["pair"], `${key}: currency pair`), changePct1d: cu["change_pct_1d"] as number },
      global: (gl as Array<Record<string, unknown>>).map((g) => {
        if (!g || (g["session_status"] !== "open" && g["session_status"] !== "closed") || !fin(g["change_pct_1d"])) return bad(`${key}: global entry`);
        return { name: label(g["name"], `${key}: global name`), sessionStatus: g["session_status"] as "open" | "closed", changePct1d: g["change_pct_1d"] as number };
      }),
      releases: (rel as unknown[]).map((x, n) => validateCalendarEvent(x) ?? bad(`${key}: releases[${n}]`)),
    };
  }
  return memoryMacroProvider({ name: typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file", contexts });
}
export function fileMacroProvider(path: string): MacroContextProvider {
  let info;
  try { info = checkFile(path); } catch { throw new AgentContractError("INVALID_MACRO_DATA", `macro context file ${basename(path)} is unreadable or refused`); }
  if (info.format !== "json") throw new AgentContractError("INVALID_MACRO_DATA", "the macro context must be a .json file");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new AgentContractError("INVALID_MACRO_DATA", "the macro context is not valid JSON"); }
  return parseMacroContext(raw);
}
