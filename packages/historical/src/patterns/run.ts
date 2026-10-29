import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { InputError } from "../readers";
import type { ScoredSignal } from "../scorecards/metrics";
import { canonicalSources } from "../scorecards/run";
import type { Tier } from "../scorecards/tiers";
import {
  computeConfidence, CONFIDENCE_ALGORITHM_VERSION, resolveConfidenceConfig, type ConfidenceConfig, type ConfidenceConfigOverride, type ConfidenceEstimate, type DataQualityInput, type MarketContext, type PatternView, type SignalForConfidence,
} from "./confidence";
import { deriveFeatures, FEATURE_VERSION, patternKeys, type Features } from "./features";
import { computePatternStats, PATTERN_ALGORITHM_VERSION, resolvePatternConfig, type PatternConfig, type PatternMetrics } from "./stats";

/**
 * Pattern library and confidence runs (Stage 4 / Task 4). READS imported historical records, outcome labels and scorecard tiers (never modifies them) and APPENDS to the five pattern /
 * confidence tables only. No live-pipeline table is written; no risk decision, approval card, order, fill or position is created; no message text is read. Estimates are deterministic
 * (no LLM) and say so. A run is identified by a hash of its inputs, so rebuilding unchanged input is a no-op.
 */
const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const DAY = 86_400_000;
const mustActor = (a: string): void => { if (!ACTOR.test(a)) throw new InputError("invalid_created_by"); };
const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const defKey = (keyText: string): string => sha(`${FEATURE_VERSION}|${keyText}`);
const D = schema.historicalPatternDefinitions, PR = schema.historicalPatternRuns, PS = schema.historicalPatternSnapshots;

interface Sample { channel: string; at: Date; features: Features; scored: ScoredSignal; labelId: string | null; evalRunId: string | null; dataset: string | null }

