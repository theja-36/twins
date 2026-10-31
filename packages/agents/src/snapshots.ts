import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { AgentContractError } from "./contract";
import { sanitizeText } from "./sanitize";
import { checkGeneration, ownsFile } from "./snapshotGeneration";
import {
  parseConstituentsFile, parseEconomicCalendar, parseHolidayCalendar, parseInstrumentQuotesFile, parseInstrumentReference, parseLastPriceFile, parseMacroContext, parseNewsFile, parseOhlcFile, parseOptionChainFile,
  parseOptionQuotesFile, parsePatternsFile, parseOutcomesFile, parseQuotesFile, parseSentimentFile, type AgentRulesConfig,
} from "./agents/index";

/**
 * Provider snapshot management (Stage 5 / Task 9). The research agents read PRE-EXPORTED snapshot files (`twins-*-v1` JSON); this module lists, validates and writes those files safely. It fetches nothing,
 * schedules nothing and deploys nothing: a snapshot arrives from an operator (or a later, separately reviewed exporter) and is accepted only if the SAME strict parser the agent uses accepts it. Reads use
 * the shared safe file checks (regular `.json` file, no symlink, no credential-like name); writes are atomic (temp file in the same directory, fsync, rename) and never replace an existing snapshot
 * without an explicit confirmation naming the kind. Listing and validation write nothing. Reports contain codes, ages, counts and short key lists - never file contents beyond that.
 *
 * Layout: `<snapshot dir>/<kind>.json` for each kind below. Freshness comes from the snapshot's own `as_of`; a calendar whose coverage has ended is EXPIRED whatever its age.
 *   OK        within the warn age        STALE     older than the warn age        EXPIRED  older than the max age (or coverage ended)
 *   MALFORMED the strict parser (or the JSON / as_of) rejects it                  UNSAFE   not a regular .json file / symlink / forbidden name / too large        MISSING  no file
 */
export type SnapshotKind =
  | "holiday-calendar" | "economic-calendar" | "macro-context" | "news" | "sentiment" | "constituents" | "market-data" | "quotes" | "option-quotes" | "option-chain" | "ohlc" | "last-price" | "instrument-reference"
  | "historical-patterns" | "historical-outcomes";
export type SnapshotStatus = "OK" | "STALE" | "EXPIRED" | "MALFORMED" | "UNSAFE" | "MISSING";
export type Strictness = "STRICT" | "LENIENT";
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

