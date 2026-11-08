import { wilsonInterval } from "../patterns/stats";
import { DEFAULT_SIMILARITY, SIMILARITY_DIMENSIONS, SIMILARITY_VERSION, type SimilarityDimension, type HistoricalCase, type Match, type OutcomeAggregate, type SimilarityConfig, type SimilarityResult, type SimilarityTarget } from "./types";

const known = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "" && !/^UNKNOWN/i.test(v.trim());
const norm = (v: string): string => v.trim().toUpperCase();
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

export function compareCase(target: SimilarityTarget, c: HistoricalCase, cfg: SimilarityConfig): Pick<Match, "similarity" | "coverage" | "matched" | "differing" | "unknown"> {
  const matched: SimilarityDimension[] = [], differing: SimilarityDimension[] = [], unknown: SimilarityDimension[] = [];
  let total = 0, comparable = 0, same = 0;
  for (const d of SIMILARITY_DIMENSIONS) {
    const w = cfg.weights[d]; total += w;
    const a = target.dimensions[d], b = c.dimensions[d];
    if (!known(a) || !known(b)) { unknown.push(d); continue; } // unknown is never a match
    comparable += w;
    if (norm(a) === norm(b)) { same += w; matched.push(d); } else differing.push(d);
  }
  return { similarity: comparable === 0 ? 0 : round(same / comparable), coverage: total === 0 ? 0 : round(comparable / total), matched, differing, unknown };
}

export function aggregateOutcomes(matches: readonly Match[], cfg: SimilarityConfig): OutcomeAggregate {
  const wins = matches.filter((m) => m.outcome === "WIN").length, losses = matches.filter((m) => m.outcome === "LOSS").length;
  const breakeven = matches.filter((m) => m.outcome === "BREAKEVEN").length, unresolved = matches.filter((m) => m.outcome === "UNRESOLVED").length;
  const resolved = wins + losses + breakeven;
  const rs = matches.filter((m) => m.outcome !== "UNRESOLVED" && m.rMultiple !== null && Number.isFinite(m.rMultiple)).map((m) => m.rMultiple as number);
  const status = matches.length === 0 ? "NO_COMPARABLE_CASES" : resolved < cfg.minResolved ? "INSUFFICIENT_EVIDENCE" : "SUFFICIENT";
  return {
    considered: matches.length, resolved, wins, losses, breakeven, unresolved,
    winRate: resolved > 0 ? round(wins / resolved) : null, winRateInterval: resolved > 0 ? wilsonInterval(wins, resolved, cfg.wilsonZ) : null,
    avgR: rs.length > 0 ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null, status,
  };
}

/**
 * Finds comparable past cases and summarises their outcomes. PURE and deterministic. Leakage control: cases observed at or after the target's time, and the target's own id, are excluded.
 * The aggregate is HISTORICAL ASSOCIATION, not a prediction: under the minimum resolved sample it says INSUFFICIENT_EVIDENCE and the caller must not treat the win rate as meaningful.
 */
export function matchSimilar(target: SimilarityTarget, cases: readonly HistoricalCase[], override: Partial<SimilarityConfig> = {}): SimilarityResult {
  const cfg: SimilarityConfig = { ...DEFAULT_SIMILARITY, ...override, weights: { ...DEFAULT_SIMILARITY.weights, ...(override.weights ?? {}) } };
  const excluded = { future: 0, sameId: 0, lowCoverage: 0, lowSimilarity: 0 };
  const temporal = { sameGroup: 0, duplicateRevision: 0, outcomeNotYetKnown: 0, unknownResolutionTime: 0 };
  // Only information available at the target's decision time may be used.
  const usable: HistoricalCase[] = [];
  for (const c of cases) {
    if (c.id === target.id) { excluded.sameId++; continue; }
    if (c.observedAt.getTime() >= target.at.getTime()) { excluded.future++; continue; }
    if (target.groupKey !== undefined && c.groupKey === target.groupKey) { temporal.sameGroup++; continue; } // an earlier revision of the target's own message is not a "past case"
    usable.push(c);
  }
  // Among several revisions of one past message only the LATEST revision seen before the target counts.
  const latest = new Map<string, HistoricalCase>();
  for (const c of usable) { if (c.groupKey === undefined) continue; const k = latest.get(c.groupKey); if (!k || c.observedAt.getTime() > k.observedAt.getTime() || (c.observedAt.getTime() === k.observedAt.getTime() && c.id > k.id)) latest.set(c.groupKey, c); }
  const matches: Match[] = [];
  for (const c0 of usable) {
    if (c0.groupKey !== undefined && latest.get(c0.groupKey) !== c0) { temporal.duplicateRevision++; continue; }
    let c = c0;
    if (c.outcome !== "UNRESOLVED") {
      if (c.resolvedAt && c.resolvedAt.getTime() >= target.at.getTime()) { temporal.outcomeNotYetKnown++; c = { ...c, outcome: "UNRESOLVED", rMultiple: null }; }          // the outcome was not known yet: unknown, not a win or a loss
      else if (!c.resolvedAt && cfg.requireResolvedAt) { temporal.unknownResolutionTime++; c = { ...c, outcome: "UNRESOLVED", rMultiple: null }; }                           // cannot prove it pre-dates the target
    }
    const r = compareCase(target, c, cfg);
    if (r.coverage < cfg.minCoverage) { excluded.lowCoverage++; continue; }
    if (r.similarity < cfg.minSimilarity) { excluded.lowSimilarity++; continue; }
    matches.push({ caseId: c.id, ...r, outcome: c.outcome, rMultiple: c.rMultiple, observedAt: c.observedAt });
  }
  matches.sort((a, b) => b.similarity - a.similarity || b.coverage - a.coverage || b.observedAt.getTime() - a.observedAt.getTime() || (a.caseId < b.caseId ? -1 : 1));
  const top = matches.slice(0, cfg.maxMatches);
  const aggregate = aggregateOutcomes(top, cfg);
  const notes: string[] = ["historical association only: not a prediction and not a probability of success"];
  if (aggregate.status === "INSUFFICIENT_EVIDENCE") notes.push(`only ${aggregate.resolved} resolved comparable case(s); at least ${cfg.minResolved} are needed before the rates mean anything`);
  if (aggregate.status === "NO_COMPARABLE_CASES") notes.push("no comparable past case: this is missing evidence, not a neutral or positive signal");
  if (temporal.outcomeNotYetKnown + temporal.unknownResolutionTime > 0) notes.push(`${temporal.outcomeNotYetKnown + temporal.unknownResolutionTime} comparable case(s) had no outcome known at the decision time and are counted as unresolved`);
  return { version: SIMILARITY_VERSION, target: target.id, matches: top, aggregate, excluded, temporal, notes };
}
