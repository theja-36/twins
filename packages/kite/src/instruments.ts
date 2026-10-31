import { KiteError } from "./errors";

/** Supported scope, fixed by the owner: NIFTY 50, BANKNIFTY and SENSEX (index references + their listed futures/options). Everything else fails closed. */
export type KiteUnderlying = "NIFTY" | "BANKNIFTY" | "SENSEX";
export const SUPPORTED_UNDERLYINGS: readonly KiteUnderlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

interface Scope { underlying: KiteUnderlying; indexExchange: string; indexSymbol: string; derivExchange: string; futSegment: string; optSegment: string }
// Naming follows Kite's published instruments dump and is verified against SYNTHETIC fixtures only; a first live dump must be reconciled before wiring.
const SCOPES: readonly Scope[] = [
  { underlying: "NIFTY", indexExchange: "NSE", indexSymbol: "NIFTY 50", derivExchange: "NFO", futSegment: "NFO-FUT", optSegment: "NFO-OPT" },
  { underlying: "BANKNIFTY", indexExchange: "NSE", indexSymbol: "NIFTY BANK", derivExchange: "NFO", futSegment: "NFO-FUT", optSegment: "NFO-OPT" },
  { underlying: "SENSEX", indexExchange: "BSE", indexSymbol: "SENSEX", derivExchange: "BFO", futSegment: "BFO-FUT", optSegment: "BFO-OPT" },
];

export type KiteInstrumentKind = "index" | "future" | "option";
export interface KiteInstrument {
  token: number; exchangeToken: number; tradingSymbol: string; underlying: KiteUnderlying; kind: KiteInstrumentKind;
  exchange: string; segment: string; expiry: string | null; strike: number | null; optionType: "CE" | "PE" | null; lotSize: number | null; tickSize: number;
}
export interface InstrumentQuery { underlying: string; kind: KiteInstrumentKind; expiry?: string | null; strike?: number | null; optionType?: string | null }
export interface ParseStats { rows: number; inScope: number; outOfScope: number; rejected: Array<{ line: number; reason: string }> }

const COLUMNS = ["instrument_token", "exchange_token", "tradingsymbol", "name", "last_price", "expiry", "strike", "tick_size", "lot_size", "instrument_type", "segment", "exchange"] as const;

/** RFC 4180-style splitter (quoted fields, doubled quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new KiteError("INSTRUMENTS_INVALID");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const posInt = (s: string): number | null => (/^[0-9]{1,15}$/.test(s) && Number(s) > 0 ? Number(s) : null);
const num = (s: string): number | null => (/^-?[0-9]+(\.[0-9]+)?$/.test(s) ? Number(s) : null);
function isoDate(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export class InstrumentCatalog {
  private readonly byKey = new Map<string, KiteInstrument>();
  constructor(readonly instruments: readonly KiteInstrument[], readonly stats: ParseStats) {
    for (const i of instruments) this.byKey.set(keyOf(i.underlying, i.kind, i.expiry, i.strike, i.optionType), i);
  }
  /** True only for the three supported underlyings. */
  underlyingKnown(underlying: string): boolean { return (SUPPORTED_UNDERLYINGS as readonly string[]).includes(underlying.trim().toUpperCase()); }
  listedExpiries(underlying: string, kind: "future" | "option"): string[] {
    this.supported(underlying);
    return [...new Set(this.instruments.filter((i) => i.underlying === underlying.trim().toUpperCase() && i.kind === kind && i.expiry).map((i) => i.expiry as string))].sort();
  }
  /** The exact listed contract, or null when it is not listed. An unsupported underlying THROWS (never null): "not listed" and "out of scope" must not look alike. */
  lookup(q: InstrumentQuery): KiteInstrument | null {
    const u = this.supported(q.underlying);
    const optionType = q.optionType === undefined || q.optionType === null ? null : q.optionType.toUpperCase();
    if (q.kind !== "index" && !(q.expiry && isoDate(q.expiry))) return null;
    if (q.kind === "option" && (optionType !== "CE" && optionType !== "PE" || typeof q.strike !== "number")) return null;
    return this.byKey.get(keyOf(u, q.kind, q.kind === "index" ? null : q.expiry ?? null, q.kind === "option" ? q.strike ?? null : null, q.kind === "option" ? optionType : null)) ?? null;
  }
  require(q: InstrumentQuery): KiteInstrument {
    const hit = this.lookup(q);
    if (!hit) throw new KiteError("UNSUPPORTED_CONTRACT");
    return hit;
  }
  private supported(underlying: string): KiteUnderlying {
    const u = underlying.trim().toUpperCase();
    if (!(SUPPORTED_UNDERLYINGS as readonly string[]).includes(u)) throw new KiteError("UNSUPPORTED_UNDERLYING");
    return u as KiteUnderlying;
  }
}

