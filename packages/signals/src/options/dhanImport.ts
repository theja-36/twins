import { createHash } from "node:crypto";
import { SUPPORTED_UNDERLYINGS } from "./types";
import { DHAN_IMPORTER_VERSION, PROVIDER_LISTED_STATEMENT, SNAPSHOT_SCHEMA_VERSION, type ProviderContractRow, type ProviderSnapshotFile } from "./providerSnapshot";

/**
 * Pure, offline importer for a Dhan instrument-master CSV the owner downloaded separately. Column names follow Dhan's
 * published detailed and compact layouts. Dhan's docs do not specify date/strike formats, lot/tick units or the
 * instrument's own security-id column, so: expiry is accepted only in strictly recognised shapes, the tick size is kept
 * verbatim, the security id is kept only from an explicitly known column, and anything else rejects the row.
 */
const COLUMNS = {
  detailed: { exchange: "EXCH_ID", segment: "SEGMENT", instrument: "INSTRUMENT", securityId: "SECURITY_ID", underlyingSecurityId: "UNDERLYING_SECURITY_ID", underlyingSymbol: "UNDERLYING_SYMBOL", symbolName: "SYMBOL_NAME", displayName: "DISPLAY_NAME", lot: "LOT_SIZE", expiry: "SM_EXPIRY_DATE", strike: "STRIKE_PRICE", optionType: "OPTION_TYPE", tick: "TICK_SIZE" },
  compact: { exchange: "SEM_EXM_EXCH_ID", segment: "SEM_SEGMENT", instrument: "SEM_INSTRUMENT_NAME", securityId: "SEM_SMST_SECURITY_ID", underlyingSecurityId: "", underlyingSymbol: "SM_SYMBOL_NAME", symbolName: "SM_SYMBOL_NAME", displayName: "SEM_CUSTOM_SYMBOL", lot: "SEM_LOT_UNITS", expiry: "SEM_EXPIRY_DATE", strike: "SEM_STRIKE_PRICE", optionType: "SEM_OPTION_TYPE", tick: "SEM_TICK_SIZE" },
} as const;
type Layout = keyof typeof COLUMNS;

export class DhanImportError extends Error {}