interface KindSpec {
  kind: SnapshotKind; label: string; format: string; parse(raw: unknown): unknown;
  /** The top-level field holding the entries (object keys or array items) counted as coverage. */
  collection: string;
  /** The key of the matching provider object handed to the registry (for provider-availability reports). */
  providerField: string;
  source(r: AgentRulesConfig): string;
  warnHours: number; maxHours: number;
}
const H = 1, D = 24;
export const SNAPSHOT_SPECS: readonly KindSpec[] = [
  { kind: "holiday-calendar", label: "Holiday calendar", format: "twins-holiday-calendar-v1", parse: parseHolidayCalendar, collection: "markets", providerField: "holidayCalendar", source: (r) => r.calendar.holidaySource, warnHours: 180 * D, maxHours: 365 * D },
  { kind: "economic-calendar", label: "Economic calendar", format: "twins-economic-calendar-v1", parse: parseEconomicCalendar, collection: "events", providerField: "economicCalendar", source: (r) => r.calendar.economicSource, warnHours: 7 * D, maxHours: 30 * D },
  { kind: "macro-context", label: "Macro / global context", format: "twins-macro-context-v1", parse: parseMacroContext, collection: "contexts", providerField: "macroProvider", source: (r) => r.macro.source, warnHours: 24 * H, maxHours: 48 * H },
  { kind: "news", label: "News", format: "twins-news-v1", parse: parseNewsFile, collection: "items", providerField: "newsProvider", source: (r) => r.news.source, warnHours: 6 * H, maxHours: 24 * H },
  { kind: "sentiment", label: "Sentiment", format: "twins-sentiment-v1", parse: parseSentimentFile, collection: "entries", providerField: "sentimentProvider", source: (r) => r.news.sentimentSource, warnHours: 6 * H, maxHours: 24 * H },
  { kind: "constituents", label: "Index constituents", format: "twins-index-constituents-v1", parse: parseConstituentsFile, collection: "indices", providerField: "constituentProvider", source: (r) => r.constituent.constituentSource, warnHours: 30 * D, maxHours: 90 * D },
  { kind: "market-data", label: "Market data (constituent moves)", format: "twins-market-quotes-v1", parse: parseQuotesFile, collection: "quotes", providerField: "marketDataProvider", source: (r) => r.constituent.marketDataSource, warnHours: 2 * H, maxHours: 24 * H },
  { kind: "quotes", label: "Market quotes (liquidity)", format: "twins-quotes-v1", parse: parseInstrumentQuotesFile, collection: "quotes", providerField: "quoteProvider", source: (r) => r.quotes.source, warnHours: 5 / 60, maxHours: 0.5 },
  { kind: "option-quotes", label: "Option quotes", format: "twins-option-quotes-v1", parse: parseOptionQuotesFile, collection: "quotes", providerField: "optionsQuoteProvider", source: (r) => r.quotes.optionSource, warnHours: 5 / 60, maxHours: 0.5 },
  { kind: "option-chain", label: "Option chain", format: "twins-option-chain-v1", parse: parseOptionChainFile, collection: "chains", providerField: "optionsChainProvider", source: (r) => r.quotes.chainSource, warnHours: 5 / 60, maxHours: 0.5 },
  { kind: "ohlc", label: "OHLC candles", format: "twins-ohlc-v1", parse: parseOhlcFile, collection: "series", providerField: "ohlcProvider", source: (r) => r.ohlc.source, warnHours: 24 * H, maxHours: 5 * D },
  { kind: "last-price", label: "Last price", format: "twins-last-price-v1", parse: parseLastPriceFile, collection: "prices", providerField: "lastPriceProvider", source: (r) => r.ohlc.priceSource, warnHours: 2 * H, maxHours: 24 * H },
  { kind: "instrument-reference", label: "Instrument reference", format: "twins-instrument-reference-v1", parse: parseInstrumentReference, collection: "instruments", providerField: "instrumentReference", source: (r) => r.instrument.referenceSource, warnHours: 7 * D, maxHours: 30 * D },
  { kind: "historical-patterns", label: "Historical patterns", format: "twins-historical-patterns-v1", parse: parsePatternsFile, collection: "patterns", providerField: "historicalPatternProvider", source: (r) => r.historical.patternSource, warnHours: 30 * D, maxHours: 120 * D },
  { kind: "historical-outcomes", label: "Historical outcomes", format: "twins-historical-outcomes-v1", parse: parseOutcomesFile, collection: "outcomes", providerField: "historicalOutcomeProvider", source: (r) => r.historical.outcomeSource, warnHours: 30 * D, maxHours: 120 * D },
];
export const SNAPSHOT_KINDS: readonly SnapshotKind[] = SNAPSHOT_SPECS.map((s) => s.kind);
const specOf = (kind: string): KindSpec | undefined => SNAPSHOT_SPECS.find((s) => s.kind === kind);
export const snapshotFileName = (kind: SnapshotKind): string => `${kind}.json`;

// ── configuration ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 *   TWINS_AGENT_SNAPSHOT_DIR              directory holding `<kind>.json` (default `data/agent-snapshots`, relative to the working directory; git-ignored)
 *   TWINS_AGENT_SNAPSHOT_REQUIRED         comma list of kinds that must be present and acceptable (default: all kinds, because the default required agents need all of them); empty value = none
 *   TWINS_AGENT_SNAPSHOT_STRICTNESS       STRICT | LENIENT (default STRICT: a required snapshot must be OK; any MALFORMED / UNSAFE snapshot fails. LENIENT: a required snapshot may also be STALE, and a malformed one that is not required only warns)
 *   TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS  JSON { "<kind>": { "warn": hours, "max": hours } } overriding the per-kind defaults (warn < max, both positive)
 */