const keyOf = (u: string, kind: string, expiry: string | null, strike: number | null, opt: string | null): string => `${u}|${kind}|${expiry ?? ""}|${strike ?? ""}|${opt ?? ""}`;

/**
 * Parses the instruments CSV. Rows outside the supported scope are skipped (counted). A row INSIDE the scope that is malformed is rejected and reported,
 * never repaired. A missing column, an empty dump, no index rows for a supported underlying, or a duplicated token/contract makes the whole dump unusable.
 */
export function parseInstrumentsCsv(text: string): InstrumentCatalog {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new KiteError("INSTRUMENTS_INVALID");
  const idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  if (COLUMNS.some((c) => idx[c] < 0)) throw new KiteError("INSTRUMENTS_INVALID");
  const stats: ParseStats = { rows: rows.length - 1, inScope: 0, outOfScope: 0, rejected: [] };
  const out: KiteInstrument[] = [];
  const tokens = new Set<number>();
  const keys = new Set<string>();
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const get = (c: (typeof COLUMNS)[number]): string => (r[idx[c]] ?? "").trim();
    const exchange = get("exchange"); const segment = get("segment"); const symbol = get("tradingsymbol"); const name = get("name");
    const scope = SCOPES.find((s) =>
      (exchange === s.indexExchange && segment === "INDICES" && symbol === s.indexSymbol) ||
      (exchange === s.derivExchange && (segment === s.futSegment || segment === s.optSegment) && name === s.underlying));
    if (!scope) { stats.outOfScope += 1; return; }
    stats.inScope += 1;
    const reject = (reason: string): void => { stats.rejected.push({ line, reason }); };
    const kind: KiteInstrumentKind = segment === "INDICES" ? "index" : segment === scope.futSegment ? "future" : "option";
    if (r.length < COLUMNS.length) return reject("short_row");
    const token = posInt(get("instrument_token")); const exchangeToken = posInt(get("exchange_token")); const tick = num(get("tick_size"));
    if (token === null || exchangeToken === null || tick === null || tick < 0) return reject("bad_number");
    let expiry: string | null = null; let strike: number | null = null; let optionType: "CE" | "PE" | null = null; let lotSize: number | null = null;
    if (kind !== "index") {
      expiry = isoDate(get("expiry"));
      lotSize = posInt(get("lot_size"));
      if (!expiry) return reject("bad_expiry");
      if (lotSize === null) return reject("bad_lot_size");
      const type = get("instrument_type");
      if (kind === "future" && type !== "FUT") return reject("bad_instrument_type");
      if (kind === "option") {
        if (type !== "CE" && type !== "PE") return reject("bad_instrument_type");
        optionType = type;
        strike = num(get("strike"));
        if (strike === null || strike <= 0) return reject("bad_strike");
      }
    }
    if (tokens.has(token) || keys.has(keyOf(scope.underlying, kind, expiry, strike, optionType))) throw new KiteError("INSTRUMENTS_INVALID"); // ambiguous dump
    tokens.add(token);
    keys.add(keyOf(scope.underlying, kind, expiry, strike, optionType));
    out.push({ token, exchangeToken, tradingSymbol: symbol, underlying: scope.underlying, kind, exchange, segment, expiry, strike, optionType, lotSize, tickSize: tick });
  });
  for (const s of SCOPES) if (!out.some((i) => i.underlying === s.underlying && i.kind === "index")) throw new KiteError("INSTRUMENTS_INVALID"); // a dump without its index references is not trusted
  return new InstrumentCatalog(out, stats);
}
