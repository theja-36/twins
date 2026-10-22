/**
 * GDELT DOC-style article-list adapter (OFFLINE-first). A pure parser plus a NewsProvider whose transport is INJECTED:
 * there is no default transport, so constructing this adapter can never reach the network by itself. It is not
 * registered in `newsProviders` and no worker enables it.
 *
 * What GDELT items are here: aggregation/discovery metadata (tier D). They are untrusted external text, not trading
 * evidence, not a verified economic-events calendar, and carry no sentiment, probability or recommendation. Article pages
 * are never fetched; URLs are only syntax-checked.
 *
 * Timestamps: the only timestamp GDELT supplies is `seendate`. Its semantics (when GDELT first saw the article) are NOT
 * established as the publisher's publication time, so it is never presented as one. The existing NormalizedNewsItem
 * requires a `sourceTimestamp`; it is filled from `seendate` and the payload records `timestampField: "seendate"` with
 * `publishedAtVerified: false`. `retrievedAt` is the actual time this process obtained the response.
 *
 * The record hash covers the preserved metadata fields only; it is NOT a hash of any article body.
 */
import { createHash } from "node:crypto";
import {
  ProviderDataError,
  ProviderError,
  ProviderUnavailableError,
  type NewsFetchParams,
  type NewsProvider,
  type NormalizedNewsItem,
  type ProviderHealthSnapshot,
} from "@twins/types";

export const GDELT_PROVIDER_NAME = "gdelt-doc";
export const GDELT_PARSER_VERSION = "gdelt-doc-parser-v1";
export const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
export const DEFAULT_MAX_ITEMS = 250;
const MAX_URL = 2048, MAX_TITLE = 1000, MAX_FIELD = 128;

export type GdeltStatus = "ok" | "empty" | "partial" | "failed";
export type GdeltRejectReason =
  | "not_an_object" | "url_missing" | "url_invalid" | "url_too_long" | "url_credentials" | "title_missing" | "title_too_long" | "title_control_characters"
  | "seendate_missing" | "seendate_invalid" | "optional_field_invalid_type" | "before_since" | "duplicate_url";

export interface GdeltParseReport {
  status: GdeltStatus;
  parserVersion: string;
  articlesSeen: number;
  accepted: number;
  rejected: Partial<Record<GdeltRejectReason, number>>;
  truncatedByItemCap: number;
  failure?: string;
  notes: string[];
}

export interface GdeltParseOptions {
  retrievedAt: Date;
  query: string;
  since?: Date | undefined;
  maxResponseBytes?: number;
  maxItems?: number;
}

/** Strict GDELT seendate: YYYYMMDDTHHMMSSZ (UTC). Anything else is rejected, never guessed. */
export function parseGdeltSeendate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && dt.getUTCHours() === h ? dt : null;
}

function validUrl(u: string): GdeltRejectReason | null {
  if (u.length > MAX_URL) return "url_too_long";
  let p: URL;
  try { p = new URL(u); } catch { return "url_invalid"; }
  if (p.protocol !== "http:" && p.protocol !== "https:") return "url_invalid";
  if (p.username || p.password) return "url_credentials";
  return null;
}

const canonical = (o: Record<string, string | null>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Pure: response text -> normalized items + an honest report. Never throws for bad content. */
export function parseGdeltArticleList(bodyText: string, opts: GdeltParseOptions): { items: NormalizedNewsItem[]; report: GdeltParseReport } {
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const report: GdeltParseReport = { status: "failed", parserVersion: GDELT_PARSER_VERSION, articlesSeen: 0, accepted: 0, rejected: {}, truncatedByItemCap: 0, notes: [] };
  const fail = (why: string) => { report.failure = why; return { items: [], report }; };
  if (Buffer.byteLength(bodyText, "utf8") > maxBytes) return fail(`response exceeds the ${maxBytes}-byte bound; not parsed`);
  let json: unknown;
  try { json = JSON.parse(bodyText); } catch { return fail("response is not valid JSON"); }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return fail("response is not a JSON object");
  const articles = (json as Record<string, unknown>)["articles"];
  if (!Array.isArray(articles)) return fail('response has no "articles" array; this is NOT treated as a valid empty result (provider no-result behaviour is unverified)');
  report.articlesSeen = articles.length;
  const bump = (r: GdeltRejectReason) => { report.rejected[r] = (report.rejected[r] ?? 0) + 1; };
  const items: NormalizedNewsItem[] = [];
  const seenUrls = new Set<string>();
  for (const a of articles) {
    if (items.length >= maxItems) { report.truncatedByItemCap += 1; continue; }
    if (typeof a !== "object" || a === null || Array.isArray(a)) { bump("not_an_object"); continue; }
    const r = a as Record<string, unknown>;
    if (typeof r["url"] !== "string" || r["url"].trim() === "") { bump("url_missing"); continue; }
    const url = r["url"].trim();
    const urlProblem = validUrl(url);
    if (urlProblem) { bump(urlProblem); continue; }
    if (typeof r["title"] !== "string" || r["title"].trim() === "") { bump("title_missing"); continue; }
    const title = r["title"].trim();
    if (title.length > MAX_TITLE) { bump("title_too_long"); continue; }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(title)) { bump("title_control_characters"); continue; }
    if (r["seendate"] === undefined || r["seendate"] === null || r["seendate"] === "") { bump("seendate_missing"); continue; }
    const seen = parseGdeltSeendate(r["seendate"]);
    if (!seen) { bump("seendate_invalid"); continue; }
    const opt = (k: string): string | null | "bad" => {
      const v = r[k];
      if (v === undefined || v === null || v === "") return null;
      return typeof v === "string" && v.length <= MAX_FIELD ? v : "bad";
    };
    const domain = opt("domain"), language = opt("language"), country = opt("sourcecountry");
    if (domain === "bad" || language === "bad" || country === "bad") { bump("optional_field_invalid_type"); continue; }
    if (opts.since && seen.getTime() < opts.since.getTime()) { bump("before_since"); continue; }
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seenUrls.has(key)) { bump("duplicate_url"); continue; }
    seenUrls.add(key);
    const recordHash = createHash("sha256").update(canonical({ url, title, domain, language, sourcecountry: country, seendate: r["seendate"] as string })).digest("hex");
    items.push({
      sourceName: GDELT_PROVIDER_NAME,
      sourceTier: "D",
      sourceUrl: url,
      headline: title,
      sourceTimestamp: seen,
      rawPayload: {
        provider: GDELT_PROVIDER_NAME,
        parserVersion: GDELT_PARSER_VERSION,
        query: opts.query,
        retrievedAt: opts.retrievedAt.toISOString(),
        timestampField: "seendate",
        timestampRaw: r["seendate"],
        timestampSemantics: "provider-first-seen time; NOT established as the publisher's publication time",
        publishedAtVerified: false,
        domain, language, sourceCountry: country,
        recordHash, hashScope: "normalized metadata fields only; not an article-body hash",
        evidenceRole: "aggregation/discovery context only (tier D); not trading evidence by itself",
      },
    });
  }
  report.accepted = items.length;
  const rejectedTotal = Object.values(report.rejected).reduce((s, n) => s + (n ?? 0), 0);
  if (articles.length === 0) report.status = "empty";
  else if (items.length === 0) { report.status = "failed"; report.failure = "every article in the response was rejected"; }
  else report.status = rejectedTotal > 0 || report.truncatedByItemCap > 0 ? "partial" : "ok";
  report.notes.push("headlines and URLs are untrusted data; no article page was fetched");
  return { items, report };
}