export interface SnapshotConfig {
  dir: string; required: SnapshotKind[]; strictness: Strictness; freshness: Record<SnapshotKind, { warnHours: number; maxHours: number }>;
  /** Default true: a snapshot that belongs to a generation published as INCOMPLETE is MALFORMED (GENERATION_INCOMPLETE), so it cannot satisfy a consumer that needs complete data. */
  requireCompleteGeneration?: boolean;
}
export const DEFAULT_SNAPSHOT_DIR = "data/agent-snapshots";
const bad = (what: string): never => { throw new AgentContractError("INVALID_SNAPSHOT_CONFIG", `invalid snapshot configuration: ${what}`); };
export function defaultFreshness(): SnapshotConfig["freshness"] {
  return Object.fromEntries(SNAPSHOT_SPECS.map((s) => [s.kind, { warnHours: s.warnHours, maxHours: s.maxHours }])) as SnapshotConfig["freshness"];
}
/** A malformed value THROWS (a silently wrong snapshot policy would hide a stale feed). */
export function loadSnapshotConfig(env: Record<string, string | undefined> = process.env): SnapshotConfig {
  const dirRaw = env["TWINS_AGENT_SNAPSHOT_DIR"];
  if (dirRaw !== undefined && dirRaw !== "" && (dirRaw.length > 400 || dirRaw.includes("\0"))) bad("TWINS_AGENT_SNAPSHOT_DIR");
  const reqRaw = env["TWINS_AGENT_SNAPSHOT_REQUIRED"];
  let required: SnapshotKind[] = [...SNAPSHOT_KINDS];
  if (reqRaw !== undefined) {
    const list = reqRaw.split(",").map((x) => x.trim()).filter(Boolean);
    if (list.some((x) => !SNAPSHOT_KINDS.includes(x as SnapshotKind))) bad("TWINS_AGENT_SNAPSHOT_REQUIRED contains an unknown kind");
    required = [...new Set(list)].sort() as SnapshotKind[];
  }
  const sRaw = env["TWINS_AGENT_SNAPSHOT_STRICTNESS"];
  if (sRaw !== undefined && sRaw !== "" && sRaw !== "STRICT" && sRaw !== "LENIENT") bad("TWINS_AGENT_SNAPSHOT_STRICTNESS");
  const freshness = defaultFreshness();
  const fRaw = env["TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS"];
  if (fRaw !== undefined && fRaw.trim() !== "") {
    let o: unknown;
    try { o = JSON.parse(fRaw); } catch { return bad("TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS is not JSON"); }
    if (typeof o !== "object" || o === null || Array.isArray(o)) bad("TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS");
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const cur = freshness[k as SnapshotKind];
      const x = v as { warn?: unknown; max?: unknown } | null;
      if (!cur || !x || typeof x !== "object") return bad(`TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS.${k.slice(0, 30)}`);
      const warn = x.warn === undefined ? cur.warnHours : x.warn, max = x.max === undefined ? cur.maxHours : x.max;
      if (typeof warn !== "number" || typeof max !== "number" || !(warn > 0) || !(max > warn) || max > 24 * 3650) return bad(`TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS.${k} (warn must be positive and below max)`);
      freshness[k as SnapshotKind] = { warnHours: warn, maxHours: max };
    }
  }
  const cRaw = env["TWINS_AGENT_SNAPSHOT_REQUIRE_COMPLETE_GENERATION"];
  if (cRaw !== undefined && cRaw !== "" && cRaw !== "true" && cRaw !== "false") bad("TWINS_AGENT_SNAPSHOT_REQUIRE_COMPLETE_GENERATION");
  return { dir: dirRaw === undefined || dirRaw === "" ? DEFAULT_SNAPSHOT_DIR : dirRaw, required, strictness: sRaw === "LENIENT" ? "LENIENT" : "STRICT", freshness, requireCompleteGeneration: cRaw !== "false" };
}

// ── reports ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SnapshotReport {
  kind: SnapshotKind; label: string; file: string; required: boolean; status: SnapshotStatus;
  /** A fixed machine-readable reason (empty for OK / STALE / MISSING). */
  code: string; detail: string;
  asOf: string | null; ageHours: number | null; warnHours: number; maxHours: number; bytes: number | null; sha256: string | null;
  coverage: { entries: number; keys: string[]; from: string | null; to: string | null } | null;
  /** The provider setting for this kind: "none" or the file it reads; and whether that file is the one in the snapshot directory. */
  configuredSource: "none" | "file" | "unknown"; servesFromDirectory: boolean | null;
}
export interface SnapshotValidation {
  ok: boolean; strictness: Strictness; dir: string; dirExists: boolean; generatedAt: string;
  reports: SnapshotReport[];
  missingRequired: SnapshotKind[]; malformed: SnapshotKind[]; unsafe: SnapshotKind[]; expired: SnapshotKind[]; stale: SnapshotKind[];
  /** Required kinds whose provider setting does not read the snapshot directory's file (the agent would not use the snapshot). */
  notServed: SnapshotKind[];
  /** Files in the directory that are not a known snapshot, and leftover temporary files from an interrupted write. */
  unexpectedFiles: string[]; leftoverTemp: string[];
}
const round = (n: number): number => Math.round(n * 1000) / 1000;
const isoOf = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v.replace(" ", "T"))) ? new Date(v.replace(" ", "T")).toISOString() : null);

