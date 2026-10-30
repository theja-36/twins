import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { checkFile } from "@twins/historical";
import { AgentContractError } from "../contract";

/**
 * Instrument reference (Stage 5 / Task 2): the INJECTABLE interface the Instrument Verification Agent uses to check that a market, underlying and contract exist. No live API (Zerodha,
 * vendor feeds) is integrated; the shipped implementations are an in-memory one (tests), a file-based one over a pre-exported snapshot, and a read-only adapter over the historical
 * datasets as supporting evidence only. A reference never invents data: an unknown instrument is `null`, a failing reference throws.
 */
export type RefInstrumentType = "equity" | "future" | "option";
export interface InstrumentRecord {
  market: string;
  underlying: string;
  instrumentType: RefInstrumentType;
  /** YYYY-MM-DD for futures and options. */
  expiry: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  lotSize: number | null;
  multiplier: number | null;
  active: boolean;
}
export interface InstrumentQuery { market: string; underlying: string; instrumentType: RefInstrumentType; expiry?: string | null; strike?: number | null; optionType?: string | null }
export interface InstrumentReference {
  readonly name: string;
  /** When the snapshot was taken (ISO); lets the agent flag a stale reference. */
  readonly asOf: string | null;
  supportsMarket(market: string): Promise<boolean>;
  underlyingKnown(market: string, underlying: string): Promise<boolean>;
  /** The exact instrument / contract, or null. */
  lookup(q: InstrumentQuery): Promise<InstrumentRecord | null>;
  /** Strikes / expiries listed for an underlying (to tell "contract not listed" from "underlying unknown"). */
  listedExpiries(market: string, underlying: string, instrumentType: RefInstrumentType): Promise<string[]>;
}
export interface HistoricalInstrumentReference { contractSeen(q: InstrumentQuery): Promise<boolean> }

const up = (s: string): string => s.trim().toUpperCase();
const sameContract = (r: InstrumentRecord, q: InstrumentQuery): boolean =>
  r.market === up(q.market) && r.underlying === up(q.underlying) && r.instrumentType === q.instrumentType && (r.expiry ?? null) === (q.expiry ?? null) && (r.strike ?? null) === (q.strike ?? null) && (r.optionType ?? null) === (q.optionType ? up(q.optionType) : null);

/** In-memory reference (tests and tools). */
export function memoryInstrumentReference(o: { name?: string; asOf?: string | null; markets: string[]; instruments: InstrumentRecord[] }): InstrumentReference {
  const markets = new Set(o.markets.map(up));
  const items = o.instruments.map((i) => ({ ...i, market: up(i.market), underlying: up(i.underlying), optionType: i.optionType ? (up(i.optionType) as "CE" | "PE") : null }));
  return {
    name: o.name ?? "memory", asOf: o.asOf ?? null,
    supportsMarket: async (m) => markets.has(up(m)),
    underlyingKnown: async (m, u) => items.some((i) => i.market === up(m) && i.underlying === up(u)),
    lookup: async (q) => items.find((i) => sameContract(i, q)) ?? null,
    listedExpiries: async (m, u, t) => [...new Set(items.filter((i) => i.market === up(m) && i.underlying === up(u) && i.instrumentType === t && i.expiry).map((i) => i.expiry as string))].sort(),
  };
}

export const INSTRUMENT_REFERENCE_FORMAT = "twins-instrument-reference-v1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (what: string): never => { throw new AgentContractError("INVALID_INSTRUMENT_REFERENCE", `instrument reference file: ${what}`); };
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 1_000_000 ? v : null);

/**
 * Parses a pre-exported instrument reference (JSON):
 *   { "format": "twins-instrument-reference-v1", "source": "<exporter>", "as_of": "<ISO>", "markets": ["NSE"],
 *     "instruments": [ { "market": "NSE", "underlying": "NIFTY", "instrument_type": "option", "expiry": "2031-10-29", "strike": 24500, "option_type": "CE", "lot_size": 75, "active": true } ] }
 * Strict: unknown instrument types, malformed dates / strikes, duplicate contracts and non-positive lot sizes are rejected; nothing is repaired.
 */
