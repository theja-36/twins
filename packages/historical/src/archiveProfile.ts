import { messageKey } from "./identity";
import { normalizeText, type NormalizedFields } from "./normalize";
import { prepareRecords, type BatchOptions } from "./prepare";
import type { InputFile } from "./readers";

/**
 * Archive profile (dry-run tooling for the staging import): READS a local export, normalizes every message version in memory and reports WHAT the archive contains and how much of it historical price bars could verify,
 * before anything is imported. Nothing is written, no database or network is used, and no message text is ever included: only counts, channel labels, dates, symbols and codes. The bar-source coverage
 * classification is derived from the existing market-data client rules (index underlyings only, currently listed contracts only, no expired contracts), NOT from a live check, so it is an estimate to plan with.
 */
export const ARCHIVE_PROFILE_VERSION = "archive-profile-v1";
/** The planned bar source's instrument catalog is scoped to these underlyings. */
export const BAR_SOURCE_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
export const COVERAGE = ["INDEX_UNDERLYING", "OPTION_LISTED", "OPTION_EXPIRED", "STOCK_NOT_IN_CATALOG", "NOT_ASSESSABLE"] as const;
export type Coverage = (typeof COVERAGE)[number];

const TOP_N = 25;
export interface ArchiveProfile {
  version: typeof ARCHIVE_PROFILE_VERSION; asOf: string; defaultMarket: string | null;
  totals: { records: number; invalid: number; messageVersions: number; uniqueMessages: number; revisions: number; duplicates: number; parseable: number };
  dateRange: { first: string | null; last: string | null; spanDays: number | null };
  byMonth: Record<string, number>;
  byChannel: Array<{ channel: string; messages: number; parseable: number }>;
  byParseStatus: Record<string, number>;
  byInstrumentType: Record<string, number>;
  byMarket: Record<string, number>;
  bySide: Record<string, number>;
  topUnderlyings: Array<{ underlying: string; signals: number }>;
  distinctUnderlyings: number;
  quality: { missingStopLoss: number; stopLossInvalid: number; ambiguous: number; incomplete: number };
  /** Parseable signals by how price bars could verify them (estimate from the market-data client rules). */
  barCoverage: Record<Coverage, number>;
  barCoverageShare: Record<Coverage, number | null>;
  /** Share of parseable signals that bars could plausibly verify (index underlyings plus currently listed option contracts). */
  plausiblyVerifiableShare: number | null;
  barPlan: { underlyings: string[]; dailyCallsEstimate: number; fiveMinuteCallsEstimate: number; estimatedSecondsAtHistoricalRate: number };
  notes: string[];
  grantsApproval: false; wroteAnything: false;
}
const bump = (o: Record<string, number>, k: string, n = 1): void => { o[k] = (o[k] ?? 0) + n; };
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const DAY = 86_400_000;

/** Pure classification of one normalized signal. `today` is an ISO date (YYYY-MM-DD). */
export function classifyCoverage(n: Pick<NormalizedFields, "parseStatus" | "instrumentType" | "underlying" | "expiryDate">, today: string): Coverage {
  if (n.parseStatus !== "SIGNAL" && n.parseStatus !== "OPTIONS_CLAIM") return "NOT_ASSESSABLE";
  const u = n.underlying?.toUpperCase() ?? null;
  const supported = u !== null && (BAR_SOURCE_UNDERLYINGS as readonly string[]).includes(u);
  if (n.instrumentType === "option") {
    if (!supported) return "STOCK_NOT_IN_CATALOG";
    if (n.expiryDate === null) return "NOT_ASSESSABLE";
    return n.expiryDate >= today ? "OPTION_LISTED" : "OPTION_EXPIRED";
  }
  if (u === null) return "NOT_ASSESSABLE";
  return supported ? "INDEX_UNDERLYING" : "STOCK_NOT_IN_CATALOG";
}

