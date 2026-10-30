import { AgentContractError } from "../contract";
import { isoInstant, readJsonFile } from "./newsProviders";

/**
 * Historical providers (Stage 5 / Task 7): the INJECTABLE interfaces the Historical Pattern Agent uses. No database or external API is read by the agent; the shipped implementations are in-memory
 * (tests) and file-based over a pre-exported snapshot of the pattern library (Stage 4 / Task 4). A provider never invents data: a pattern it does not know is absent, a failure throws, an unknown
 * field is `null`. Everything here is historical ASSOCIATION evidence: no causal claim, no prediction.
 */
export type EvidenceStatus = "SUFFICIENT" | "INSUFFICIENT_EVIDENCE" | "LOW_QUALITY_EVIDENCE";
export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = ["SUFFICIENT", "INSUFFICIENT_EVIDENCE", "LOW_QUALITY_EVIDENCE"];
export const REGIME_TAGS: readonly string[] = ["TRENDING", "RANGE"];
export const VOLATILITY_TAGS: readonly string[] = ["LOW", "NORMAL", "HIGH"];
/** One pattern of the library that matches the signal (exact key match; L1 broadest .. L4 most specific). */
export interface PatternMatch {
  keyText: string; level: number; status: EvidenceStatus; sampleSize: number;
  /** When the library run that produced this pattern was computed (ISO). */
  asOf: string; firstObserved: string | null; lastObserved: string | null;
  /** Share of the pattern's historical samples per market regime / volatility bucket (each sums to 1), or null when not recorded. */
  regimeMix: Record<string, number> | null; volatilityMix: Record<string, number> | null;
}
export interface HistoricalPatternProvider {
  readonly name: string;
  /** Library snapshot time (ISO), or null. */
  readonly asOf: string | null;
  /** The patterns for the given exact keys (those the library does not know are simply absent). */
  patterns(q: { keys: string[] }): Promise<PatternMatch[]>;
}
/** Evaluated outcome distribution of a pattern's training signals. Rates and expectancy are per the Stage 4 pattern metrics (R multiples, net of the configured cost). */
export interface OutcomeDistribution {
  keyText: string; evaluable: number; entered: number; wins: number; losses: number; noEntry: number; expiredAfterEntry: number; unverifiable: number;
  netExpectancyR: number | null; netExpectancyLowerBoundR: number | null; averageWinnerR: number | null; averageLoserR: number | null; asOf: string;
}
export interface HistoricalOutcomeProvider {
  readonly name: string;
  outcomes(q: { keyText: string }): Promise<OutcomeDistribution | null>;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cnt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1e9;
const r = (v: unknown): boolean => v === null || (fin(v) && Math.abs(v) <= 100);
const dateOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
const bad = (kind: string, what: string): never => { throw new AgentContractError("INVALID_HISTORICAL_DATA", `${kind}: ${what}`); };
const KEY = /^L[1-4]\|[A-Za-z0-9_|=.&-]{1,300}$/;

function mixProblem(m: unknown, tags: readonly string[]): boolean {
  if (m === null) return false;
  if (typeof m !== "object" || Array.isArray(m)) return true;
  const e = Object.entries(m as Record<string, unknown>);
  if (e.length === 0 || e.some(([k, v]) => !tags.includes(k) || !fin(v) || v < 0 || v > 1)) return true;
  return Math.abs(e.reduce((a, [, v]) => a + (v as number), 0) - 1) > 0.01;
}
/** First structural problem of a pattern match (also used by the agent on whatever a provider returns), or null. */
export function patternProblem(p: unknown): string | null {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "not an object";
  const o = p as Record<string, unknown>;
  if (typeof o["keyText"] !== "string" || !KEY.test(o["keyText"]) || !Number.isInteger(o["level"]) || (o["level"] as number) < 1 || (o["level"] as number) > 4 || !o["keyText"].startsWith(`L${o["level"]}|`)) return "key";
  if (!EVIDENCE_STATUSES.includes(o["status"] as EvidenceStatus) || !cnt(o["sampleSize"])) return "status / sample";
  if (typeof o["asOf"] !== "string" || Number.isNaN(Date.parse(o["asOf"])) || !dateOrNull(o["firstObserved"]) || !dateOrNull(o["lastObserved"])) return "dates";
  if (mixProblem(o["regimeMix"], REGIME_TAGS) || mixProblem(o["volatilityMix"], VOLATILITY_TAGS)) return "mix";
  return null;
}
export function outcomeProblem(x: unknown): string | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "not an object";
  const o = x as Record<string, unknown>;
  if (typeof o["keyText"] !== "string" || !KEY.test(o["keyText"])) return "key";
  for (const k of ["evaluable", "entered", "wins", "losses", "noEntry", "expiredAfterEntry", "unverifiable"]) if (!cnt(o[k])) return "count";
  if ((o["wins"] as number) + (o["losses"] as number) + (o["expiredAfterEntry"] as number) !== o["entered"] || (o["entered"] as number) + (o["noEntry"] as number) > (o["evaluable"] as number)) return "count consistency";
  if (!r(o["netExpectancyR"]) || !r(o["netExpectancyLowerBoundR"]) || !r(o["averageWinnerR"]) || !r(o["averageLoserR"])) return "expectancy";
  if (typeof o["asOf"] !== "string" || Number.isNaN(Date.parse(o["asOf"]))) return "as_of";
  return null;
}

