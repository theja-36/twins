/**
 * Scorecard metrics (Stage 4 / Task 3): PURE and deterministic. Inputs are per-message facts derived from imported records and their evaluated outcome labels; nothing here reads a
 * database, a clock or message text. Terminology is neutral on purpose (REVISION_ACTIVITY, EVIDENCE_CONFLICT): the numbers describe evidence, never intent.
 *
 * Fixed R model: WIN_T1 +1R, WIN_T2 +2R, WIN_T3 +3R, LOSS_SL -1R, NO_ENTRY / EXPIRED_NO_ENTRY 0R, EXPIRED_AFTER_ENTRY 0R. UNVERIFIABLE and INVALID_SIGNAL carry no R and are excluded from
 * "evaluable" (they are counted and rated separately). Rates are over ALL evaluated (labelled) signals unless the name says otherwise; `...Entered` rates are over entered trades.
 */
export const SCORECARD_ALGORITHM_VERSION = "source-scorecard-v1";
export const R_MODEL = { WIN_T1: 1, WIN_T2: 2, WIN_T3: 3, LOSS_SL: -1, NO_ENTRY: 0, EXPIRED_NO_ENTRY: 0, EXPIRED_AFTER_ENTRY: 0 } as const;
const DAY = 86_400_000;

export interface ScoredSignal {
  /** channel + message id: one entry per original message (revisions are folded into the fields below). */
  key: string;
  /** Time of the original message. */
  at: Date;
  /** The normalized record is a signal / options claim. */
  isSignal: boolean;
  /** When the label's outcome became knowable (first touch of the hit target / stop, or the end of the observation window). Absent (older callers): no resolution-time rule; null: unknown, so a labelled outcome is not used for any as-of. */
  resolvedAt?: Date | null;
  /** The label's final outcome, or null when the signal has not been evaluated. */
  outcome: string | null;
  /** Target k hit before the stop-loss (from the label). */
  targetHits: [boolean, boolean, boolean];
  dataQuality: string | null;
  slPresent: boolean;
  slValid: boolean;
  revisions: number;
  adverseSlRevision: boolean;
  evidenceConflict: boolean;
}
export interface MetricConfig { costPerTradeR: number }

export interface Metrics {
  importedMessages: number; normalizedSignals: number; totalEvaluated: number; evaluable: number; entered: number; unverifiable: number; invalid: number;
  wins: number; losses: number; noEntry: number; expiredAfterEntry: number; winsT1: number; winsT2: number; winsT3: number;
  winRate: number | null; lossRate: number | null; noEntryRate: number | null; expiredAfterEntryRate: number | null; unverifiableRate: number | null; invalidRate: number | null;
  winRateEntered: number | null; slHitRate: number | null; t1HitRate: number | null; t2HitRate: number | null; t3HitRate: number | null;
  grossExpectancyR: number | null; netExpectancyR: number | null; profitFactor: number | null; averageWinnerR: number | null; averageLoserR: number | null;
  maxConsecutiveLosses: number; maxDrawdownR: number; totalR: number;
  entryReachabilityRate: number | null; slDisciplineRate: number | null; revisionFrequency: number | null; editedMessageRate: number | null; deleteRate: null; lateSignalRate: null;
  adverseSlRevisionCount: number; evidenceConflictCount: number; revisionConflictRate: number | null; hindsightSuspicionScore: number | null;
  dataQualityScore: number | null; evaluationCoverageScore: number | null;
}
export interface Caveat { code: string; detail?: string }

const rate = (n: number, d: number): number | null => (d === 0 ? null : round(n / d));
/** Fixed 6-decimal rounding keeps stored snapshots byte-stable. */
export const round = (x: number): number => Math.round(x * 1e6) / 1e6;

