/**
 * Classifier and parser evaluation harness (M02-15). Pure, deterministic functions that turn LABELLED data and PREDICTIONS into the report `docs/product/M02_15_DATASET_AND_ANNOTATION_SPEC.md` requires:
 * dataset validation, chronological-leakage checks, confusion matrix, precision / recall / F1, Wilson intervals, per-field wrong-value and invented-value rates, and inter-annotator agreement.
 * It holds no message text and no data: the labelled dataset lives OUTSIDE the repository. Tests use SYNTHETIC rows and prove the arithmetic and the guards, never any real accuracy.
 */
export const MESSAGE_CLASSES = ["claim", "ambiguous", "noise"] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];
export const SPLITS = ["train", "validation", "test"] as const;
export interface DatasetRow {
  datasetVersion: string; rowId: string; channelRef: string;
  /** ISO 8601 WITH an offset (e.g. +05:30): a bare local time is refused. */
  messageTimestamp: string; revisionOf: string | null;
  /** Near-duplicate / forward group: every member must sit in the same split. */
  dupGroup: string; split: (typeof SPLITS)[number];
  label: MessageClass; annotators: string[]; adjudicated: boolean; annotatorLabels: MessageClass[];
  /** Field labels for a claim: null = "unstated" (an explicit label, distinct from a missing one). */
  fields?: Record<string, string | number | null>;
}
export type DatasetProblem = { rowId: string; code: "DATASET_VERSION" | "BAD_TIMESTAMP" | "BAD_CLASS" | "BAD_SPLIT" | "TOO_FEW_ANNOTATORS" | "DISAGREEMENT_NOT_ADJUDICATED" | "DUPLICATE_ROW_ID" | "CLAIM_WITHOUT_FIELDS" };
const TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function validateDataset(rows: readonly DatasetRow[], datasetVersion: string): DatasetProblem[] {
  const out: DatasetProblem[] = [], seen = new Set<string>();
  for (const r of rows) {
    const p = (code: DatasetProblem["code"]): void => { out.push({ rowId: r.rowId, code }); };
    if (r.datasetVersion !== datasetVersion) p("DATASET_VERSION");
    if (seen.has(r.rowId)) p("DUPLICATE_ROW_ID"); seen.add(r.rowId);
    if (!TZ.test(r.messageTimestamp) || !Number.isFinite(Date.parse(r.messageTimestamp))) p("BAD_TIMESTAMP");
    if (!(MESSAGE_CLASSES as readonly string[]).includes(r.label)) p("BAD_CLASS");
    if (!(SPLITS as readonly string[]).includes(r.split)) p("BAD_SPLIT");
    if (new Set(r.annotators).size < 2) p("TOO_FEW_ANNOTATORS");
    if (new Set(r.annotatorLabels).size > 1 && !r.adjudicated) p("DISAGREEMENT_NOT_ADJUDICATED");
    if (r.label === "claim" && (!r.fields || Object.keys(r.fields).length === 0)) p("CLAIM_WITHOUT_FIELDS");
  }
  return out;
}
export type LeakageProblem = { code: "TEST_BEFORE_TRAIN" | "VALIDATION_BEFORE_TRAIN" | "GROUP_SPANS_SPLITS"; detail: string };
/** The chronological rule: everything used to tune (train) is strictly earlier than validation, which is earlier than test; a duplicate group never straddles splits. */
export function leakageProblems(rows: readonly DatasetRow[]): LeakageProblem[] {
  const out: LeakageProblem[] = [], t = (r: DatasetRow): number => Date.parse(r.messageTimestamp);
  const by = (s: string): DatasetRow[] => rows.filter((r) => r.split === s);
  const maxTrain = Math.max(-Infinity, ...by("train").map(t)), minVal = Math.min(Infinity, ...by("validation").map(t)), maxVal = Math.max(-Infinity, ...by("validation").map(t)), minTest = Math.min(Infinity, ...by("test").map(t));
  if (minVal <= maxTrain) out.push({ code: "VALIDATION_BEFORE_TRAIN", detail: "a validation message is not later than the latest training message" });
  if (minTest <= Math.max(maxTrain, maxVal)) out.push({ code: "TEST_BEFORE_TRAIN", detail: "a test message is not later than the latest training or validation message" });
  const groups = new Map<string, Set<string>>(); for (const r of rows) (groups.get(r.dupGroup) ?? groups.set(r.dupGroup, new Set()).get(r.dupGroup)!).add(r.split);
  for (const [g, s] of groups) if (s.size > 1) out.push({ code: "GROUP_SPANS_SPLITS", detail: g });
  return out;
}
export type Confusion = Record<string, Record<string, number>>;
/** rows = true class, columns = predicted class. */
export function confusionMatrix(pairs: ReadonlyArray<{ truth: string; predicted: string }>, classes: readonly string[]): Confusion {
  const m: Confusion = {}; for (const a of classes) { m[a] = {}; for (const b of classes) m[a]![b] = 0; }
  for (const p of pairs) { if (!(p.truth in m) || !(p.predicted in m[p.truth]!)) throw new Error(`unknown class: ${p.truth} / ${p.predicted}`); m[p.truth]![p.predicted]!++; }
  return m;
}
export interface ClassStats { class: string; support: number; precision: number | null; recall: number | null; f1: number | null; truePositive: number; falsePositive: number; falseNegative: number }
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
export function perClass(m: Confusion): ClassStats[] {
  const cls = Object.keys(m);
  return cls.map((c) => {
    const tp = m[c]![c]!, fn = cls.reduce((s, o) => s + (o === c ? 0 : m[c]![o]!), 0), fp = cls.reduce((s, o) => s + (o === c ? 0 : m[o]![c]!), 0);
    const precision = ratio(tp, tp + fp), recall = ratio(tp, tp + fn), f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : precision !== null && recall !== null ? 0 : null;
    return { class: c, support: tp + fn, precision, recall, f1, truePositive: tp, falsePositive: fp, falseNegative: fn };
  });
}
export const macroF1 = (s: readonly ClassStats[]): number | null => { const f = s.map((x) => x.f1).filter((x): x is number => x !== null); return f.length === 0 ? null : f.reduce((a, b) => a + b, 0) / f.length; };
/** Wilson score interval for k successes of n (95%). */
export function wilson(k: number, n: number, z = 1.96): { lower: number; upper: number } | null {
  if (n <= 0 || k < 0 || k > n) return null; const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.max(0, (c - w) / d), upper: Math.min(1, (c + w) / d) };
}
export type FieldOutcome = "CORRECT" | "WRONG_VALUE" | "ABSTAINED_CORRECTLY" | "MISSED" | "INVENTED";
/** One field of one claim: truth null = "unstated". Predicting a value where the truth is "unstated" is INVENTED (the worst error); a wrong number is WRONG_VALUE; saying nothing for a stated value is MISSED. */
export function fieldOutcome(truth: string | number | null, predicted: string | number | null): FieldOutcome {
  if (truth === null) return predicted === null ? "ABSTAINED_CORRECTLY" : "INVENTED";
  if (predicted === null) return "MISSED";
  return String(truth) === String(predicted) ? "CORRECT" : "WRONG_VALUE";
}
export interface FieldReport { field: string; n: number; counts: Record<FieldOutcome, number>; wrongValueRate: number | null; inventedRate: number | null; accuracyInterval: { lower: number; upper: number } | null }
export function fieldReport(field: string, pairs: ReadonlyArray<{ truth: string | number | null; predicted: string | number | null }>): FieldReport {
  const counts: Record<FieldOutcome, number> = { CORRECT: 0, WRONG_VALUE: 0, ABSTAINED_CORRECTLY: 0, MISSED: 0, INVENTED: 0 };
  for (const p of pairs) counts[fieldOutcome(p.truth, p.predicted)]++;
  const n = pairs.length;
  return { field, n, counts, wrongValueRate: ratio(counts.WRONG_VALUE, n), inventedRate: ratio(counts.INVENTED, n), accuracyInterval: wilson(counts.CORRECT + counts.ABSTAINED_CORRECTLY, n) };
}
export function cohenKappa(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const cls = [...new Set([...a, ...b])], n = a.length; let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n, pe = cls.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}
/** A figure is only reported as ACCURACY when the labelled claim count is large enough (default 200, the owner-agreed floor); below it the report says so and publishes no accuracy. */
export const reportable = (claims: number, floor = 200): { status: "REPORTABLE" | "INSUFFICIENT_SAMPLE"; claims: number; floor: number } => ({ status: claims >= floor ? "REPORTABLE" : "INSUFFICIENT_SAMPLE", claims, floor });