/** RFC-4180-style parser: quotes, escaped quotes, CRLF/LF. Throws on an unterminated quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false, i = 0;
  const t = text.replace(/^﻿/, "");
  for (; i < t.length; i++) {
    const c = t[i]!;
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === "") q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else cell += c;
  }
  if (q) throw new DhanImportError("CSV has an unterminated quoted field");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function detectLayout(header: string[]): Layout {
  const h = new Set(header.map((x) => x.trim()));
  for (const layout of ["detailed", "compact"] as const) {
    const c = COLUMNS[layout];
    const need = [c.exchange, c.segment, c.instrument, c.lot, c.expiry, c.strike, c.optionType, c.underlyingSymbol];
    if (need.every((n) => h.has(n))) return layout;
  }
  throw new DhanImportError("CSV header matches neither Dhan's documented detailed nor compact layout; refusing to guess columns");
}

/** Date part of the provider's expiry field. Only YYYY-MM-DD (optionally followed by a time) is recognised; nothing else is guessed. */
export function expiryDatePart(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(raw.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(d) ? d : null;
}

const POS_NUMBER = /^\d+(\.\d+)?$/;

export interface DhanImportInput {
  csvText: string;
  sourceUrl: string;
  retrievedAt: string;
  retrievalTimeSource: "owner_supplied" | "file_mtime_estimate";
  importedAt: string;
  synthetic?: boolean;
}

export function buildDhanSnapshot(input: DhanImportInput): ProviderSnapshotFile {
  if (!/^https:\/\//.test(input.sourceUrl)) throw new DhanImportError("source URL must be an https URL (recorded as provenance only; it is never fetched)");
  if (Number.isNaN(new Date(input.retrievedAt).getTime())) throw new DhanImportError("retrievedAt must be a valid ISO instant");
  const rows = parseCsv(input.csvText);
  const header = rows[0]?.map((x) => x.trim());
  if (!header) throw new DhanImportError("CSV is empty");
  const layout = detectLayout(header);
  const c = COLUMNS[layout];
  const idx = (name: string) => (name ? header.indexOf(name) : -1);
  const col = { exchange: idx(c.exchange), segment: idx(c.segment), instrument: idx(c.instrument), securityId: idx(c.securityId), underlyingSecurityId: idx(c.underlyingSecurityId), underlyingSymbol: idx(c.underlyingSymbol), symbolName: idx(c.symbolName), displayName: idx(c.displayName), lot: idx(c.lot), expiry: idx(c.expiry), strike: idx(c.strike), optionType: idx(c.optionType), tick: idx(c.tick) };
  const skipped: Record<string, number> = {};
  const rejected: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const contracts: ProviderContractRow[] = [];
  for (const cells of rows.slice(1)) {
    const get = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    if (cells.length !== header.length) { bump(rejected, "column_count_mismatch"); continue; }
    const instrument = get(col.instrument);
    // Only index options are in scope for the options-claim flow; everything else is skipped, not rejected.
    if (instrument !== "OPTIDX") { bump(skipped, "not_index_option"); continue; }
    const underlying = layout === "detailed" ? get(col.underlyingSymbol) : get(col.underlyingSymbol).toUpperCase();
    if (!SUPPORTED_UNDERLYINGS.includes(underlying as never)) { bump(skipped, "underlying_not_supported"); continue; }
    const optionType = get(col.optionType);
    if (optionType !== "CE" && optionType !== "PE") { bump(rejected, "option_type_invalid"); continue; }
    const expiryRaw = get(col.expiry);
    const expiryDate = expiryDatePart(expiryRaw);
    if (!expiryDate) { bump(rejected, "expiry_unrecognised"); continue; }
    const strikeRaw = get(col.strike);
    const strike = POS_NUMBER.test(strikeRaw) ? Number(strikeRaw) : NaN;
    if (!Number.isInteger(strike) || strike <= 0) { bump(rejected, "strike_invalid_or_not_integer"); continue; }
    const lotRaw = get(col.lot);
    const lotSize = POS_NUMBER.test(lotRaw) ? Number(lotRaw) : NaN;
    if (!Number.isInteger(lotSize) || lotSize <= 0) { bump(rejected, "lot_size_invalid"); continue; }
    const exchange = get(col.exchange), segment = get(col.segment);
    if (!exchange || !segment) { bump(rejected, "exchange_or_segment_missing"); continue; }
    const tick = get(col.tick);
    const row: ProviderContractRow = { provider: "dhan", exchange, segment, instrument, underlyingSymbol: underlying, strike, optionType, expiryDate, expiryRaw, lotSize };
    const sid = get(col.securityId);
    if (sid) row.securityId = sid;
    const usid = get(col.underlyingSecurityId);
    if (usid) row.underlyingSecurityId = usid;
    const sn = get(col.symbolName); if (sn) row.symbolName = sn;
    const dn = get(col.displayName); if (dn) row.displayName = dn;
    if (tick !== "" && POS_NUMBER.test(tick) && Number(tick) > 0) row.tickSizeRaw = tick;
    else if (tick !== "") { bump(rejected, "tick_size_invalid"); continue; }
    contracts.push(row);
  }
  return {
    referenceKind: "provider_instrument_snapshot", provider: "dhan", snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION, importerVersion: DHAN_IMPORTER_VERSION,
    synthetic: input.synthetic ?? false, liveMarketData: false, statement: PROVIDER_LISTED_STATEMENT, importedAt: input.importedAt,
    source: { sourceUrl: input.sourceUrl, retrievedAt: input.retrievedAt, retrievalTimeSource: input.retrievalTimeSource, contentSha256: createHash("sha256").update(input.csvText).digest("hex"), csvFormat: `dhan-${layout}`, columnsSeen: header },
    counts: { rowsRead: rows.length - 1, kept: contracts.length, skipped, rejected },
    contracts,
  };
}