async function loadSamples(db: Db): Promise<Sample[]> {
  const S = schema.historicalSourceRecords, N = schema.historicalNormalizedRecords, L = schema.historicalOutcomeLabels, ER = schema.historicalEvaluationRuns, DS = schema.historicalDatasets;
  const rows = await db.select({
    id: S.id, channel: S.channelLabel, mid: S.originalMessageId, at: S.messageTimestamp,
    nId: N.id, parseStatus: N.parseStatus, market: N.market, instrumentType: N.instrumentType, underlying: N.underlying, expiryDate: N.expiryDate, optionType: N.optionType, side: N.side, entry: N.entry, stopLoss: N.stopLoss, targets: N.targets, slv: N.stopLossValidation,
  }).from(S).leftJoin(N, eq(N.sourceRecordId, S.id)).where(eq(S.revisionNo, 0)).orderBy(asc(S.id), asc(N.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.id, r);
  const labelRows = await db.select({
    id: L.id, nId: L.normalizedRecordId, outcome: L.finalOutcome, quality: L.dataQuality, targets: L.targetEvaluations, runId: L.runId,
    ds: sql<string | null>`case when ${DS.id} is null then null else ${DS.providerId} || '|' || ${DS.datasetId} || '|' || ${DS.datasetVersion} || '|' || ${DS.contentSha256} end`,
  }).from(L).innerJoin(ER, eq(ER.id, L.runId)).leftJoin(DS, eq(DS.id, L.datasetId)).orderBy(asc(ER.createdAt), asc(L.id));
  const lastLabel = new Map<string, (typeof labelRows)[number]>();
  for (const l of labelRows) lastLabel.set(l.nId, l);
  const out: Sample[] = [];
  for (const o of latest.values()) {
    const isSignal = o.parseStatus === "SIGNAL" || o.parseStatus === "OPTIONS_CLAIM";
    if (!isSignal) continue;
    const label = o.nId ? lastLabel.get(o.nId) : undefined;
    const th = Array.isArray(label?.targets) ? (label?.targets as Array<{ status?: string }>) : [];
    const tg = Array.isArray(o.targets) ? (o.targets as unknown[]).map(num).filter((x): x is number => x !== null) : [];
    const features = deriveFeatures({ market: o.market, instrumentType: o.instrumentType, underlying: o.underlying, optionType: o.optionType, side: o.side, entry: (o.entry ?? null) as never, stopLoss: num(o.stopLoss), targets: tg, expiryDate: o.expiryDate, timestamp: o.at });
    out.push({
      channel: o.channel, at: o.at, features, labelId: label?.id ?? null, evalRunId: label?.runId ?? null, dataset: label?.ds ?? null,
      scored: { key: `${o.channel}|${o.mid}`, at: o.at, isSignal: true, outcome: label?.outcome ?? null, targetHits: [th[0]?.status === "TARGET_HIT", th[1]?.status === "TARGET_HIT", th[2]?.status === "TARGET_HIT"], dataQuality: label?.quality ?? null, slPresent: num(o.stopLoss) !== null, slValid: (o.slv as { result?: string } | null)?.result === "VALID", revisions: 0, adverseSlRevision: false, evidenceConflict: false },
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.scored.key < b.scored.key ? -1 : 1));
}

async function ensureDefinitions(db: Db, keys: Map<string, { level: number; features: Record<string, string> }>, createdBy: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [keyText, k] of [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const patternKey = defKey(keyText);
    const [ins] = await db.insert(D).values({ patternKey, keyText, level: k.level, features: k.features, definitionVersion: FEATURE_VERSION, createdBy }).onConflictDoNothing({ target: D.patternKey }).returning({ id: D.id });
    const [row] = ins ? [ins] : await db.select({ id: D.id }).from(D).where(eq(D.patternKey, patternKey));
    if (!row) throw new InputError("pattern_not_registered");
    ids.set(keyText, row.id);
  }
  return ids;
}

/** Registers a definition for every feature combination (levels 1-4) observed in the imported signals. Idempotent. */
export async function rebuildPatternLibrary(db: Db, createdBy: string): Promise<{ signals: number; patterns: number; byLevel: Record<string, number> }> {
  mustActor(createdBy);
  const samples = await loadSamples(db);
  const keys = new Map<string, { level: number; features: Record<string, string> }>();
  for (const s of samples) for (const k of patternKeys(s.features)) keys.set(k.keyText, { level: k.level, features: k.features });
  await ensureDefinitions(db, keys, createdBy);
  const byLevel: Record<string, number> = {};
  for (const k of keys.values()) byLevel[`L${k.level}`] = (byLevel[`L${k.level}`] ?? 0) + 1;
  return { signals: samples.length, patterns: keys.size, byLevel };
}

export interface MetricsOptions { asOf: Date; createdBy: string; config?: Partial<PatternConfig> }
export interface MetricsResult { runId: string; created: boolean; patterns: number; trainingSignals: number; sufficient: number }

export async function rebuildPatternMetrics(db: Db, o: MetricsOptions): Promise<MetricsResult> {
  mustActor(o.createdBy);
  const cfg = resolvePatternConfig(o.config);
  const cutoff = new Date(o.asOf.getTime() - cfg.embargoDays * DAY);
  const training = (await loadSamples(db)).filter((s) => s.at.getTime() <= cutoff.getTime());
  const groups = new Map<string, { level: number; features: Record<string, string>; samples: Sample[] }>();
  for (const s of training) for (const k of patternKeys(s.features)) (groups.get(k.keyText) ?? groups.set(k.keyText, { level: k.level, features: k.features, samples: [] }).get(k.keyText) as { samples: Sample[] }).samples.push(s);
  // source trust tiers are a descriptive mix per pattern (latest tier per canonical source; not point-in-time - the mix is context, not an input to the metrics)
  const tierOf = new Map<string, { tier: Tier; runId: string | null }>();
  for (const src of await canonicalSources(db)) {
    const [t] = await db.select({ tier: schema.historicalTrustTiers.tier, runId: schema.historicalTrustTiers.runId }).from(schema.historicalTrustTiers).where(eq(schema.historicalTrustTiers.sourceId, src.id)).orderBy(desc(schema.historicalTrustTiers.asOf), desc(schema.historicalTrustTiers.createdAt)).limit(1);
    for (const m of src.members) tierOf.set(m, { tier: (t?.tier ?? "UNKNOWN") as Tier, runId: t?.runId ?? null });
  }
  const labelIds = training.map((s) => s.labelId).filter((x): x is string => x !== null).sort();
  const labelSetSha256 = sha(labelIds.join(","));
  const inputSha = sha(JSON.stringify(training.map((s) => [s.scored.key, s.at.toISOString(), s.scored.outcome, s.scored.targetHits, s.scored.dataQuality, s.features])));
  const algorithm = `${PATTERN_ALGORITHM_VERSION}+${FEATURE_VERSION}`;
  const runKey = sha(JSON.stringify([o.asOf.toISOString(), algorithm, cfg, labelSetSha256, inputSha, [...tierOf.entries()].sort()]));
  const inputSummary = {
    trainingSignals: training.length, labelCount: labelIds.length, inputSha256: inputSha,
    evaluationRunIds: [...new Set(training.map((s) => s.evalRunId).filter((x): x is string => x !== null))].sort(), datasetRefs: [...new Set(training.map((s) => s.dataset).filter((x): x is string => x !== null))].sort(),
    scorecardRunIds: [...new Set([...tierOf.values()].map((t) => t.runId).filter((x): x is string => x !== null))].sort(),
  };
  const defIds = await ensureDefinitions(db, new Map([...groups].map(([k, g]) => [k, { level: g.level, features: g.features }])), o.createdBy);
  const stats = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([keyText, g]) => ({ keyText, g, st: computePatternStats(g.samples.map((s) => s.scored), cfg) }));
  const sufficient = stats.filter((x) => x.st.status === "SUFFICIENT").length;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(1953726, hashtext(${runKey}))`);
    const [existing] = await tx.select({ id: PR.id }).from(PR).where(eq(PR.runKey, runKey));
    if (existing) return { runId: existing.id, created: false, patterns: stats.length, trainingSignals: training.length, sufficient };
    const [run] = await tx.insert(PR).values({ runKey, algorithmVersion: algorithm, config: cfg, configSha256: sha(JSON.stringify(cfg)), asOf: o.asOf, embargoCutoff: cutoff, labelSetSha256, inputSummary, patternCount: stats.length, createdBy: o.createdBy }).returning({ id: PR.id });
    const runId = (run as { id: string }).id;
    for (const { keyText, g, st } of stats) {
      const tierMix: Record<string, number> = {}, dqMix: Record<string, number> = {};
      for (const s of g.samples) {
        const t = (tierOf.get(s.channel)?.tier ?? "UNKNOWN") as string;
        tierMix[t] = (tierMix[t] ?? 0) + 1;
        const dq = s.scored.dataQuality ?? "UNEVALUATED";
        dqMix[dq] = (dqMix[dq] ?? 0) + 1;
      }
      await tx.insert(PS).values({
        runId, patternId: defIds.get(keyText) as string, level: g.level, evidenceStatus: st.status, flags: st.flags, sampleSize: st.sampleSize, metrics: st.metrics,
        mixes: { sourceTrustTier: tierMix, dataQuality: dqMix }, firstObserved: st.firstObserved, lastObserved: st.lastObserved, createdBy: o.createdBy,
      });
    }
    return { runId, created: true, patterns: stats.length, trainingSignals: training.length, sufficient };
  });
}

export async function latestPatternRun(db: Db, atOrBefore?: Date): Promise<{ id: string; asOf: Date; config: unknown } | undefined> {
  const [r] = await db.select({ id: PR.id, asOf: PR.asOf, config: PR.config }).from(PR).where(atOrBefore ? lte(PR.asOf, atOrBefore) : undefined).orderBy(desc(PR.asOf), desc(PR.createdAt), desc(PR.id)).limit(1);
  return r;
}

export async function loadPatternViews(db: Db, runId: string, keyTexts: string[]): Promise<Map<string, PatternView>> {
  const rows = await db.select({ patternId: D.id, keyText: D.keyText, level: D.level, snapshotId: PS.id, status: PS.evidenceStatus, sampleSize: PS.sampleSize, metrics: PS.metrics })
    .from(PS).innerJoin(D, eq(D.id, PS.patternId)).where(and(eq(PS.runId, runId), inArray(D.keyText, keyTexts)));
  return new Map(rows.map((r) => [r.keyText, { patternId: r.patternId, snapshotId: r.snapshotId, keyText: r.keyText, level: r.level, status: r.status as PatternView["status"], sampleSize: r.sampleSize, metrics: r.metrics as PatternMetrics }]));
}

export type EstimateResult = ConfidenceEstimate & { patternRunId: string | null; algorithmVersion: string };
/**
 * READ-ONLY service function for the future sizing / confidence engine: a deterministic estimate for a new signal from the stored pattern library, or UNKNOWN. By default it uses the latest
 * pattern run at or before the signal's timestamp. It is not called by the live risk flow and writes nothing.
 */
export async function estimateSignalConfidence(db: Db, signal: SignalForConfidence, sourceTrustTier: Tier, marketContext: MarketContext, opts: { patternRunId?: string; config?: ConfidenceConfigOverride } = {}): Promise<EstimateResult> {
  const cfg = resolveConfidenceConfig(opts.config);
  const run = opts.patternRunId ? (await db.select({ id: PR.id, asOf: PR.asOf, config: PR.config }).from(PR).where(eq(PR.id, opts.patternRunId)))[0] : await latestPatternRun(db, signal.timestamp);
  const base = { algorithmVersion: CONFIDENCE_ALGORITHM_VERSION };
  if (!run) {
    const f = deriveFeatures(signal);
    return { ...base, patternRunId: null, score: 0, tier: "UNKNOWN", evidenceQuality: "NO_LIBRARY", sampleSize: 0, primaryPatternKey: null, patternRefs: [], inputs: { features: f, sourceTrustTier: sourceTrustTier }, explanation: [{ rule: "NO_PATTERN_LIBRARY", detail: "no pattern metrics run exists at or before the signal time" }], limitations: ["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM"] };
  }
  const keys = patternKeys(deriveFeatures(signal)).map((k) => k.keyText);
  const views = await loadPatternViews(db, run.id, keys);
  const extra = run.asOf.getTime() > signal.timestamp.getTime() ? ["LOOKAHEAD_IN_SAMPLE"] : [];
  return { ...base, patternRunId: run.id, ...computeConfidence(signal, sourceTrustTier, marketContext, (k) => views.get(k), cfg, extra) };
}

// ── batch / record estimation over imported historical signals ──
export type EstimateScope = { kind: "RECORD"; normalizedRecordId: string } | { kind: "BATCH"; batchId: string };
export interface EstimateOptions { scope: EstimateScope; createdBy: string; patternRunId?: string; trustMode?: "point_in_time" | "latest"; allowInSample?: boolean; config?: ConfidenceConfigOverride; dryRun?: boolean }
export interface EstimateRunResult { runId: string | null; created: boolean; patternRunId: string; lookahead: boolean; counts: { evaluated: number; skippedNotSignal: number; byTier: Record<string, number>; byEvidence: Record<string, number> } }

interface Timeline { asOf: Date; tier: Tier; runId: string }
async function tierTimelines(db: Db, channels: string[]): Promise<Map<string, Timeline[]>> {
  const out = new Map<string, Timeline[]>();
  const cache = new Map<string, Timeline[]>();
  for (const src of await canonicalSources(db)) {
    const rows = await db.select({ asOf: schema.historicalTrustTiers.asOf, tier: schema.historicalTrustTiers.tier, runId: schema.historicalTrustTiers.runId, c: schema.historicalTrustTiers.createdAt }).from(schema.historicalTrustTiers).where(eq(schema.historicalTrustTiers.sourceId, src.id)).orderBy(asc(schema.historicalTrustTiers.asOf), asc(schema.historicalTrustTiers.createdAt));
    cache.set(src.id, rows.map((r) => ({ asOf: r.asOf, tier: r.tier as Tier, runId: r.runId })));
    for (const m of src.members) out.set(m, cache.get(src.id) as Timeline[]);
  }
  for (const c of channels) if (!out.has(c)) out.set(c, []);
  return out;
}

export async function runConfidenceEstimation(db: Db, o: EstimateOptions): Promise<EstimateRunResult> {
  mustActor(o.createdBy);
  const cfg: ConfidenceConfig = resolveConfidenceConfig(o.config);
  const trustMode = o.trustMode ?? "point_in_time";
  const S = schema.historicalSourceRecords, N = schema.historicalNormalizedRecords;
  const where = o.scope.kind === "RECORD" ? eq(N.id, o.scope.normalizedRecordId) : eq(S.batchId, o.scope.batchId);
  const rows = await db.select({
    nId: N.id, sId: N.sourceRecordId, channel: S.channelLabel, at: S.messageTimestamp, editedAt: S.editedAt, parseStatus: N.parseStatus, market: N.market, instrumentType: N.instrumentType, underlying: N.underlying, expiryDate: N.expiryDate, optionType: N.optionType,
    side: N.side, entry: N.entry, stopLoss: N.stopLoss, targets: N.targets, slv: N.stopLossValidation, validation: N.validationResult,
  }).from(N).innerJoin(S, eq(S.id, N.sourceRecordId)).where(where).orderBy(asc(N.id));
  if (rows.length === 0) throw new InputError("no_records_in_scope");
  const patternRun = o.patternRunId ? (await db.select({ id: PR.id, asOf: PR.asOf }).from(PR).where(eq(PR.id, o.patternRunId)))[0] : await latestPatternRun(db);
  if (!patternRun) throw new InputError("no_pattern_run");
  const timelines = await tierTimelines(db, [...new Set(rows.map((r) => r.channel))]);
  let lookahead = false;
  const counts = { evaluated: 0, skippedNotSignal: 0, byTier: {} as Record<string, number>, byEvidence: {} as Record<string, number> };
  const items: Array<{ nId: string; sId: string; est: ConfidenceEstimate; tierRun: string | null }> = [];
  const allViews = new Map<string, PatternView>();
  const need = new Set<string>();
  const prepared = rows.filter((r) => r.parseStatus === "SIGNAL" || r.parseStatus === "OPTIONS_CLAIM").map((r) => {
    const sig: SignalForConfidence = {
      market: r.market, instrumentType: r.instrumentType, underlying: r.underlying, optionType: r.optionType, side: r.side, entry: (r.entry ?? null) as never, stopLoss: num(r.stopLoss),
      targets: Array.isArray(r.targets) ? (r.targets as unknown[]).map(num).filter((x): x is number => x !== null) : [], expiryDate: r.expiryDate, timestamp: r.editedAt ?? r.at,
      stopLossValid: (r.slv as { result?: string } | null)?.result === "VALID", dataQuality: (r.validation === "VALID" ? "GOOD" : r.validation === "AMBIGUOUS" ? "DEGRADED" : r.validation === "INCOMPLETE" ? "INSUFFICIENT" : "UNKNOWN") as DataQualityInput,
    };
    for (const k of patternKeys(deriveFeatures(sig))) need.add(k.keyText);
    return { r, sig };
  });
  counts.skippedNotSignal = rows.length - prepared.length;
  for (const [k, v] of await loadPatternViews(db, patternRun.id, [...need])) allViews.set(k, v);
  for (const { r, sig } of prepared) {
    const tl = timelines.get(r.channel) ?? [];
    const upTo = tl.filter((t) => t.asOf.getTime() <= sig.timestamp.getTime());
    const picked = trustMode === "latest" ? tl[tl.length - 1] : upTo[upTo.length - 1];
    const trust: Tier = picked?.tier ?? "UNKNOWN";
    const extra: string[] = [];
    if (patternRun.asOf.getTime() > sig.timestamp.getTime()) extra.push("LOOKAHEAD_IN_SAMPLE");
    if (picked && picked.asOf.getTime() > sig.timestamp.getTime()) extra.push("TRUST_TIER_LOOKAHEAD");
    if (extra.length) lookahead = true;
    const est = computeConfidence(sig, trust, { available: false }, (k) => allViews.get(k), cfg, [...extra, "HISTORICAL_SIGNAL_NO_MARKET_CONTEXT"]);
    items.push({ nId: r.nId, sId: r.sId, est, tierRun: picked?.runId ?? null });
    counts.evaluated += 1;
    counts.byTier[est.tier] = (counts.byTier[est.tier] ?? 0) + 1;
    counts.byEvidence[est.evidenceQuality] = (counts.byEvidence[est.evidenceQuality] ?? 0) + 1;
  }
  if (lookahead && !o.allowInSample) throw new InputError("pattern_run_not_point_in_time");
  if (o.dryRun) return { runId: null, created: false, patternRunId: patternRun.id, lookahead, counts };

  const scopeId = o.scope.kind === "RECORD" ? o.scope.normalizedRecordId : o.scope.batchId;
  const runKey = sha(JSON.stringify([patternRun.id, o.scope.kind, scopeId, CONFIDENCE_ALGORITHM_VERSION, cfg, trustMode, sha(JSON.stringify(items.map((i) => [i.nId, i.est.score, i.est.tier, i.est.primaryPatternKey, i.tierRun])))]));
  const CR = schema.historicalConfidenceRuns, CE = schema.historicalConfidenceEstimates;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(1953727, hashtext(${runKey}))`);
    const [existing] = await tx.select({ id: CR.id }).from(CR).where(eq(CR.runKey, runKey));
    if (existing) return { runId: existing.id, created: false, patternRunId: patternRun.id, lookahead, counts };
    const [run] = await tx.insert(CR).values({
      runKey, patternRunId: patternRun.id, scope: o.scope.kind, importBatchId: o.scope.kind === "BATCH" ? o.scope.batchId : null, normalizedRecordId: o.scope.kind === "RECORD" ? o.scope.normalizedRecordId : null,
      algorithmVersion: CONFIDENCE_ALGORITHM_VERSION, config: cfg, configSha256: sha(JSON.stringify(cfg)), trustMode, lookahead, inputSummary: { ...counts, patternRunAsOf: patternRun.asOf.toISOString() }, createdBy: o.createdBy,
    }).returning({ id: CR.id });
    const runId = (run as { id: string }).id;
    for (let i = 0; i < items.length; i += 200) {
      await tx.insert(CE).values(items.slice(i, i + 200).map((it) => ({
        runId, normalizedRecordId: it.nId, sourceRecordId: it.sId, score: it.est.score, tier: it.est.tier, evidenceQuality: it.est.evidenceQuality, sampleSize: it.est.sampleSize, patternRefs: it.est.patternRefs, inputs: it.est.inputs,
        explanation: it.est.explanation, limitations: it.est.limitations, evidenceReferences: { patternRunId: patternRun.id, scorecardRunId: it.tierRun, normalizedRecordId: it.nId, sourceRecordId: it.sId, snapshotIds: it.est.patternRefs.map((p) => p.snapshotId) }, createdBy: o.createdBy,
      })));
    }
    return { runId, created: true, patternRunId: patternRun.id, lookahead, counts };
  });
}