export function parseInstrumentReference(raw: unknown): InstrumentReference {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r["format"] !== INSTRUMENT_REFERENCE_FORMAT) bad("unsupported format");
  const asOf = typeof r["as_of"] === "string" && !Number.isNaN(Date.parse(r["as_of"])) ? new Date(r["as_of"]).toISOString() : bad("as_of must be an ISO instant");
  if (!Array.isArray(r["markets"]) || r["markets"].length === 0 || r["markets"].some((m) => typeof m !== "string" || !/^[A-Z0-9]{2,20}$/.test(m))) bad("markets must be upper-case codes");
  if (!Array.isArray(r["instruments"]) || r["instruments"].length > 200_000) bad("instruments must be a list");
  const seen = new Set<string>();
  const instruments = (r["instruments"] as unknown[]).map((x, i): InstrumentRecord => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return bad(`instrument ${i} is not an object`);
    const type = o["instrument_type"];
    if (type !== "equity" && type !== "future" && type !== "option") return bad(`instrument ${i}: unsupported instrument_type`);
    const market = typeof o["market"] === "string" && /^[A-Z0-9]{2,20}$/.test(o["market"]) ? o["market"] : bad(`instrument ${i}: market`);
    const underlying = typeof o["underlying"] === "string" && /^[A-Z0-9&._-]{1,30}$/.test(o["underlying"]) ? o["underlying"] : bad(`instrument ${i}: underlying`);
    const expiry = o["expiry"] === undefined || o["expiry"] === null ? null : typeof o["expiry"] === "string" && DATE.test(o["expiry"]) && !Number.isNaN(Date.parse(`${o["expiry"]}T00:00:00Z`)) ? o["expiry"] : bad(`instrument ${i}: expiry`);
    if (type !== "equity" && expiry === null) bad(`instrument ${i}: derivatives need an expiry`);
    const strike = o["strike"] === undefined || o["strike"] === null ? null : typeof o["strike"] === "number" && Number.isFinite(o["strike"]) && o["strike"] > 0 ? o["strike"] : bad(`instrument ${i}: strike`);
    const optionType = o["option_type"] === undefined || o["option_type"] === null ? null : o["option_type"] === "CE" || o["option_type"] === "PE" ? o["option_type"] : bad(`instrument ${i}: option_type`);
    if (type === "option" && (strike === null || optionType === null)) bad(`instrument ${i}: options need strike and option_type`);
    if (type !== "option" && (strike !== null || optionType !== null)) bad(`instrument ${i}: strike / option_type only apply to options`);
    const lot = o["lot_size"] === undefined || o["lot_size"] === null ? null : posInt(o["lot_size"]) ?? bad(`instrument ${i}: lot_size`);
    const mult = o["multiplier"] === undefined || o["multiplier"] === null ? null : posInt(o["multiplier"]) ?? bad(`instrument ${i}: multiplier`);
    const key = [market, underlying, type, expiry, strike, optionType].join("|");
    if (seen.has(key)) bad(`instrument ${i}: duplicate contract`);
    seen.add(key);
    return { market, underlying, instrumentType: type, expiry, strike, optionType: optionType as "CE" | "PE" | null, lotSize: lot, multiplier: mult, active: o["active"] !== false };
  });
  return memoryInstrumentReference({ name: typeof r["source"] === "string" && r["source"].length <= 60 ? `file:${r["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file", asOf, markets: r["markets"] as string[], instruments });
}
/** Reads a reference file (same safety checks as the historical datasets: regular file, no credential-like name, no binary, size cap). */
export function fileInstrumentReference(path: string): InstrumentReference {
  let info;
  try { info = checkFile(path); } catch { throw new AgentContractError("INVALID_INSTRUMENT_REFERENCE", `instrument reference file ${basename(path)} is unreadable or refused`); }
  if (info.format !== "json") throw new AgentContractError("INVALID_INSTRUMENT_REFERENCE", "the instrument reference must be a .json file");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new AgentContractError("INVALID_INSTRUMENT_REFERENCE", "the instrument reference is not valid JSON"); }
  return parseInstrumentReference(raw);
}

/** Supporting evidence from the imported historical datasets: was this contract ever present in pre-exported market data? Never a substitute for the reference. */
export function historicalDatasetReference(db: Db): HistoricalInstrumentReference {
  return {
    async contractSeen(q) {
      if (q.instrumentType !== "option" || q.strike == null || !q.optionType || !q.expiry) return false;
      const probe = JSON.stringify([{ kind: "option_premium", symbol: up(q.underlying), strike: q.strike, optionType: up(q.optionType), expiry: q.expiry }]);
      const rows = await db.select({ id: schema.historicalDatasets.id }).from(schema.historicalDatasets).where(sql`${schema.historicalDatasets.descriptor} @> ${probe}::jsonb`).limit(1);
      return rows.length > 0;
    },
  };
}
