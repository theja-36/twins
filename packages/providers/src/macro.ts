import { MACRO_CONTEXT_FORMAT } from "@twins/agents";
import type { FredClient } from "./fred";

/**
 * MACRO context: the Indian index level / previous close / open / recent closes come from the Kite snapshots (twins-ohlc-v1 + twins-last-price-v1, local files); the global indices and
 * USDINR come from FRED daily series (previous daily closes, so a day behind by nature); `releases` are the economic-calendar events. NOT available from any free machine-readable source and
 * therefore left out (the format makes them optional): market breadth and India VIX.
 * The document's `as_of` is the OLDEST index timestamp used (never the export time), so staleness is visible to the agent.
 */
export const GLOBAL_SERIES = [
  { name: "SP500", series: "SP500", tz: "America/New_York", open: "09:30", close: "16:00" },
  { name: "NASDAQ", series: "NASDAQCOM", tz: "America/New_York", open: "09:30", close: "16:00" },
  { name: "DOW", series: "DJIA", tz: "America/New_York", open: "09:30", close: "16:00" },
  { name: "NIKKEI225", series: "NIKKEI225", tz: "Asia/Tokyo", open: "09:00", close: "15:00" },
] as const;
export const USDINR_SERIES = "DEXINUS"; // Indian rupees per US dollar

export function sessionStatus(now: Date, tz: string, open: string, close: string): "open" | "closed" {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return "closed";
  const hhmm = `${get("hour")}:${get("minute")}`;
  return hhmm >= open && hhmm < close ? "open" : "closed";
}
const pct = (last: number, prev: number): number => Math.round(((last - prev) / prev) * 100 * 1000) / 1000;

interface Bar { t: string; o: number; c: number }
const istDate = (d: Date): string => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const isBar = (b: unknown): b is Bar => !!b && typeof (b as Bar).t === "string" && Number.isFinite((b as Bar).o) && Number.isFinite((b as Bar).c) && (b as Bar).c > 0;

export interface IndexContext { symbol: string; market: string; level: number; previousClose: number | null; open: number | null; recentCloses: number[]; asOf: string; changePct1d: number | null }
/** Per index in the OHLC snapshot, from its daily bars and the last price. An index without a fresh last price is left out (never guessed). */
export function indexContexts(ohlc: unknown, last: unknown, now: Date, maxAgeHours = 36): IndexContext[] {
  const series = (ohlc as { series?: Record<string, { bars?: unknown[] }> } | null)?.series ?? {};
  const prices = (last as { prices?: Record<string, { price?: unknown; as_of?: unknown }> } | null)?.prices ?? {};
  const today = istDate(now), out: IndexContext[] = [];
  for (const [key, s] of Object.entries(series)) {
    const m = /^([A-Z0-9]{2,20}):([A-Z0-9&._-]{1,30})$/.exec(key);
    const p = Object.hasOwn(prices, key) ? prices[key] : undefined;
    const level = typeof p?.price === "number" && p.price > 0 ? p.price : null, asOf = typeof p?.as_of === "string" && !Number.isNaN(Date.parse(p.as_of)) ? p.as_of : null;
    if (!m || level === null || asOf === null || now.getTime() - Date.parse(asOf) > maxAgeHours * 3_600_000) continue;
    const bars = (Array.isArray(s?.bars) ? s.bars : []).filter(isBar).sort((a, b) => (a.t < b.t ? -1 : 1));
    const prior = bars.filter((b) => b.t.slice(0, 10) < today), todayBar = bars.find((b) => b.t.slice(0, 10) === today);
    const previousClose = prior.length ? prior[prior.length - 1]!.c : null;
    out.push({ symbol: m[2]!, market: m[1]!, level, previousClose, open: todayBar?.o ?? null, recentCloses: prior.slice(-20).map((b) => b.c), asOf, changePct1d: previousClose ? pct(level, previousClose) : null });
  }
  return out;
}

export async function buildMacro(deps: { ohlc: unknown; last: unknown; fred: FredClient | null; releases: unknown[]; now: () => Date }): Promise<{ document: Record<string, unknown>; indices: number; global: number } | null> {
  const now = deps.now();
  const idx = indexContexts(deps.ohlc, deps.last, now);
  if (idx.length === 0) return null; // no fresh index => nothing honest to publish
  const shared: Record<string, unknown> = {};
  let global = 0;
  if (deps.fred) {
    const entries: Array<Record<string, unknown>> = [];
    for (const g of GLOBAL_SERIES) {
      try {
        const o = await deps.fred.observations(g.series, 5);
        if (o.length >= 2) entries.push({ name: g.name, session_status: sessionStatus(now, g.tz, g.open, g.close), change_pct_1d: pct(o[o.length - 1]!.value, o[o.length - 2]!.value) });
      } catch { /* a series that cannot be read is simply left out */ }
    }
    if (entries.length) { shared["global"] = entries; global = entries.length; }
    try {
      const o = await deps.fred.observations(USDINR_SERIES, 5);
      if (o.length >= 2) shared["currency"] = { pair: "USDINR", change_pct_1d: pct(o[o.length - 1]!.value, o[o.length - 2]!.value) };
    } catch { /* optional */ }
  }
  if (deps.releases.length) shared["releases"] = deps.releases;
  const contexts: Record<string, unknown> = {};
  for (const i of idx) contexts[`${i.market}:${i.symbol}`] = { index: { symbol: i.symbol, level: i.level, ...(i.previousClose ? { previous_close: i.previousClose } : {}), ...(i.open ? { open: i.open } : {}), recent_closes: i.recentCloses }, ...shared };
  const nifty = idx.find((i) => i.symbol === "NIFTY") ?? idx[0]!;
  contexts["NSE:*"] = contexts[`${nifty.market}:${nifty.symbol}`];
  const asOf = idx.map((i) => i.asOf).sort()[0]!;
  return { document: { format: MACRO_CONTEXT_FORMAT, source: "kite-snapshot+fred", as_of: asOf, contexts }, indices: idx.length, global };
}