function coverageOf(spec: KindSpec, raw: Record<string, unknown>): NonNullable<SnapshotReport["coverage"]> {
  const c = raw[spec.collection];
  const keys = Array.isArray(c) ? [] : c && typeof c === "object" ? Object.keys(c as object) : [];
  const entries = Array.isArray(c) ? c.length : keys.length;
  let from: string | null = null, to: string | null = null;
  if (spec.kind === "economic-calendar") { const cv = raw["coverage"] as { from?: unknown; to?: unknown } | undefined; from = isoOf(cv?.from); to = isoOf(cv?.to); }
  if (spec.kind === "holiday-calendar" && c && typeof c === "object") {
    const ms = Object.values(c as Record<string, { from?: string; to?: string }>);
    const f = ms.map((m) => m.from).filter((x): x is string => typeof x === "string").sort(), t = ms.map((m) => m.to).filter((x): x is string => typeof x === "string").sort();
    from = f[0] ?? null; to = t[t.length - 1] ?? null;
  }
  return { entries, keys: keys.filter((k) => /^[A-Za-z0-9:&._|=-]{1,80}$/.test(k)).slice(0, 10), from, to };
}
const unsafeCode = (e: unknown): string => { const m = e instanceof Error ? e.message : ""; return /symlink/.test(m) ? "SYMLINK_NOT_ALLOWED" : /forbidden_file_name/.test(m) ? "FORBIDDEN_FILE_NAME" : /file_too_large/.test(m) ? "FILE_TOO_LARGE" : /not_a_regular_file/.test(m) ? "NOT_A_REGULAR_FILE" : /empty_file/.test(m) ? "EMPTY_FILE" : "UNSAFE_FILE"; };

export interface SnapshotIo {
  /** Replaced in tests to simulate failures. */
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
}
const realIo: SnapshotIo = { rename: renameSync, copyFile: copyFileSync };