export interface GdeltTransportRequest { query: string; since?: Date | undefined; maxRecords: number }
export interface GdeltTransportResponse { status: number; bodyText: string }
export type GdeltTransport = (request: GdeltTransportRequest) => Promise<GdeltTransportResponse>;

export interface GdeltAdapterOptions {
  /** REQUIRED. There is deliberately no default transport. */
  transport: GdeltTransport;
  /** The explicit search expression sent to the transport. Never derived from instrument symbols. */
  query: string;
  maxResponseBytes?: number;
  maxItems?: number;
  now?: () => Date;
}

export class GdeltNewsAdapter implements NewsProvider {
  readonly providerName = GDELT_PROVIDER_NAME;
  readonly sourceTier = "D" as const;
  private lastOutcome: { at: Date; ok: boolean; message?: string } | undefined;
  constructor(private readonly options: GdeltAdapterOptions) {
    if (!options.query.trim()) throw new Error("GdeltNewsAdapter: an explicit query is required");
  }

  /** The full result, including the honest parse report. Transport failures throw typed provider errors; a failed parse is reported, and fetchLatest turns it into an error. */
  async fetchWithReport(params: NewsFetchParams = {}): Promise<{ items: NormalizedNewsItem[]; report: GdeltParseReport; retrievedAt: Date }> {
    const now = this.options.now ?? (() => new Date());
    const maxItems = this.options.maxItems ?? DEFAULT_MAX_ITEMS;
    let res: GdeltTransportResponse;
    try {
      res = await this.options.transport({ query: this.options.query, since: params.since, maxRecords: maxItems });
    } catch (cause) {
      this.lastOutcome = { at: now(), ok: false, message: "transport failure" };
      if (cause instanceof ProviderError) throw cause; // keep the typed rate-limit / data / unavailable distinction
      throw new ProviderUnavailableError(GDELT_PROVIDER_NAME, `transport failure: ${cause instanceof Error ? cause.name : "unknown"}`, cause);
    }
    const retrievedAt = now();
    if (res.status === 429 || res.status < 200 || res.status >= 300) {
      this.lastOutcome = { at: retrievedAt, ok: false, message: `HTTP ${res.status}` };
      throw new ProviderUnavailableError(GDELT_PROVIDER_NAME, `HTTP ${res.status}`);
    }
    const parsed = parseGdeltArticleList(res.bodyText, { retrievedAt, query: this.options.query, since: params.since, maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, maxItems });
    this.lastOutcome = { at: retrievedAt, ok: parsed.report.status !== "failed", ...(parsed.report.failure ? { message: parsed.report.failure } : {}) };
    return { ...parsed, retrievedAt };
  }

  async fetchLatest(params: NewsFetchParams): Promise<NormalizedNewsItem[]> {
    const { items, report } = await this.fetchWithReport(params);
    if (report.status === "failed") throw new ProviderDataError(GDELT_PROVIDER_NAME, report.failure ?? "response failed validation");
    return items;
  }

  /** No live probe is ever made. Reports only the outcome of the last fetch this instance performed. */
  async getHealth(): Promise<ProviderHealthSnapshot> {
    const checkedAt = (this.options.now ?? (() => new Date()))();
    const o = this.lastOutcome;
    if (!o) return { providerName: GDELT_PROVIDER_NAME, providerType: "news", status: "degraded", lastErrorMessage: "no fetch has been performed; no live probe is made", checkedAt };
    return o.ok
      ? { providerName: GDELT_PROVIDER_NAME, providerType: "news", status: "healthy", lastSuccessAt: o.at, checkedAt }
      : { providerName: GDELT_PROVIDER_NAME, providerType: "news", status: "down", lastErrorAt: o.at, lastErrorMessage: o.message ?? "failed", checkedAt };
  }
}

