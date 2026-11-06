/**
 * News impact scoring (P1 #12), partial and offline. PURE: combines already-fetched news events (parsed fields only: ids, times, sentiment, relevance, reliability, symbol and theme codes; never headline or
 * body text) into one time-decayed, reliability-weighted impact for a target symbol. It depends on no live feed: with no events it answers UNKNOWN. Asymmetric by design: bad news can recommend CAUTION
 * or a review of new entries, but good news never recommends anything (news cannot increase risk). Events from the future, duplicates and unreliable sources are excluded and counted. Approves nothing.
 */
export const NEWS_IMPACT_VERSION = "news-impact-v1";
export interface NewsEvent { id: string; publishedAt: string; /** -1 (negative) to +1 (positive), or null when the source gave none. */ sentiment: number | null; /** 0..1, or null (treated as 0.5). */ relevance: number | null; /** 0..1 source reliability. */ reliability: number; symbols: string[]; themes: string[] }
export interface NewsImpactPolicy { halfLifeMinutes: number; staleMinutes: number; minItems: number; minReliability: number; spikeMultiple: number; conflictSpread: number; cautionImpact: number; cautionConfidence: number }
export const DEFAULT_NEWS_POLICY: NewsImpactPolicy = { halfLifeMinutes: 90, staleMinutes: 1440, minItems: 3, minReliability: 0.3, spikeMultiple: 3, conflictSpread: 0.8, cautionImpact: -0.4, cautionConfidence: 0.4 };
export type NewsFlag = "THIN" | "STALE" | "CONFLICTING" | "SPIKE" | "NO_SENTIMENT" | "FUTURE_EVENTS_IGNORED" | "UNRELIABLE_IGNORED";
export interface NewsImpact {
  version: typeof NEWS_IMPACT_VERSION; direction: "NEGATIVE" | "POSITIVE" | "MIXED" | "NONE" | "UNKNOWN"; impact: number | null; confidence: number; matched: number; used: number;
  freshestAgeMinutes: number | null; flags: NewsFlag[]; recommendation: "NONE" | "CAUTION" | "REVIEW_NEW_ENTRIES"; grantsApproval: false;
}
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const unit = (x: number | null): boolean => x === null || (Number.isFinite(x) && x >= 0 && x <= 1);

export function assessNewsImpact(events: readonly NewsEvent[], target: { symbol: string; themes?: readonly string[] }, now: Date, policy: NewsImpactPolicy = DEFAULT_NEWS_POLICY): NewsImpact {
  const p = policy, t0 = now.getTime();
  if (!(p.halfLifeMinutes > 0 && p.staleMinutes > 0 && p.minItems >= 1 && p.spikeMultiple > 1)) throw new Error("invalid news policy");
  const themes = new Set(target.themes ?? []);
  const flags = new Set<NewsFlag>();
  const seen = new Set<string>();
  const matched: Array<{ e: NewsEvent; ageMin: number; direct: boolean }> = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const t = Date.parse(e.publishedAt);
    if (Number.isNaN(t) || !unit(e.relevance) || !(Number.isFinite(e.reliability) && e.reliability >= 0 && e.reliability <= 1) || (e.sentiment !== null && !(Number.isFinite(e.sentiment) && Math.abs(e.sentiment) <= 1))) continue;
    if (t > t0 + 60_000) { flags.add("FUTURE_EVENTS_IGNORED"); continue; }
    const direct = e.symbols.includes(target.symbol), theme = e.themes.some((x) => themes.has(x));
    if (!direct && !theme) continue;
    matched.push({ e, ageMin: Math.max(0, (t0 - t) / 60_000), direct });
  }
  const reliable = matched.filter((m) => m.e.reliability >= p.minReliability);
  if (reliable.length < matched.length) flags.add("UNRELIABLE_IGNORED");
  const fresh = reliable.filter((m) => m.ageMin <= p.staleMinutes);
  if (matched.length > 0 && fresh.length === 0) flags.add("STALE");
  const scored = fresh.filter((m) => m.e.sentiment !== null);
  if (fresh.length > scored.length) flags.add("NO_SENTIMENT");
  const freshest = fresh.length ? Math.min(...fresh.map((m) => m.ageMin)) : null;
  const out = (direction: NewsImpact["direction"], impact: number | null, confidence: number, rec: NewsImpact["recommendation"]): NewsImpact => ({ version: NEWS_IMPACT_VERSION, direction, impact, confidence, matched: matched.length, used: scored.length, freshestAgeMinutes: freshest === null ? null : r4(freshest), flags: [...flags].sort(), recommendation: rec, grantsApproval: false });
  if (scored.length === 0) return out(matched.length === 0 ? "UNKNOWN" : "NONE", null, 0, "NONE");

  const w = (m: { e: NewsEvent; ageMin: number; direct: boolean }): number => (m.e.relevance ?? 0.5) * m.e.reliability * 0.5 ** (m.ageMin / p.halfLifeMinutes) * (m.direct ? 1 : 0.5);
  const sw = scored.reduce((a, m) => a + w(m), 0);
  if (sw === 0) return out("NONE", null, 0, "NONE");
  const impact = r4(scored.reduce((a, m) => a + w(m) * (m.e.sentiment as number), 0) / sw);
  const sents = scored.map((m) => m.e.sentiment as number);
  if (scored.length >= 2 && Math.max(...sents) - Math.min(...sents) >= p.conflictSpread && Math.min(...sents) < 0 && Math.max(...sents) > 0) flags.add("CONFLICTING");
  if (scored.length < p.minItems) flags.add("THIN");
  const meanRel = scored.reduce((a, m) => a + m.e.reliability, 0) / scored.length;
  const confidence = r4(Math.min(1, scored.length / (p.minItems * 2)) * meanRel);
  const lastHour = scored.filter((m) => m.ageMin <= 60).length, prior = scored.filter((m) => m.ageMin > 60 && m.ageMin <= 1440).length / 23;
  if (lastHour >= 3 && lastHour >= p.spikeMultiple * Math.max(1, prior)) flags.add("SPIKE");
  const direction: NewsImpact["direction"] = flags.has("CONFLICTING") ? "MIXED" : impact <= -0.1 ? "NEGATIVE" : impact >= 0.1 ? "POSITIVE" : "NONE";
  let rec: NewsImpact["recommendation"] = "NONE";
  if (impact <= p.cautionImpact && confidence >= p.cautionConfidence) rec = flags.has("SPIKE") ? "REVIEW_NEW_ENTRIES" : "CAUTION";
  else if (flags.has("SPIKE") && impact < 0) rec = "CAUTION";
  return out(direction, impact, confidence, rec);
}
