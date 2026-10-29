import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { InputError } from "../readers";
import { DEFAULT_EVAL_CONFIG, evaluateOutcome, OUTCOME_ALGORITHM_VERSION, type EvalConfig, type EvalSignal, type OutcomeResult } from "./evaluate";
import type { HistoricalDataProvider, SeriesQuery } from "./types";

/**
 * The evaluation run (Stage 4 / Task 2). Reads imported historical records (never modifies them), evaluates each against the provider's pre-exported data and appends labels to the
 * append-only, hash-chained outcome tables. A run is identified by sha256(scope, target, dataset references, algorithm version, configuration incl. the as-of instant), so re-running the
 * same evaluation resolves to the same run: labels already written are skipped (resume), a completed run is a no-op. Work is committed in chunks with a CHECKPOINT event in the same
 * transaction. No signal, risk decision, approval card, order, fill or position is created, and no raw message text is read, stored or logged.
 */
const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export type Scope = { kind: "RECORD"; normalizedRecordId: string } | { kind: "BATCH"; batchId: string };
export interface RunOptions {
  scope: Scope;
  provider: HistoricalDataProvider;
  createdBy: string;
  config?: Partial<Pick<EvalConfig, "horizonDays" | "intrabarPolicy" | "tzOffsetMinutes" | "nearTolerancePct">>;
  /** The instant treated as "now" (bars not complete by then are rejected as future-dated). */
  asOf: Date;
  chunkSize?: number;
  /** Test hook: called after each committed chunk; throwing simulates a crash. */
  afterChunk?: (sequence: number) => void;
}
export interface EvalCounters { evaluated: number; skippedNotEvaluable: number; byOutcome: Record<string, number>; byDataQuality: Record<string, number>; byReason: Record<string, number> }
const zero = (): EvalCounters => ({ evaluated: 0, skippedNotEvaluable: 0, byOutcome: {}, byDataQuality: {}, byReason: {} });
const bump = (o: Record<string, number>, k: string): void => { o[k] = (o[k] ?? 0) + 1; };

interface Target { normalizedId: string; sourceId: string; parseStatus: string; signal: EvalSignal }

function resolveConfig(o: RunOptions): EvalConfig {
  const c = { ...DEFAULT_EVAL_CONFIG, ...(o.config ?? {}) };
  if (!(Number.isInteger(c.horizonDays) && c.horizonDays >= 1 && c.horizonDays <= 365)) throw new InputError("invalid_horizon_days");
  if (c.nearTolerancePct !== null && !(c.nearTolerancePct > 0 && c.nearTolerancePct <= 5)) throw new InputError("invalid_near_tolerance");
  if (c.tzOffsetMinutes !== null && !(Number.isInteger(c.tzOffsetMinutes) && Math.abs(c.tzOffsetMinutes) <= 14 * 60)) throw new InputError("invalid_tz_offset");
  return { ...c, evaluatedAt: o.asOf };
}
const configJson = (c: EvalConfig): Record<string, unknown> => ({ horizonDays: c.horizonDays, intrabarPolicy: c.intrabarPolicy, tzOffsetMinutes: c.tzOffsetMinutes, nearTolerancePct: c.nearTolerancePct, asOf: c.evaluatedAt.toISOString() });

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

async function loadTargets(db: Db, scope: Scope): Promise<Target[]> {
  const n = schema.historicalNormalizedRecords, s = schema.historicalSourceRecords;
  const where = scope.kind === "RECORD" ? eq(n.id, scope.normalizedRecordId) : eq(s.batchId, scope.batchId);
  const rows = await db.select({
    id: n.id, sourceId: n.sourceRecordId, parseStatus: n.parseStatus, market: n.market, instrumentType: n.instrumentType, underlying: n.underlying, expiryDate: n.expiryDate, strike: n.strike, optionType: n.optionType, side: n.side,
    entry: n.entry, stopLoss: n.stopLoss, levelBasis: n.levelBasis, targets: n.targets, timeValidity: n.timeValidity, ambiguous: n.ambiguousFields, parsed: n.parsed, messageTimestamp: s.messageTimestamp, editedAt: s.editedAt,
  }).from(n).innerJoin(s, eq(n.sourceRecordId, s.id)).where(where).orderBy(asc(n.id));
  return rows.map((r) => {
    const tg = Array.isArray(r.targets) ? (r.targets as unknown[]).map(num).filter((x): x is number => x !== null) : [];
    const parsed = (r.parsed ?? {}) as { intent?: string };
    const ambiguous = Array.isArray(r.ambiguous) ? (r.ambiguous as string[]) : [];
    return {
      normalizedId: r.id, sourceId: r.sourceId, parseStatus: r.parseStatus,
      signal: {
        side: r.side ? String(r.side).toLowerCase() : null, instrumentType: r.instrumentType, underlying: r.underlying, market: r.market, entry: (r.entry ?? null) as EvalSignal["entry"], stopLoss: num(r.stopLoss), targets: tg,
        optionType: r.optionType, strike: num(r.strike), expiryDate: r.expiryDate, levelBasis: r.levelBasis, intent: parsed.intent ?? (ambiguous.includes("intent") ? "unresolved" : null), timeValidity: r.timeValidity,
        signalTime: (r.editedAt ?? r.messageTimestamp) as Date,
      },
    };
  });
}