export interface PatternDetail { keyText: string; level: number; features: unknown; runId: string; asOf: string; status: string; flags: unknown; sampleSize: number; metrics: unknown; mixes: unknown; firstObserved: string | null; lastObserved: string | null }
export async function showPattern(db: Db, keyOrHash: string, runId?: string): Promise<PatternDetail | undefined> {
  const run = runId ? (await db.select({ id: PR.id, asOf: PR.asOf }).from(PR).where(eq(PR.id, runId)))[0] : await latestPatternRun(db);
  if (!run) return undefined;
  const [r] = await db.select({ keyText: D.keyText, level: D.level, features: D.features, st: PS.evidenceStatus, flags: PS.flags, n: PS.sampleSize, metrics: PS.metrics, mixes: PS.mixes, first: PS.firstObserved, last: PS.lastObserved })
    .from(PS).innerJoin(D, eq(D.id, PS.patternId)).where(and(eq(PS.runId, run.id), /^[0-9a-f]{64}$/.test(keyOrHash) ? eq(D.patternKey, keyOrHash) : eq(D.keyText, keyOrHash)));
  return r ? { keyText: r.keyText, level: r.level, features: r.features, runId: run.id, asOf: run.asOf.toISOString(), status: r.st, flags: r.flags, sampleSize: r.n, metrics: r.metrics, mixes: r.mixes, firstObserved: r.first?.toISOString() ?? null, lastObserved: r.last?.toISOString() ?? null } : undefined;
}