/** Inspects one snapshot (read-only). */
export function inspectSnapshot(dir: string, kind: SnapshotKind, cfg: SnapshotConfig, now: Date, rules?: AgentRulesConfig): SnapshotReport {
  const spec = specOf(kind) as KindSpec;
  const fr = cfg.freshness[kind];
  const path = join(dir, snapshotFileName(kind));
  const src = rules ? spec.source(rules) : null;
  const base: SnapshotReport = {
    kind, label: spec.label, file: snapshotFileName(kind), required: cfg.required.includes(kind), status: "MISSING", code: "", detail: "", asOf: null, ageHours: null, warnHours: fr.warnHours, maxHours: fr.maxHours, bytes: null, sha256: null, coverage: null,
    configuredSource: src === null ? "unknown" : src === "none" ? "none" : "file", servesFromDirectory: src === null ? null : src.startsWith("file:") ? resolve(src.slice(5)) === resolve(path) : false,
  };
  let st;
  try { st = lstatSync(path); } catch { return { ...base, code: "SNAPSHOT_FILE_MISSING", detail: "no snapshot file" }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ...base, status: "UNSAFE", code: st.isSymbolicLink() ? "SYMLINK_NOT_ALLOWED" : "NOT_A_REGULAR_FILE", detail: "the snapshot is not a regular file" };
  if (st.size === 0 || st.size > MAX_SNAPSHOT_BYTES) return { ...base, status: "UNSAFE", code: st.size === 0 ? "EMPTY_FILE" : "FILE_TOO_LARGE", detail: "the snapshot is empty or too large", bytes: st.size };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return { ...base, status: "UNSAFE", code: unsafeCode(e), detail: "the snapshot cannot be read" }; }
  const sha256 = createHash("sha256").update(text).digest("hex");
  const withFile = { ...base, bytes: st.size, sha256 };
  // generation enforcement: a snapshot owned by a generation that is publishing, mixed, or (when required) incomplete is never accepted
  const gen = checkGeneration(dir);
  if (gen.state !== "none" && ownsFile(gen, snapshotFileName(kind))) {
    if (gen.state === "inconsistent") return { ...withFile, status: "MALFORMED", code: "GENERATION_INCONSISTENT", detail: `the snapshot generation is not consistent (${gen.code})` };
    if (!gen.manifest.complete && (cfg.requireCompleteGeneration ?? true)) return { ...withFile, status: "MALFORMED", code: "GENERATION_INCOMPLETE", detail: "the snapshot belongs to a generation that was published incomplete" };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ...withFile, status: "MALFORMED", code: "NOT_JSON", detail: "the snapshot is not valid JSON" }; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...withFile, status: "MALFORMED", code: "NOT_AN_OBJECT", detail: "the snapshot is not a JSON object" };
  const obj = raw as Record<string, unknown>;
  if (obj["format"] !== spec.format) return { ...withFile, status: "MALFORMED", code: "FORMAT_MISMATCH", detail: `expected format ${spec.format}` };
  try { spec.parse(raw); } catch (e) { return { ...withFile, status: "MALFORMED", code: typeof (e as { code?: unknown }).code === "string" ? String((e as { code: string }).code).slice(0, 60) : "STRICT_PARSE_FAILED", detail: sanitizeText(e instanceof Error ? e.message : "rejected", 120) }; }
  const asOf = isoOf(obj["as_of"]);
  if (asOf === null) return { ...withFile, status: "MALFORMED", code: "AS_OF_INVALID", detail: "as_of is missing or not an ISO instant with an offset" };
  const ageHours = (now.getTime() - Date.parse(asOf)) / 3_600_000;
  const coverage = coverageOf(spec, obj);
  const filled = { ...withFile, asOf, ageHours: round(ageHours), coverage };
  if (ageHours < -5 / 60) return { ...filled, status: "MALFORMED", code: "AS_OF_IN_FUTURE", detail: "as_of is in the future" };
  if (coverage.to !== null && Date.parse(coverage.to.length <= 10 ? `${coverage.to}T23:59:59Z` : coverage.to) < now.getTime()) return { ...filled, status: "EXPIRED", code: "COVERAGE_ENDED", detail: "the covered period has ended" };
  if (ageHours > fr.maxHours) return { ...filled, status: "EXPIRED", code: "SNAPSHOT_TOO_OLD", detail: `older than ${fr.maxHours} hours` };
  if (ageHours > fr.warnHours) return { ...filled, status: "STALE", code: "SNAPSHOT_STALE", detail: `older than ${fr.warnHours} hours` };
  return { ...filled, status: "OK" };
}

const TEMP = /^\.[a-z-]+\.json\.[0-9a-f]{8,}\.tmp$/;
/** Lists every known snapshot with its status (read-only); a missing directory reports every kind as MISSING. */
export function listSnapshots(cfg: SnapshotConfig, now: Date, rules?: AgentRulesConfig): SnapshotValidation {
  const dir = resolve(cfg.dir);
  let names: string[] = [];
  let dirExists = false;
  try { const st = lstatSync(dir); dirExists = st.isDirectory() && !st.isSymbolicLink(); if (dirExists) names = readdirSync(dir); } catch { dirExists = false; }
  const reports = SNAPSHOT_KINDS.map((k) => (dirExists ? inspectSnapshot(dir, k, cfg, now, rules) : { ...inspectSnapshot(join(dir, "none"), k, cfg, now, rules), code: "SNAPSHOT_DIRECTORY_MISSING", detail: "the snapshot directory does not exist" }));
  const known = new Set(SNAPSHOT_KINDS.map(snapshotFileName));
  const leftoverTemp = names.filter((n) => TEMP.test(n)).sort();
  const unexpectedFiles = names.filter((n) => !known.has(n) && !TEMP.test(n) && n !== ".previous").sort().slice(0, 50);
  const by = (s: SnapshotStatus): SnapshotKind[] => reports.filter((r) => r.status === s).map((r) => r.kind);
  const req = (r: SnapshotReport): boolean => r.required;
  const missingRequired = reports.filter((r) => req(r) && r.status === "MISSING").map((r) => r.kind);
  const notServed = reports.filter((r) => req(r) && r.status !== "MISSING" && r.servesFromDirectory === false).map((r) => r.kind);
  const strict = cfg.strictness === "STRICT";
  const failing = reports.filter((r) => {
    if (r.status === "MALFORMED" || r.status === "UNSAFE") return strict || r.required;
    if (!r.required) return false;
    return r.status === "MISSING" || r.status === "EXPIRED" || (strict && r.status === "STALE");
  });
  return { ok: failing.length === 0 && dirExists, strictness: cfg.strictness, dir, dirExists, generatedAt: now.toISOString(), reports, missingRequired, malformed: by("MALFORMED"), unsafe: by("UNSAFE"), expired: by("EXPIRED"), stale: by("STALE"), notServed, unexpectedFiles, leftoverTemp };
}
/** Validation is the same read-only assessment; `ok` is the verdict under the configured strictness. */
export const validateSnapshots = listSnapshots;