const EVALUABLE = new Set(["SIGNAL", "OPTIONS_CLAIM"]);
const snapshotOf = (t: Target): Record<string, unknown> => {
  const s = t.signal;
  return { parseStatus: t.parseStatus, side: s.side, instrumentType: s.instrumentType, underlying: s.underlying, market: s.market, entry: s.entry, stopLoss: s.stopLoss, targets: s.targets, optionType: s.optionType, strike: s.strike, expiryDate: s.expiryDate, levelBasis: s.levelBasis, intent: s.intent, timeValidity: s.timeValidity, signalTime: s.signalTime.toISOString() };
};
function queryOf(s: EvalSignal): SeriesQuery | null {
  if (!s.underlying) return null;
  if (s.instrumentType === "option") return s.strike !== null && (s.optionType === "CE" || s.optionType === "PE") && s.expiryDate ? { kind: "option_premium", underlying: s.underlying, market: s.market, strike: s.strike, optionType: s.optionType, expiry: s.expiryDate } : null;
  return { kind: "equity_price", symbol: s.underlying, market: s.market };
}

export function evaluateTarget(t: Target, provider: HistoricalDataProvider, cfg: EvalConfig): { result: OutcomeResult; datasetKey: string | null } {
  const q = queryOf(t.signal);
  const m = q ? provider.findSeries(q) : ({ found: null, underlyingAvailable: false } as const);
  const result = evaluateOutcome(t.signal, cfg, m.found ? { series: m.found.series, underlyingAvailable: false } : { series: null, underlyingAvailable: m.underlyingAvailable });
  return { result, datasetKey: m.found ? `${m.found.dataset.providerId}|${m.found.dataset.datasetId}|${m.found.dataset.datasetVersion}|${m.found.dataset.contentSha256}` : null };
}

/** Appends the dataset references (idempotent) and returns their row ids by reference key. */
export async function registerDatasets(db: Db, provider: HistoricalDataProvider, createdBy: string): Promise<Map<string, string>> {
  if (!ACTOR.test(createdBy)) throw new InputError("invalid_created_by");
  const ids = new Map<string, string>();
  for (const d of provider.datasets()) {
    const key = `${d.providerId}|${d.datasetId}|${d.datasetVersion}|${d.contentSha256}`;
    const times = d.series.flatMap((s) => [s.bars[0]?.ts, s.bars[s.bars.length - 1]?.ts]).filter((x): x is Date => x !== undefined).map((x) => x.getTime());
    const values = {
      providerId: d.providerId, datasetId: d.datasetId, datasetVersion: d.datasetVersion, contentSha256: d.contentSha256, seriesCount: d.series.length, barCount: d.series.reduce((a, s) => a + s.bars.length, 0),
      coverageFrom: times.length ? new Date(Math.min(...times)) : null, coverageTo: times.length ? new Date(Math.max(...times)) : null,
      descriptor: d.series.map((s) => ({ kind: s.key.kind, symbol: s.key.symbol, market: s.key.market, strike: s.key.strike, optionType: s.key.optionType, expiry: s.key.expiry, intervalSeconds: s.intervalSeconds, bars: s.bars.length, sha256: s.sha256 })),
      createdBy,
    };
    const [ins] = await db.insert(schema.historicalDatasets).values(values).onConflictDoNothing().returning({ id: schema.historicalDatasets.id });
    const [row] = ins ? [ins] : await db.select({ id: schema.historicalDatasets.id }).from(schema.historicalDatasets).where(and(eq(schema.historicalDatasets.providerId, d.providerId), eq(schema.historicalDatasets.datasetId, d.datasetId), eq(schema.historicalDatasets.datasetVersion, d.datasetVersion), eq(schema.historicalDatasets.contentSha256, d.contentSha256)));
    if (!row) throw new InputError("dataset_not_registered");
    ids.set(key, row.id);
  }
  return ids;
}