export function profileArchiveFromRows(rows: ReadonlyArray<{ channel: string; at: Date; n: NormalizedFields; revision: boolean }>, meta: { asOf: Date; defaultMarket: string | null; totals: Omit<ArchiveProfile["totals"], "parseable"> }): ArchiveProfile {
  const today = meta.asOf.toISOString().slice(0, 10);
  const byMonth: Record<string, number> = {}, byParse: Record<string, number> = {}, byInst: Record<string, number> = {}, byMarket: Record<string, number> = {}, bySide: Record<string, number> = {};
  const chan = new Map<string, { messages: number; parseable: number }>(), under = new Map<string, number>();
  const cov: Record<Coverage, number> = { INDEX_UNDERLYING: 0, OPTION_LISTED: 0, OPTION_EXPIRED: 0, STOCK_NOT_IN_CATALOG: 0, NOT_ASSESSABLE: 0 };
  const q = { missingStopLoss: 0, stopLossInvalid: 0, ambiguous: 0, incomplete: 0 };
  let first: Date | null = null, last: Date | null = null, parseable = 0;
  const supportedSeen = new Map<string, { min: number; max: number }>();
  for (const { channel, at, n, revision } of rows) {
    const c = chan.get(channel) ?? chan.set(channel, { messages: 0, parseable: 0 }).get(channel)!;
    if (!revision) c.messages += 1;
    bump(byParse, n.parseStatus);
    if (revision) continue;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
    bump(byMonth, at.toISOString().slice(0, 7));
    if (n.parseStatus !== "SIGNAL" && n.parseStatus !== "OPTIONS_CLAIM") continue;
    parseable += 1; c.parseable += 1;
    bump(byInst, n.instrumentType ?? "unknown"); bump(byMarket, n.market ?? "unknown"); bump(bySide, (n.side ?? "unknown").toLowerCase());
    if (n.underlying) under.set(n.underlying.toUpperCase(), (under.get(n.underlying.toUpperCase()) ?? 0) + 1);
    const k = classifyCoverage(n, today);
    cov[k] += 1;
    if (k === "INDEX_UNDERLYING" || k === "OPTION_LISTED" || k === "OPTION_EXPIRED") {
      const u = (n.underlying as string).toUpperCase(), t = at.getTime(), s = supportedSeen.get(u);
      supportedSeen.set(u, s ? { min: Math.min(s.min, t), max: Math.max(s.max, t) } : { min: t, max: t });
    }
    if (n.missingFields.includes("stopLoss") || n.stopLoss === null) q.missingStopLoss += 1;
    if (n.stopLossValidation && n.stopLossValidation.result !== "VALID" && n.stopLossValidation.result !== "MISSING") q.stopLossInvalid += 1;
    if (n.validationResult === "AMBIGUOUS") q.ambiguous += 1;
    if (n.validationResult === "INCOMPLETE") q.incomplete += 1;
  }
  const share = Object.fromEntries(COVERAGE.map((k) => [k, parseable === 0 ? null : r4(cov[k] / parseable)])) as Record<Coverage, number | null>;
  let daily = 0, five = 0;
  for (const { min, max } of supportedSeen.values()) { const days = Math.max(1, Math.ceil((max - min) / DAY) + 1); daily += Math.ceil(days / 2000); five += Math.ceil(days / 100); }
  const notes = [
    "Coverage is an estimate from the market-data client rules (index underlyings only, currently listed contracts only, no expired contracts); nothing was checked against the data source.",
    "Stock signals have no bar source until the instrument catalog is extended.",
    "Option signals whose contract has expired cannot be verified from that source's history.",
    "No message text is included in this report; channel labels are, so do not commit it to a public repository.",
  ];
  return {
    version: ARCHIVE_PROFILE_VERSION, asOf: meta.asOf.toISOString(), defaultMarket: meta.defaultMarket,
    totals: { ...meta.totals, parseable },
    dateRange: { first: first?.toISOString() ?? null, last: last?.toISOString() ?? null, spanDays: first && last ? Math.ceil((last.getTime() - first.getTime()) / DAY) + 1 : null },
    byMonth: Object.fromEntries(Object.entries(byMonth).sort()), byChannel: [...chan].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.messages - a.messages || (a.channel < b.channel ? -1 : 1)),
    byParseStatus: byParse, byInstrumentType: byInst, byMarket, bySide,
    topUnderlyings: [...under].map(([underlying, signals]) => ({ underlying, signals })).sort((a, b) => b.signals - a.signals || (a.underlying < b.underlying ? -1 : 1)).slice(0, TOP_N), distinctUnderlyings: under.size,
    quality: q, barCoverage: cov, barCoverageShare: share,
    plausiblyVerifiableShare: parseable === 0 ? null : r4((cov.INDEX_UNDERLYING + cov.OPTION_LISTED) / parseable),
    barPlan: { underlyings: [...supportedSeen.keys()].sort(), dailyCallsEstimate: daily, fiveMinuteCallsEstimate: five, estimatedSecondsAtHistoricalRate: Math.ceil(five / 3) },
    notes, grantsApproval: false, wroteAnything: false,
  };
}

/** Reads the files (no database), normalizes in memory and profiles. */
export async function profileArchive(files: InputFile[], opts: BatchOptions, now: Date = new Date()): Promise<ArchiveProfile> {
  const rows: Array<{ channel: string; at: Date; n: NormalizedFields; revision: boolean }> = [];
  const ids = new Set<string>(), keys = new Set<string>();
  const t = { records: 0, invalid: 0, messageVersions: 0, uniqueMessages: 0, revisions: 0, duplicates: 0 };
  for await (const r of prepareRecords(files, now)) {
    t.records += 1;
    if (r.kind === "invalid") { t.invalid += 1; continue; }
    const key = messageKey(r.message.channel, r.message.messageId);
    for (const v of r.versions) {
      if (ids.has(v.identity)) { t.duplicates += 1; continue; }
      ids.add(v.identity);
      const first = !keys.has(key);
      keys.add(key);
      t.messageVersions += 1;
      if (first) t.uniqueMessages += 1; else t.revisions += 1;
      rows.push({ channel: r.message.channel, at: v.timestamp, n: normalizeText(v.text, { recordMarket: r.message.market, defaultMarket: opts.defaultMarket, source: r.message.channel, ...(opts.sourceBasis ? { sourceBasis: opts.sourceBasis } : {}) }), revision: !first });
    }
  }
  return profileArchiveFromRows(rows, { asOf: now, defaultMarket: opts.defaultMarket, totals: t });
}