// ── atomic, confirmed writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export class SnapshotError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SnapshotError"; }
}
export interface WriteOptions {
  /** To REPLACE an existing snapshot this must equal the kind (an explicit, typed confirmation). */
  confirmOverwrite?: string;
  now?: Date;
  io?: Partial<SnapshotIo>;
}
export interface WriteResult { kind: SnapshotKind; file: string; replaced: boolean; bytes: number; sha256: string; asOf: string }
/**
 * Validates `content` with the kind's strict parser, then writes it atomically: a temp file in the same directory (exclusive create, mode 0600, fsync), then rename over the target. An existing snapshot
 * is replaced only with `confirmOverwrite === kind`, and its previous version is kept once in `.previous/<kind>.json`. On any failure the target is untouched and the temp file is removed.
 */
export function writeSnapshot(cfg: SnapshotConfig, kind: string, content: string | Record<string, unknown>, opts: WriteOptions = {}): WriteResult {
  const spec = specOf(kind);
  if (!spec) throw new SnapshotError("SNAPSHOT_KIND_UNKNOWN", "unknown snapshot kind");
  const io: SnapshotIo = { ...realIo, ...opts.io };
  const now = opts.now ?? new Date();
  const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0 || bytes > MAX_SNAPSHOT_BYTES) throw new SnapshotError("SNAPSHOT_SIZE", "the snapshot is empty or too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError("SNAPSHOT_NOT_JSON", "the snapshot is not valid JSON"); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SnapshotError("SNAPSHOT_INVALID", "the snapshot is not a JSON object");
  if ((raw as Record<string, unknown>)["format"] !== spec.format) throw new SnapshotError("SNAPSHOT_INVALID", `expected format ${spec.format}`);
  try { spec.parse(raw); } catch (e) { throw new SnapshotError("SNAPSHOT_INVALID", sanitizeText(e instanceof Error ? e.message : "rejected by the strict parser", 160)); }
  const asOf = isoOf((raw as Record<string, unknown>)["as_of"]);
  if (asOf === null) throw new SnapshotError("SNAPSHOT_INVALID", "as_of is missing or not an ISO instant with an offset");
  if (Date.parse(asOf) > now.getTime() + 5 * 60_000) throw new SnapshotError("SNAPSHOT_FUTURE", "as_of is in the future");

  const dir = resolve(cfg.dir);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SnapshotError("SNAPSHOT_UNSAFE", "the snapshot directory is not a plain directory");
  } catch (e) {
    if (e instanceof SnapshotError) throw e;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const target = join(dir, snapshotFileName(spec.kind));
  let exists = false;
  try { const st = lstatSync(target); exists = true; if (st.isSymbolicLink() || !st.isFile()) throw new SnapshotError("SNAPSHOT_UNSAFE", "the existing snapshot is not a regular file"); } catch (e) { if (e instanceof SnapshotError) throw e; }
  if (exists && opts.confirmOverwrite !== spec.kind) throw new SnapshotError("SNAPSHOT_EXISTS", `a ${spec.kind} snapshot already exists; replacing it needs an explicit confirmation naming the kind`);

  const tmp = join(dir, `.${spec.kind}.json.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let off = 0;
    const buf = Buffer.from(text, "utf8");
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd); closeSync(fd); fd = null;
    if (exists) { mkdirSync(join(dir, ".previous"), { recursive: true, mode: 0o700 }); io.copyFile(target, join(dir, ".previous", snapshotFileName(spec.kind))); }
    io.rename(tmp, target);
    try { const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* directory fsync is best effort */ }
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    if (e instanceof SnapshotError) throw e;
    throw new SnapshotError("SNAPSHOT_WRITE_FAILED", "the snapshot could not be written; the existing snapshot is unchanged");
  }
  return { kind: spec.kind, file: snapshotFileName(spec.kind), replaced: exists, bytes, sha256: createHash("sha256").update(text).digest("hex"), asOf };
}