export interface DryRunResult { targets: number; evaluable: number; counters: EvalCounters }
/** Evaluates everything and writes nothing. */
export async function dryRunEvaluation(db: Db, o: RunOptions): Promise<DryRunResult> {
  const cfg = resolveConfig(o);
  const targets = await loadTargets(db, o.scope);
  if (targets.length === 0) throw new InputError("no_records_in_scope");
  const counters = zero();
  for (const t of targets) {
    if (!EVALUABLE.has(t.parseStatus)) { counters.skippedNotEvaluable += 1; continue; }
    const { result } = evaluateTarget(t, o.provider, cfg);
    counters.evaluated += 1; bump(counters.byOutcome, result.finalOutcome); bump(counters.byDataQuality, result.dataQuality); if (result.primaryReason) bump(counters.byReason, result.primaryReason);
  }
  return { targets: targets.length, evaluable: counters.evaluated, counters };
}

export interface RunResult { runId: string; runKey: string; outcome: "EVALUATED" | "RESUMED" | "ALREADY_COMPLETED"; resumedAfter: number; checkpoints: number; counters: EvalCounters }

export async function runEvaluation(db: Db, o: RunOptions): Promise<RunResult> {
  if (!ACTOR.test(o.createdBy)) throw new InputError("invalid_created_by");
  const cfg = resolveConfig(o);
  const chunkSize = Math.max(1, Math.min(o.chunkSize ?? 200, 2000));
  const targets = await loadTargets(db, o.scope);
  if (targets.length === 0) throw new InputError("no_records_in_scope");
  const datasetIds = await registerDatasets(db, o.provider, o.createdBy);
  const refKeys = [...datasetIds.keys()].sort();
  const cfgJson = configJson(cfg);
  const scopeId = o.scope.kind === "RECORD" ? o.scope.normalizedRecordId : o.scope.batchId;
  const runKey = sha(JSON.stringify([o.scope.kind, scopeId, refKeys, OUTCOME_ALGORITHM_VERSION, cfgJson]));
  const [made] = await db.insert(schema.historicalEvaluationRuns).values({
    runKey, scope: o.scope.kind, importBatchId: o.scope.kind === "BATCH" ? o.scope.batchId : null, normalizedRecordId: o.scope.kind === "RECORD" ? o.scope.normalizedRecordId : null,
    algorithmVersion: OUTCOME_ALGORITHM_VERSION, config: cfgJson, configSha256: sha(JSON.stringify(cfgJson)), evaluatedAt: cfg.evaluatedAt, datasetIds: refKeys.map((k) => ({ ref: k, id: datasetIds.get(k) })), createdBy: o.createdBy,
  }).onConflictDoNothing({ target: schema.historicalEvaluationRuns.runKey }).returning({ id: schema.historicalEvaluationRuns.id });
  const [run] = made ? [made] : await db.select({ id: schema.historicalEvaluationRuns.id }).from(schema.historicalEvaluationRuns).where(eq(schema.historicalEvaluationRuns.runKey, runKey));
  if (!run) throw new InputError("run_not_found");
  const runId = run.id;
  const E = schema.historicalEvaluationEvents;
  const events = await db.select().from(E).where(eq(E.runId, runId)).orderBy(asc(E.sequence));
  const last = events[events.length - 1];
  if (events.some((e) => e.eventType === "RUN_COMPLETED")) {
    const done = events.find((e) => e.eventType === "RUN_COMPLETED");
    return { runId, runKey, outcome: "ALREADY_COMPLETED", resumedAfter: targets.length, checkpoints: events.length, counters: ((done?.detail as { counters?: EvalCounters })?.counters ?? zero()) };
  }
  let counters: EvalCounters = last ? (((last.detail as { counters?: EvalCounters }).counters) ?? zero()) : zero();
  let sequence = last?.sequence ?? 0;
  const resumed = sequence > 0;
  if (!resumed) { await db.insert(E).values({ runId, eventType: "RUN_STARTED", sequence: 1, detail: { targets: targets.length }, createdBy: o.createdBy }); sequence = 1; }
  const L = schema.historicalOutcomeLabels;
  const existing = new Set((await db.select({ id: L.normalizedRecordId }).from(L).where(eq(L.runId, runId))).map((r) => r.id));
  const pending = targets.filter((t) => !existing.has(t.normalizedId));
  const resumedAfter = targets.length - pending.length;

  for (let i = 0; i < pending.length || (i === 0 && pending.length === 0); i += chunkSize) {
    const chunk = pending.slice(i, i + chunkSize);
    const final = i + chunkSize >= pending.length;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(1953724, hashtext(${runId}))`);
      for (const t of chunk) {
        if (!EVALUABLE.has(t.parseStatus)) { counters.skippedNotEvaluable += 1; continue; }
        const { result, datasetKey } = evaluateTarget(t, o.provider, cfg);
        counters.evaluated += 1; bump(counters.byOutcome, result.finalOutcome); bump(counters.byDataQuality, result.dataQuality); if (result.primaryReason) bump(counters.byReason, result.primaryReason);
        await tx.insert(L).values({
          runId, normalizedRecordId: t.normalizedId, sourceRecordId: t.sourceId, datasetId: datasetKey ? datasetIds.get(datasetKey) ?? null : null, algorithmVersion: OUTCOME_ALGORITHM_VERSION,
          finalOutcome: result.finalOutcome, primaryReason: result.primaryReason, reasons: result.reasons, entryStatus: result.entry.status, entryFirstTouchAt: result.entry.firstTouchAt ? new Date(result.entry.firstTouchAt) : null,
          slStatus: result.stopLoss.status, slFirstTouchAt: result.stopLoss.firstTouchAt ? new Date(result.stopLoss.firstTouchAt) : null, targetEvaluations: result.targets, dataQuality: result.dataQuality,
          dataWindow: result.window, inputSnapshot: snapshotOf(t), evidence: { ...result.evidence, entryTrigger: result.entry.trigger, reachableBeforeValidityEnd: result.entry.reachableBeforeValidityEnd }, createdBy: o.createdBy,
        }).onConflictDoNothing();
      }
      sequence += 1;
      await tx.insert(E).values({ runId, eventType: final ? "RUN_COMPLETED" : "CHECKPOINT", sequence, detail: { counters, labelled: resumedAfter + i + chunk.length }, createdBy: o.createdBy });
    });
    o.afterChunk?.(sequence);
    if (final) break;
  }
  return { runId, runKey, outcome: resumed ? "RESUMED" : "EVALUATED", resumedAfter, checkpoints: sequence, counters };
}

export interface EvaluationReport { runId: string; scope: string; algorithmVersion: string; asOf: string; labels: number; byOutcome: Record<string, number>; byDataQuality: Record<string, number>; byReason: Record<string, number>; completed: boolean }
export async function buildEvaluationReport(db: Db, runId: string): Promise<EvaluationReport | undefined> {
  const R = schema.historicalEvaluationRuns, L = schema.historicalOutcomeLabels, E = schema.historicalEvaluationEvents;
  const [run] = await db.select().from(R).where(eq(R.id, runId));
  if (!run) return undefined;
  const rows = await db.select({ outcome: L.finalOutcome, quality: L.dataQuality, reason: L.primaryReason }).from(L).where(eq(L.runId, runId));
  const done = await db.select({ id: E.id }).from(E).where(and(eq(E.runId, runId), inArray(E.eventType, ["RUN_COMPLETED"])));
  const rep: EvaluationReport = { runId, scope: run.scope, algorithmVersion: run.algorithmVersion, asOf: run.evaluatedAt.toISOString(), labels: rows.length, byOutcome: {}, byDataQuality: {}, byReason: {}, completed: done.length > 0 };
  for (const r of rows) { bump(rep.byOutcome, r.outcome); bump(rep.byDataQuality, r.quality); if (r.reason) bump(rep.byReason, r.reason); }
  return rep;
}
export function renderEvaluationReport(r: EvaluationReport): string {
  const fmt = (o: Record<string, number>): string => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `    ${k}: ${v}`).join("\n") || "    (none)";
  return [`evaluation run ${r.runId} (${r.scope}, ${r.algorithmVersion}, as of ${r.asOf}) - ${r.completed ? "completed" : "IN PROGRESS"}`, `  labels: ${r.labels}`, "  outcomes:", fmt(r.byOutcome), "  data quality:", fmt(r.byDataQuality), "  reasons:", fmt(r.byReason)].join("\n");
}
