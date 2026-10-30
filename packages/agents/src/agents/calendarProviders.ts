import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkFile } from "@twins/historical";
import { AgentContractError } from "../contract";

/**
 * Calendar providers (Stage 5 / Task 3): the INJECTABLE interfaces the Market Calendar Agent uses. No external API is integrated; the shipped implementations are in-memory (tests) and
 * file-based over a pre-exported snapshot. A provider never invents data: a day or window it does not cover is `null`, a failing provider throws.
 */
export type EventImpact = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const EVENT_IMPACTS: readonly EventImpact[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export interface DayInfo {
  /** YYYY-MM-DD, the market's local date. */
  date: string;
  holiday: boolean;
  holidayName: string | null;
  /** "HH:MM" local time of an early close (half day), or null. */
  earlyCloseLocal: string | null;
}
export interface HolidayCalendarProvider {
  readonly name: string;
  /** When the snapshot was taken (ISO), or null. */
  readonly asOf: string | null;
  /** The day's status, or null when the provider does not cover the market / date. */
  day(market: string, date: string): Promise<DayInfo | null>;
}
export interface CalendarEvent {
  id: string;
  name: string;
  /** ISO instant with an offset. */
  at: string;
  impact: EventImpact;
  /** Affected market codes; "ALL" = every market. */
  markets: string[];
  category?: string;
}
export interface EconomicCalendarProvider {
  readonly name: string;
  readonly asOf: string | null;
  /** The instants the snapshot covers (ISO, inclusive). */
  readonly coverage: { from: string; to: string };
  /** Events with `from <= at <= to`. Returned data is validated again by the agent. */
  events(q: { from: string; to: string }): Promise<CalendarEvent[]>;
}

const up = (s: string): string => s.trim().toUpperCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const realDate = (s: string): boolean => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const isoInstant = (s: unknown): string | null => (typeof s === "string" && ISO_OFFSET.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T"))) ? new Date(s.replace(" ", "T")).toISOString() : null);
const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_CALENDAR_DATA", `${kind}: ${what}`); };

/** Validates one event (also used by the agent on whatever a provider returns). Returns null when malformed. */
export function validateCalendarEvent(x: unknown): CalendarEvent | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const at = isoInstant(o["at"]);
  if (typeof o["id"] !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(o["id"]) || typeof o["name"] !== "string" || o["name"].trim().length === 0 || o["name"].length > 120 || at === null) return null;
  if (!EVENT_IMPACTS.includes(o["impact"] as EventImpact)) return null;
  if (!Array.isArray(o["markets"]) || o["markets"].length === 0 || o["markets"].length > 20 || o["markets"].some((m) => typeof m !== "string" || !/^[A-Z0-9]{2,20}$/.test(m))) return null;
  return { id: o["id"], name: o["name"].trim(), at, impact: o["impact"] as EventImpact, markets: [...(o["markets"] as string[])], ...(typeof o["category"] === "string" && /^[a-z0-9_]{1,40}$/.test(o["category"]) ? { category: o["category"] } : {}) };
}

export interface MemoryHolidayCalendarOptions {
  name?: string; asOf?: string | null;
  /** Per market: the covered date range and the exceptional days. Days inside the range and not listed are regular days. */
  markets: Record<string, { from: string; to: string; days: Array<{ date: string; holiday?: boolean; name?: string; earlyCloseLocal?: string }> }>;
}
export function memoryHolidayCalendar(o: MemoryHolidayCalendarOptions): HolidayCalendarProvider {
  const m = new Map(Object.entries(o.markets).map(([k, v]) => [up(k), v]));
  return {
    name: o.name ?? "memory-holidays", asOf: o.asOf ?? null,
    async day(market, date) {
      const c = m.get(up(market));
      if (!c || date < c.from || date > c.to) return null;
      const d = c.days.find((x) => x.date === date);
      return { date, holiday: d?.holiday === true, holidayName: d?.holiday === true ? (d.name ?? null) : null, earlyCloseLocal: d?.earlyCloseLocal ?? null };
    },
  };
}
export function memoryEconomicCalendar(o: { name?: string; asOf?: string | null; coverage: { from: string; to: string }; events: unknown[] }): EconomicCalendarProvider {
  return {
    name: o.name ?? "memory-economic", asOf: o.asOf ?? null, coverage: o.coverage,
    // malformed entries are passed through unfiltered so the agent can see (and reject) them
    async events(q) { return (o.events as CalendarEvent[]).filter((e) => { if (validateCalendarEvent(e) === null) return true; const t = Date.parse(e.at); return !(t < Date.parse(q.from)) && !(t > Date.parse(q.to)); }); },
  };
}

export const HOLIDAY_CALENDAR_FORMAT = "twins-holiday-calendar-v1";
export const ECONOMIC_CALENDAR_FORMAT = "twins-economic-calendar-v1";
/**
 * `twins-holiday-calendar-v1` (JSON): { "format", "source", "as_of": "<ISO>", "markets": { "NSE": { "from": "2025-01-01", "to": "2025-12-31",
 *   "days": [ { "date": "2025-03-14", "holiday": true, "name": "Holi" }, { "date": "2025-10-21", "early_close": "13:30" } ] } } }
 * Strict: malformed dates, duplicate days, a holiday with an early close and unknown keys' types are rejected; nothing is repaired.
 */
export function parseHolidayCalendar(raw: unknown): HolidayCalendarProvider {
  const k = "holiday calendar file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== HOLIDAY_CALENDAR_FORMAT) bad(k, "unsupported format");
  const asOf = isoInstant(r["as_of"]) ?? bad(k, "as_of must be an ISO instant with an offset");
  if (typeof r["markets"] !== "object" || r["markets"] === null || Array.isArray(r["markets"]) || Object.keys(r["markets"]).length === 0) bad(k, "markets must be an object");
  const markets: MemoryHolidayCalendarOptions["markets"] = {};
  for (const [mk, mv] of Object.entries(r["markets"] as Record<string, unknown>)) {
    if (!/^[A-Z0-9]{2,20}$/.test(mk)) bad(k, "market code");
    const o = mv as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o["from"] !== "string" || typeof o["to"] !== "string" || !realDate(o["from"]) || !realDate(o["to"]) || o["from"] > o["to"]) return bad(k, `${mk}: from / to`);
    if (!Array.isArray(o["days"]) || o["days"].length > 5000) bad(k, `${mk}: days`);
    const seen = new Set<string>();
    const days = (o["days"] as unknown[]).map((x, i) => {
      const d = x as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || typeof d["date"] !== "string" || !realDate(d["date"])) return bad(k, `${mk}.days[${i}]: date`);
      const date = d["date"] as string;
      if (date < (o["from"] as string) || date > (o["to"] as string)) bad(k, `${mk}.days[${i}]: outside the covered range`);
      if (seen.has(date)) bad(k, `${mk}.days[${i}]: duplicate date`);
      seen.add(date);
      const holiday = d["holiday"] === true;
      if (d["holiday"] !== undefined && typeof d["holiday"] !== "boolean") bad(k, `${mk}.days[${i}]: holiday`);
      const early = d["early_close"];
      if (early !== undefined && (typeof early !== "string" || !HHMM.test(early))) bad(k, `${mk}.days[${i}]: early_close`);
      if (holiday && early !== undefined) bad(k, `${mk}.days[${i}]: a holiday cannot have an early close`);
      if (!holiday && early === undefined) bad(k, `${mk}.days[${i}]: neither a holiday nor an early close`);
      const name = d["name"];
      if (name !== undefined && (typeof name !== "string" || name.length > 80)) bad(k, `${mk}.days[${i}]: name`);
      return { date, ...(holiday ? { holiday: true } : {}), ...(typeof name === "string" ? { name: name.replace(/[^A-Za-z0-9 .,&()/'-]/g, "_") } : {}), ...(typeof early === "string" ? { earlyCloseLocal: early } : {}) };
    });
    markets[mk] = { from: o["from"] as string, to: o["to"] as string, days };
  }
  return memoryHolidayCalendar({ name: typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file", asOf, markets });
}
/**
 * `twins-economic-calendar-v1` (JSON): { "format", "source", "as_of", "coverage": { "from": "<ISO>", "to": "<ISO>" },
 *   "events": [ { "id": "us-fomc-2025-01", "name": "Policy rate decision", "at": "<ISO with offset>", "impact": "CRITICAL", "markets": ["NSE","ALL"], "category": "central_bank" } ] }
 */
export function parseEconomicCalendar(raw: unknown): EconomicCalendarProvider {
  const k = "economic calendar file";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(k, "not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== ECONOMIC_CALENDAR_FORMAT) bad(k, "unsupported format");
  const asOf = isoInstant(r["as_of"]) ?? bad(k, "as_of must be an ISO instant with an offset");
  const cov = r["coverage"] as Record<string, unknown> | null;
  const from = isoInstant(cov?.["from"]), to = isoInstant(cov?.["to"]);
  if (!from || !to || from > to) bad(k, "coverage must be an ISO range");
  if (!Array.isArray(r["events"]) || r["events"].length > 20_000) bad(k, "events must be a list");
  const seen = new Set<string>();
  const events = (r["events"] as unknown[]).map((x, i) => {
    const e = validateCalendarEvent(x) ?? bad(k, `events[${i}] is malformed`);
    if (seen.has(e.id)) bad(k, `events[${i}]: duplicate id`);
    seen.add(e.id);
    return e;
  });
  return memoryEconomicCalendar({ name: typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file", asOf, coverage: { from: from as string, to: to as string }, events });
}
function readJson(path: string, what: string): unknown {
  let info;
  try { info = checkFile(path); } catch { throw new AgentContractError("INVALID_CALENDAR_DATA", `${what} ${basename(path)} is unreadable or refused`); }
  if (info.format !== "json") throw new AgentContractError("INVALID_CALENDAR_DATA", `${what} must be a .json file`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new AgentContractError("INVALID_CALENDAR_DATA", `${what} is not valid JSON`); }
}
export const fileHolidayCalendar = (path: string): HolidayCalendarProvider => parseHolidayCalendar(readJson(path, "the holiday calendar"));
export const fileEconomicCalendar = (path: string): EconomicCalendarProvider => parseEconomicCalendar(readJson(path, "the economic calendar"));
