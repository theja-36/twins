import { ECONOMIC_CALENDAR_FORMAT, HOLIDAY_CALENDAR_FORMAT } from "@twins/agents";
import type { FredClient } from "./fred";

/**
 * ECONOMIC EVENTS from FRED release dates (official, free key). FRED publishes the DATE of each release, not its time; the time of day below is the usual release time for that series in US
 * Eastern time and is an approximation. Only a short, named list of market-moving US releases is exported; everything else FRED lists is ignored.
 * HOLIDAYS have no reliable free machine-readable source, so they are imported from a CSV the owner supplies and confirms (date,kind,name,early_close); the importer validates it strictly.
 */
type Impact = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const RELEASES: ReadonlyArray<{ match: RegExp; id: string; name: string; impact: Impact; category: string; at: string }> = [
  { match: /^FOMC Press Release/i, id: "fomc", name: "US Fed rate decision", impact: "CRITICAL", category: "central_bank", at: "14:00" },
  { match: /^Consumer Price Index/i, id: "cpi", name: "US CPI inflation", impact: "HIGH", category: "inflation", at: "08:30" },
  { match: /^Employment Situation/i, id: "nfp", name: "US jobs report", impact: "HIGH", category: "labour", at: "08:30" },
  { match: /^Gross Domestic Product/i, id: "gdp", name: "US GDP", impact: "HIGH", category: "growth", at: "08:30" },
  { match: /^Producer Price Index/i, id: "ppi", name: "US PPI", impact: "MEDIUM", category: "inflation", at: "08:30" },
  { match: /^Advance Monthly Sales for Retail/i, id: "retail", name: "US retail sales", impact: "MEDIUM", category: "consumption", at: "08:30" },
  { match: /^Personal Income and Outlays/i, id: "pce", name: "US personal income and PCE", impact: "MEDIUM", category: "inflation", at: "08:30" },
  { match: /^Job Openings and Labor Turnover/i, id: "jolts", name: "US job openings (JOLTS)", impact: "MEDIUM", category: "labour", at: "10:00" },
];

/** UTC instant of a wall-clock time in America/New_York (handles daylight saving). */
export function easternInstant(date: string, hhmm: string): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  const offMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -300;
  return new Date(guess - offMin * 60_000).toISOString();
}
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export async function buildEconomicCalendar(deps: { fred: FredClient; now: () => Date; daysBack?: number; daysAhead?: number }): Promise<{ document: Record<string, unknown>; events: number }> {
  const now = deps.now();
  const from = ymd(new Date(now.getTime() - (deps.daysBack ?? 2) * 86_400_000)), to = ymd(new Date(now.getTime() + (deps.daysAhead ?? 21) * 86_400_000));
  const rows = await deps.fred.releaseDates(from, to);
  const seen = new Set<string>(), events: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const rel = RELEASES.find((x) => x.match.test(r.name));
    if (!rel) continue;
    const id = `fred-${rel.id}-${r.date}`;
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({ id, name: rel.name, at: easternInstant(r.date, rel.at), impact: rel.impact, markets: ["ALL"], category: rel.category });
  }
  events.sort((a, b) => (String(a["at"]) < String(b["at"]) ? -1 : 1));
  return { document: { format: ECONOMIC_CALENDAR_FORMAT, source: "fred-releases", as_of: now.toISOString(), coverage: { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z` }, events }, events: events.length };
}

const realDate = (s: string): boolean => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = Date.parse(`${s}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; }; // Date.parse is NaN for month 13; Feb 30 rolls over and is caught by the round trip
export class HolidayCsvError extends Error { constructor(readonly line: number, readonly why: string) { super(`line ${line}: ${why}`); this.name = "HolidayCsvError"; } }

/** CSV: `date,kind,name,early_close` with an optional header; kind is `holiday` or `early_close` (then the 4th column is HH:MM). `#` starts a comment. */
export function buildHolidayCalendar(csv: string, o: { market: string; from: string; to: string; source: string; now: Date }): { document: Record<string, unknown>; days: number } {
  if (!/^[A-Z0-9]{2,20}$/.test(o.market) || !realDate(o.from) || !realDate(o.to) || o.from > o.to) throw new HolidayCsvError(0, "market or range");
  const days: Array<Record<string, unknown>> = [];
  csv.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || (i === 0 && /^date\s*,/i.test(line))) return;
    const [date = "", kind = "", name = "", early = ""] = line.split(",").map((x) => x.trim());
    if (!realDate(date)) throw new HolidayCsvError(i + 1, "date");
    if (date < o.from || date > o.to) throw new HolidayCsvError(i + 1, "outside the covered range");
    if (kind === "holiday") days.push({ date, holiday: true, ...(name ? { name } : {}) });
    else if (kind === "early_close" && /^([01]\d|2[0-3]):[0-5]\d$/.test(early)) days.push({ date, early_close: early, ...(name ? { name } : {}) });
    else throw new HolidayCsvError(i + 1, "kind");
  });
  days.sort((a, b) => (String(a["date"]) < String(b["date"]) ? -1 : 1));
  return { document: { format: HOLIDAY_CALENDAR_FORMAT, source: o.source, as_of: o.now.toISOString(), markets: { [o.market]: { from: o.from, to: o.to, days } } }, days: days.length };
}
