import { asKnownAt, type ScoredSignal } from "../scorecards/metrics";

/** The signals a pattern run may learn from: the embargo (default 30 days before as-of) and, for each, only what was known at as-of. */
export function selectTraining<T extends { at: Date; scored: ScoredSignal }>(samples: T[], asOf: Date, embargoDays: number): T[] {
  const cutoff = asOf.getTime() - embargoDays * 86_400_000;
  // the embargo keeps recent messages out; `asKnownAt` keeps outcomes that resolve after as-of out (the embargo alone does not: a label horizon can be longer than the embargo)
  return samples.filter((s) => s.at.getTime() <= cutoff).map((s) => ({ ...s, scored: asKnownAt(s.scored, asOf) }));
}
