import type { OptionsPremiumProvider, PremiumLookup, PremiumQuery, PremiumQuote, PremiumSourceInfo } from "./premium";
import { SUPPORTED_UNDERLYINGS } from "./types";

/** Strictly validated, versioned, labelled SAMPLE premium data. No I/O here; the preview loads the file. */
export interface PremiumFileQuote extends PremiumQuote {
  underlying: string;
  strike: number;
  optionType: "CE" | "PE";
  expiryDate: string;
}

export interface PremiumFile {
  premiumVersion: string;
  sourceLabel: string;
  collectedAsOf: string;
  synthetic: true;
  liveMarketData: false;
  notLiveStatement: string;
  quotes: PremiumFileQuote[];
}

export class PremiumFileError extends Error {
  constructor(message: string) {
    super(`invalid options premium data: ${message}`);
    this.name = "PremiumFileError";
  }
}

const isCalendarDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function parsePremiumFile(raw: unknown): PremiumFile {
  if (typeof raw !== "object" || raw === null) throw new PremiumFileError("not an object");
  const o = raw as Record<string, unknown>;
  if (!str(o["premiumVersion"])) throw new PremiumFileError("premiumVersion is required");
  if (!str(o["sourceLabel"])) throw new PremiumFileError("sourceLabel is required");
  if (!isCalendarDate(o["collectedAsOf"])) throw new PremiumFileError("collectedAsOf must be an ISO date (YYYY-MM-DD)");
  if (o["synthetic"] !== true) throw new PremiumFileError("synthetic must be true: only labelled sample data is accepted here");
  if (o["liveMarketData"] !== false) throw new PremiumFileError("liveMarketData must be false");
  if (!str(o["notLiveStatement"]) || !/not live/i.test(o["notLiveStatement"])) throw new PremiumFileError('notLiveStatement is required and must say the data is "NOT live"');
  if (!Array.isArray(o["quotes"])) throw new PremiumFileError("quotes must be an array");
  const seen = new Set<string>();
  const quotes = o["quotes"].map((q: unknown, i): PremiumFileQuote => {
    const e = (typeof q === "object" && q !== null ? q : {}) as Record<string, unknown>;
    if (!SUPPORTED_UNDERLYINGS.includes(e["underlying"] as never)) throw new PremiumFileError(`quotes[${i}].underlying must be one of ${SUPPORTED_UNDERLYINGS.join(", ")}`);
    if (typeof e["strike"] !== "number" || !Number.isInteger(e["strike"]) || e["strike"] <= 0) throw new PremiumFileError(`quotes[${i}].strike must be a positive integer`);
    if (e["optionType"] !== "CE" && e["optionType"] !== "PE") throw new PremiumFileError(`quotes[${i}].optionType must be CE or PE`);
    if (!isCalendarDate(e["expiryDate"])) throw new PremiumFileError(`quotes[${i}].expiryDate must be an ISO calendar date`);
    const out: PremiumFileQuote = { underlying: e["underlying"] as string, strike: e["strike"], optionType: e["optionType"], expiryDate: e["expiryDate"] };
    for (const k of ["bid", "ask", "last"] as const) {
      if (e[k] === undefined) continue;
      if (!price(e[k])) throw new PremiumFileError(`quotes[${i}].${k} must be a non-negative number`);
      out[k] = e[k] as number;
    }
    if (out.bid === undefined && out.ask === undefined && out.last === undefined) throw new PremiumFileError(`quotes[${i}] needs at least one of bid, ask, last`);
    if (out.bid !== undefined && out.ask !== undefined && out.ask < out.bid) throw new PremiumFileError(`quotes[${i}].ask is below bid`);
    const key = `${out.underlying}|${out.strike}|${out.optionType}|${out.expiryDate}`;
    if (seen.has(key)) throw new PremiumFileError(`quotes[${i}] repeats an earlier contract identity`);
    seen.add(key);
    return out;
  });
  return {
    premiumVersion: o["premiumVersion"], sourceLabel: o["sourceLabel"], collectedAsOf: o["collectedAsOf"],
    synthetic: true, liveMarketData: false, notLiveStatement: o["notLiveStatement"], quotes,
  };
}

export function createSamplePremiumProvider(file: PremiumFile): OptionsPremiumProvider {
  const source: PremiumSourceInfo = { version: file.premiumVersion, source: file.sourceLabel, collectedAsOf: file.collectedAsOf, synthetic: true, notLiveStatement: file.notLiveStatement };
  return {
    name: `sample-premium:${file.premiumVersion}`,
    source,
    async lookup(q: PremiumQuery): Promise<PremiumLookup> {
      const hit = file.quotes.find((x) => x.underlying === q.underlying && x.strike === q.strike && x.optionType === q.optionType && x.expiryDate === q.expiryDate);
      if (!hit) return { status: "not_found" };
      const quote: PremiumQuote = {};
      if (hit.bid !== undefined) quote.bid = hit.bid;
      if (hit.ask !== undefined) quote.ask = hit.ask;
      if (hit.last !== undefined) quote.last = hit.last;
      return { status: "sample_quote", quote, source };
    },
  };
}