const byTime = (a: ScoredSignal, b: ScoredSignal): number => a.at.getTime() - b.at.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function computeMetrics(input: ScoredSignal[], cfg: MetricConfig): Metrics {
  const all = [...input].sort(byTime);
  const signals = all.filter((s) => s.isSignal);
  const labelled = signals.filter((s) => s.outcome !== null);
  const count = (o: string[]): number => labelled.filter((s) => o.includes(s.outcome as string)).length;
  const definite = labelled.filter((s) => (s.outcome as string) in R_MODEL);
  const entered = definite.filter((s) => ["WIN_T1", "WIN_T2", "WIN_T3", "LOSS_SL", "EXPIRED_AFTER_ENTRY"].includes(s.outcome as string));
  const winsT1 = count(["WIN_T1"]), winsT2 = count(["WIN_T2"]), winsT3 = count(["WIN_T3"]);
  const wins = winsT1 + winsT2 + winsT3, losses = count(["LOSS_SL"]);
  const noEntry = count(["NO_ENTRY", "EXPIRED_NO_ENTRY"]), expired = count(["EXPIRED_AFTER_ENTRY"]);
  const unverifiable = count(["UNVERIFIABLE"]), invalid = count(["INVALID_SIGNAL"]);
  const rOf = (s: ScoredSignal): number => R_MODEL[s.outcome as keyof typeof R_MODEL];
  const totalR = definite.reduce((a, s) => a + rOf(s), 0);
  const winnersR = entered.filter((s) => rOf(s) > 0).reduce((a, s) => a + rOf(s), 0);
  const losersR = entered.filter((s) => rOf(s) < 0).reduce((a, s) => a + rOf(s), 0);
  let streak = 0, maxStreak = 0, cum = 0, peak = 0, maxDd = 0;
  for (const s of entered) { // time order
    const r = rOf(s);
    streak = s.outcome === "LOSS_SL" ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const hit = (k: 0 | 1 | 2): number => entered.filter((s) => s.targetHits[k]).length;
  const withQuality = labelled.filter((s) => s.dataQuality !== null && s.dataQuality !== "NOT_APPLICABLE");
  const qualityPoints = withQuality.reduce((a, s) => a + (s.dataQuality === "GOOD" ? 1 : s.dataQuality === "DEGRADED" ? 0.5 : 0), 0);
  const revised = signals.filter((s) => s.revisions > 0).length;
  const conflicted = signals.filter((s) => s.adverseSlRevision || s.evidenceConflict).length;
  const hindsight = signals.filter((s) => s.evidenceConflict).length;
  const ev = definite.length;
  return {
    importedMessages: all.length, normalizedSignals: signals.length, totalEvaluated: labelled.length, evaluable: ev, entered: entered.length, unverifiable, invalid,
    wins, losses, noEntry, expiredAfterEntry: expired, winsT1, winsT2, winsT3,
    winRate: rate(wins, labelled.length), lossRate: rate(losses, labelled.length), noEntryRate: rate(noEntry, labelled.length), expiredAfterEntryRate: rate(expired, labelled.length),
    unverifiableRate: rate(unverifiable, labelled.length), invalidRate: rate(invalid, labelled.length),
    winRateEntered: rate(wins, entered.length), slHitRate: rate(losses, entered.length), t1HitRate: rate(hit(0), entered.length), t2HitRate: rate(hit(1), entered.length), t3HitRate: rate(hit(2), entered.length),
    grossExpectancyR: ev === 0 ? null : round(totalR / ev), netExpectancyR: ev === 0 ? null : round((totalR - cfg.costPerTradeR * entered.length) / ev),
    profitFactor: losersR === 0 ? null : round(winnersR / Math.abs(losersR)),
    averageWinnerR: wins === 0 ? null : round(winnersR / wins), averageLoserR: losses === 0 ? null : round(losersR / losses),
    maxConsecutiveLosses: maxStreak, maxDrawdownR: round(maxDd), totalR: round(totalR),
    entryReachabilityRate: rate(entered.length, ev),
    slDisciplineRate: rate(signals.filter((s) => s.slPresent && s.slValid && !s.adverseSlRevision).length, signals.length),
    revisionFrequency: rate(signals.reduce((a, s) => a + s.revisions, 0), signals.length), editedMessageRate: rate(revised, signals.length),
    deleteRate: null, lateSignalRate: null,
    adverseSlRevisionCount: signals.filter((s) => s.adverseSlRevision).length, evidenceConflictCount: hindsight,
    revisionConflictRate: rate(conflicted, signals.length), hindsightSuspicionScore: rate(hindsight, signals.length),
    dataQualityScore: withQuality.length === 0 ? null : round(qualityPoints / withQuality.length), evaluationCoverageScore: rate(labelled.length, signals.length),
  };
}

export function caveatsFor(m: Metrics): Caveat[] {
  const c: Caveat[] = [{ code: "LATE_SIGNAL_RATE_NOT_MEASURABLE" }, { code: "DELETIONS_NOT_MEASURED" }];
  if (m.evaluable < 30) c.push({ code: "SMALL_SAMPLE", detail: String(m.evaluable) });
  if (m.unverifiableRate !== null && m.unverifiableRate > 0.35) c.push({ code: "HIGH_UNVERIFIABLE_SHARE" });
  if (m.evaluationCoverageScore !== null && m.evaluationCoverageScore < 0.8) c.push({ code: "PARTIAL_EVALUATION_COVERAGE" });
  if (m.dataQualityScore !== null && m.dataQualityScore < 0.8) c.push({ code: "DEGRADED_DATA" });
  if (m.profitFactor === null && m.evaluable > 0) c.push({ code: "PROFIT_FACTOR_UNDEFINED_NO_LOSSES" });
  if (m.evaluable === 0) c.push({ code: "NO_EVALUABLE_OUTCOMES" });
  return c;
}

export const WINDOW_TYPES = ["ALL_TIME", "LAST_30D", "LAST_90D", "LAST_180D", "LAST_365D", "CALENDAR_MONTH"] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];
export interface WindowCard { windowType: WindowType; windowStart: Date; windowEnd: Date; sampleSize: number; metrics: Metrics; caveats: Caveat[] }
const EPOCH = new Date(0);