const COLS = ["keyText", "level", "evidenceStatus", "sampleSize", "winRateEntered", "winRateWilsonLower", "winRateWilsonUpper", "grossExpectancyR", "netExpectancyR", "netExpectancyLowerBoundR", "unverifiableRate", "maxConsecutiveLosses", "maxDrawdownR", "firstObserved", "lastObserved"] as const;
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Safe report of a pattern run: feature keys and numbers only (no message content, authors or evidence text). Every row says it is a historical association. */
export async function exportPatternReport(db: Db, format: "json" | "csv", runId?: string): Promise<string> {
  const run = runId ? (await db.select({ id: PR.id }).from(PR).where(eq(PR.id, runId)))[0] : await latestPatternRun(db);
  if (!run) throw new InputError("no_pattern_run");
  const rows = await db.select({ keyText: D.keyText, level: D.level, st: PS.evidenceStatus, n: PS.sampleSize, m: PS.metrics, first: PS.firstObserved, last: PS.lastObserved }).from(PS).innerJoin(D, eq(D.id, PS.patternId)).where(eq(PS.runId, run.id)).orderBy(asc(D.level), asc(D.keyText));
  const safe = rows.map((r) => {
    const m = r.m as PatternMetrics;
    return { keyText: r.keyText, level: r.level, evidenceStatus: r.st, sampleSize: r.n, winRateEntered: m.winRateEntered, winRateWilsonLower: m.winRateEnteredWilsonLower, winRateWilsonUpper: m.winRateEnteredWilsonUpper, grossExpectancyR: m.grossExpectancyR, netExpectancyR: m.netExpectancyR, netExpectancyLowerBoundR: m.netExpectancyLowerBoundR, unverifiableRate: m.unverifiableRate, maxConsecutiveLosses: m.maxConsecutiveLosses, maxDrawdownR: m.maxDrawdownR, firstObserved: r.first?.toISOString() ?? null, lastObserved: r.last?.toISOString() ?? null };
  });
  if (format === "json") return JSON.stringify({ note: "HISTORICAL_ASSOCIATION_ONLY", patternRunId: run.id, patterns: safe }, null, 2);
  return [COLS.join(","), ...safe.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n");
}