export function memoryPatternProvider(o: { name?: string; asOf?: string | null; patterns: unknown[] }): HistoricalPatternProvider {
  // malformed entries are passed through unfiltered so the agent can see (and reject) them
  return { name: o.name ?? "memory-patterns", asOf: o.asOf === undefined ? null : o.asOf, async patterns(q) { return (o.patterns as PatternMatch[]).filter((p) => typeof p?.keyText !== "string" || q.keys.includes(p.keyText)); } };
}
export function memoryOutcomeProvider(o: { name?: string; outcomes: Record<string, unknown> }): HistoricalOutcomeProvider {
  return { name: o.name ?? "memory-outcomes", async outcomes(q) { return (o.outcomes[q.keyText] as OutcomeDistribution | undefined) ?? null; } };
}

export const HISTORICAL_PATTERNS_FORMAT = "twins-historical-patterns-v1";
export const HISTORICAL_OUTCOMES_FORMAT = "twins-historical-outcomes-v1";
const srcName = (x: Record<string, unknown>): string => (typeof x["source"] === "string" && x["source"].length <= 60 ? `file:${x["source"].replace(/[^A-Za-z0-9._-]/g, "_")}` : "file");
const head = (raw: unknown, kind: string, format: string, field: string): { r: Record<string, unknown>; asOf: string; entries: Array<[string, Record<string, unknown>]> } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(kind, "not an object");
  const x = raw as Record<string, unknown>;
  if (x["format"] !== format) bad(kind, "unsupported format");
  const asOf = isoInstant(x["as_of"]) ?? bad(kind, "as_of must be an ISO instant with an offset");
  const src = x[field];
  if (typeof src !== "object" || src === null || Array.isArray(src) || Object.keys(src).length === 0 || Object.keys(src).length > 100_000) return bad(kind, `${field} must be an object`);
  return { r: x, asOf, entries: Object.entries(src as Record<string, Record<string, unknown>>).map(([k, v]) => { if (!KEY.test(k) || !v || typeof v !== "object" || Array.isArray(v)) bad(kind, `key ${k.slice(0, 50)}`); return [k, v] as [string, Record<string, unknown>]; }) };
};
const optIso = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : isoInstant(v) ?? undefined);
/**
 * `twins-historical-patterns-v1` (JSON): { "format", "source", "as_of", "patterns": { "L2|market=NSE|instrumentType=EQUITY|side=BUY|underlying=ACME": { "level": 2, "status": "SUFFICIENT", "sample_size": 120,
 *   "as_of": "<ISO>", "first_observed": "<ISO>", "last_observed": "<ISO>", "regime_mix": { "TRENDING": 0.6, "RANGE": 0.4 }, "volatility_mix": { "LOW": 0.2, "NORMAL": 0.6, "HIGH": 0.2 } } } }
 * Strict: bad keys, statuses, counts, dates and mixes (each must sum to 1) are rejected at load; nothing is repaired.
 */
export function parsePatternsFile(raw: unknown): HistoricalPatternProvider {
  const k = "historical patterns file";
  const { r: x, asOf, entries } = head(raw, k, HISTORICAL_PATTERNS_FORMAT, "patterns");
  const patterns = entries.map(([key, o]) => {
    const first = optIso(o["first_observed"]), last = optIso(o["last_observed"]), pAsOf = isoInstant(o["as_of"]);
    const p: PatternMatch = { keyText: key, level: o["level"] as number, status: o["status"] as EvidenceStatus, sampleSize: o["sample_size"] as number, asOf: pAsOf ?? "", firstObserved: first ?? null, lastObserved: last ?? null,
      regimeMix: (o["regime_mix"] ?? null) as Record<string, number> | null, volatilityMix: (o["volatility_mix"] ?? null) as Record<string, number> | null };
    if (first === undefined || last === undefined || pAsOf === null || patternProblem(p) !== null) bad(k, `pattern ${key}`);
    return p;
  });
  return memoryPatternProvider({ name: srcName(x), asOf, patterns });
}
/** `twins-historical-outcomes-v1` (JSON): { "format", "source", "as_of", "outcomes": { "<key>": { "evaluable", "entered", "wins", "losses", "no_entry", "expired_after_entry", "unverifiable", "net_expectancy_r", "net_expectancy_lower_bound_r", "average_winner_r", "average_loser_r", "as_of" } } } */
export function parseOutcomesFile(raw: unknown): HistoricalOutcomeProvider {
  const k = "historical outcomes file";
  const { r: x, entries } = head(raw, k, HISTORICAL_OUTCOMES_FORMAT, "outcomes");
  const n = (v: unknown): number | null => (v === undefined || v === null ? null : (v as number));
  const outcomes: Record<string, OutcomeDistribution> = {};
  for (const [key, o] of entries) {
    const oAsOf = isoInstant(o["as_of"]);
    const d: OutcomeDistribution = { keyText: key, evaluable: o["evaluable"] as number, entered: o["entered"] as number, wins: o["wins"] as number, losses: o["losses"] as number, noEntry: o["no_entry"] as number, expiredAfterEntry: o["expired_after_entry"] as number,
      unverifiable: o["unverifiable"] as number, netExpectancyR: n(o["net_expectancy_r"]), netExpectancyLowerBoundR: n(o["net_expectancy_lower_bound_r"]), averageWinnerR: n(o["average_winner_r"]), averageLoserR: n(o["average_loser_r"]), asOf: oAsOf ?? "" };
    if (oAsOf === null || outcomeProblem(d) !== null) bad(k, `outcome ${key}`);
    outcomes[key] = d;
  }
  return memoryOutcomeProvider({ name: srcName(x), outcomes });
}
export const filePatternProvider = (path: string): HistoricalPatternProvider => parsePatternsFile(readJsonFile(path, "the historical patterns file"));
export const fileOutcomeProvider = (path: string): HistoricalOutcomeProvider => parseOutcomesFile(readJsonFile(path, "the historical outcomes file"));