/** All-time, trailing and calendar-month windows over messages sent up to `asOf` (a message after the as-of instant is unknowable and ignored). No market-regime windows exist yet. */
export function computeWindows(input: ScoredSignal[], asOf: Date, cfg: MetricConfig, opts: { pointInTimeOutcomes?: boolean } = {}): WindowCard[] {
  // A message after the as-of instant is unknowable and ignored. With `pointInTimeOutcomes`, an outcome that resolves AFTER the as-of instant (or whose resolution time is unknown) was not known then, so the signal counts as not yet evaluated. Off by default: see gap G-39 (the stored tiers still count such outcomes).
  const known = input.filter((s) => s.at.getTime() <= asOf.getTime()).map((s): ScoredSignal => (!opts.pointInTimeOutcomes || s.resolvedAt === undefined || s.outcome === null || (s.resolvedAt !== null && s.resolvedAt.getTime() <= asOf.getTime()) ? s : { ...s, outcome: null, targetHits: [false, false, false], dataQuality: null }));
  const card = (windowType: WindowType, windowStart: Date, windowEnd: Date, set: ScoredSignal[]): WindowCard => {
    const metrics = computeMetrics(set, cfg);
    return { windowType, windowStart, windowEnd, sampleSize: metrics.evaluable, metrics, caveats: caveatsFor(metrics) };
  };
  const out: WindowCard[] = [card("ALL_TIME", EPOCH, asOf, known)];
  for (const [t, days] of [["LAST_30D", 30], ["LAST_90D", 90], ["LAST_180D", 180], ["LAST_365D", 365]] as const) {
    const start = new Date(asOf.getTime() - days * DAY);
    out.push(card(t, start, asOf, known.filter((s) => s.at.getTime() > start.getTime())));
  }
  const months = new Map<string, ScoredSignal[]>();
  for (const s of known) { const k = s.at.toISOString().slice(0, 7); (months.get(k) ?? months.set(k, []).get(k) as ScoredSignal[]).push(s); }
  for (const k of [...months.keys()].sort()) {
    const start = new Date(`${k}-01T00:00:00Z`);
    const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    out.push(card("CALENDAR_MONTH", start, next.getTime() > asOf.getTime() ? asOf : next, months.get(k) as ScoredSignal[]));
  }
  return out;
}
