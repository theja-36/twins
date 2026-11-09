import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { InputError } from "../readers";
import { computeWindows, isPointInTimeScorecard, SCORECARD_ALGORITHM_VERSION, type Metrics, type ScoredSignal } from "./metrics";
import { assignTier, resolveTierConfig, TIER_ALGORITHM_VERSION, TIER_LABELS, type Tier, type TierConfig } from "./tiers";

/**
 * Source scorecards (Stage 4 / Task 3). READS imported historical records and their evaluated outcome labels (never modifies them) and APPENDS to the five scorecard tables. Writes nothing
 * to any live-pipeline table and creates no risk decision, approval card, order, fill or position. No message text is read: only timestamps, parsed numeric levels, statuses and counts.
 * A scorecard run is identified by sha256(source, as-of, algorithm, tier configuration, label set, per-signal input), so rebuilding the same input is a no-op.
 */
const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const R = schema.historicalSourceRegistry;
export const sourceKeyOf = (label: string): string => sha(`channel|${label}`);
const aliasKeyOf = (label: string): string => sha(`alias|${label}`);
const mustActor = (a: string): void => { if (!ACTOR.test(a)) throw new InputError("invalid_created_by"); };

export interface RegistryEntry { id: string; entryType: string; channelLabel: string; aliasOfId: string | null }
async function registryRows(db: Db): Promise<RegistryEntry[]> {
  return db.select({ id: R.id, entryType: R.entryType, channelLabel: R.channelLabel, aliasOfId: R.aliasOfId }).from(R).orderBy(asc(R.channelLabel), asc(R.id));
}

/** Registers one IDENTITY per channel label found in the imported records (idempotent). Returns how many were new. */
export async function registerSources(db: Db, createdBy: string): Promise<{ registered: number; total: number }> {
  mustActor(createdBy);
  const labels = await db.selectDistinct({ l: schema.historicalSourceRecords.channelLabel }).from(schema.historicalSourceRecords).orderBy(asc(schema.historicalSourceRecords.channelLabel));
  let registered = 0;
  for (const { l } of labels) {
    const rows = await db.insert(R).values({ entryType: "IDENTITY", sourceKey: sourceKeyOf(l), channelLabel: l, createdBy }).onConflictDoNothing({ target: R.sourceKey }).returning({ id: R.id });
    registered += rows.length;
  }
  return { registered, total: labels.length };
}

/** Explicitly links an alias identity to a canonical one. Never automatic, never silent; one link per alias, forever (the registry is append-only). */
export async function linkAlias(db: Db, o: { alias: string; canonical: string; reason: string; createdBy: string }): Promise<{ created: boolean; linkId: string }> {
  mustActor(o.createdBy);
  if (!o.reason.trim() || o.reason.length > 500) throw new InputError("alias_reason_required");
  if (o.alias === o.canonical) throw new InputError("alias_equals_canonical");
  const rows = await registryRows(db);
  const identity = (l: string): RegistryEntry | undefined => rows.find((r) => r.entryType === "IDENTITY" && r.channelLabel === l);
  const a = identity(o.alias), c = identity(o.canonical);
  if (!a || !c) throw new InputError("source_not_registered");
  const links = rows.filter((r) => r.entryType === "ALIAS_LINK");
  const existing = links.find((l) => l.channelLabel === o.alias);
  if (existing) { if (existing.aliasOfId === c.id) return { created: false, linkId: existing.id }; throw new InputError("alias_already_linked_elsewhere"); }
  if (links.some((l) => l.channelLabel === o.canonical)) throw new InputError("canonical_is_itself_an_alias");
  if (links.some((l) => l.aliasOfId === a.id)) throw new InputError("alias_has_its_own_aliases");
  const [row] = await db.insert(R).values({ entryType: "ALIAS_LINK", sourceKey: aliasKeyOf(o.alias), channelLabel: o.alias, aliasOfId: c.id, reason: o.reason.trim(), createdBy: o.createdBy }).returning({ id: R.id });
  return { created: true, linkId: (row as { id: string }).id };
}

export interface CanonicalSource { id: string; channelLabel: string; members: string[] }
/** Canonical sources (identities that are not aliases) with their member labels (themselves + explicitly linked aliases). */
export async function canonicalSources(db: Db): Promise<CanonicalSource[]> {
  const rows = await registryRows(db);
  const linkedAlias = new Set(rows.filter((r) => r.entryType === "ALIAS_LINK").map((r) => r.channelLabel));
  return rows.filter((r) => r.entryType === "IDENTITY" && !linkedAlias.has(r.channelLabel)).map((r) => ({
    id: r.id, channelLabel: r.channelLabel, members: [r.channelLabel, ...rows.filter((l) => l.entryType === "ALIAS_LINK" && l.aliasOfId === r.id).map((l) => l.channelLabel)].sort(),
  }));
}
/** Resolves a label (canonical or alias) to its canonical source. */
export async function resolveSource(db: Db, label: string): Promise<CanonicalSource | undefined> {
  const all = await canonicalSources(db);
  return all.find((s) => s.members.includes(label));
}

interface Loaded { signals: ScoredSignal[]; labelIds: string[]; evaluationRunIds: string[]; datasetRefs: string[]; snapshot: Record<string, unknown> }
const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const canon = (v: unknown): string => JSON.stringify(v ?? null);

/** When the outcome became knowable: the latest first touch of a hit target (wins), the stop touch (losses), otherwise the end of the observation window; an invalid signal is known at its message time. Null = cannot be established. */
export function resolutionTime(outcome: string, messageAt: Date, targets: Array<{ status?: string; firstTouchAt?: string | null }>, slTouch: Date | null, dataWindow: unknown): Date | null {
  // A touch is stamped with its bar's START; it is only knowable when that bar closes, so the bar length is added. No bar length recorded: not established.
  const w = typeof dataWindow === "object" && dataWindow !== null ? (dataWindow as Record<string, unknown>) : {};
  const barMs = typeof w["intervalSeconds"] === "number" && w["intervalSeconds"] > 0 ? w["intervalSeconds"] * 1000 : null;
  const closes = (d: Date | null): Date | null => (d !== null && barMs !== null ? new Date(d.getTime() + barMs) : null);
  const t = (v: string | null | undefined): Date | null => { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d : null; };
  if (outcome.startsWith("WIN_")) { const hits = targets.filter((x) => x.status === "TARGET_HIT").map((x) => t(x.firstTouchAt)); return hits.length > 0 && hits.every((x) => x !== null) ? closes(new Date(Math.max(...hits.map((x) => (x as Date).getTime())))) : null; }
  if (outcome === "LOSS_SL") return closes(slTouch);
  if (outcome === "INVALID_SIGNAL") return messageAt;
  const end = t(typeof dataWindow === "object" && dataWindow !== null ? ((dataWindow as Record<string, unknown>)["validityEnd"] as string | undefined) : undefined);
  return end ?? null;
}
async function loadSignals(db: Db, members: string[], evaluationRunIds: string[] | undefined, asOf: Date): Promise<Loaded> {
  const S = schema.historicalSourceRecords, N = schema.historicalNormalizedRecords, L = schema.historicalOutcomeLabels, ER = schema.historicalEvaluationRuns, D = schema.historicalDatasets;
  const rows = await db.select({
    id: S.id, channel: S.channelLabel, mid: S.originalMessageId, rev: S.revisionNo, editOf: S.editOfId, at: S.messageTimestamp, editedAt: S.editedAt, author: S.author,
    nId: N.id, createdN: N.createdAt, parseStatus: N.parseStatus, market: N.market, side: N.side, entry: N.entry, stopLoss: N.stopLoss, targets: N.targets, slv: N.stopLossValidation,
  }).from(S).leftJoin(N, eq(N.sourceRecordId, S.id)).where(inArray(S.channelLabel, members)).orderBy(asc(S.id), asc(N.createdAt));
  const latestN = new Map<string, (typeof rows)[number]>(); // newest normalization per source record
  for (const r of rows) latestN.set(r.id, r);
  const originals = [...latestN.values()].filter((r) => r.rev === 0);
  const revisions = [...latestN.values()].filter((r) => r.rev > 0);

  const labelRows = await db.select({
    id: L.id, nId: L.normalizedRecordId, outcome: L.finalOutcome, quality: L.dataQuality, targets: L.targetEvaluations, entryTouch: L.entryFirstTouchAt, slTouch: L.slFirstTouchAt, dataWindow: L.dataWindow, runId: L.runId, runCreated: ER.createdAt,
    ds: sql<string | null>`case when ${D.id} is null then null else ${D.providerId} || '|' || ${D.datasetId} || '|' || ${D.datasetVersion} || '|' || ${D.contentSha256} end`,
  }).from(L).innerJoin(ER, eq(ER.id, L.runId)).innerJoin(S, eq(S.id, L.sourceRecordId)).leftJoin(D, eq(D.id, L.datasetId))
    .where(and(inArray(S.channelLabel, members), evaluationRunIds ? inArray(L.runId, evaluationRunIds) : undefined)).orderBy(asc(ER.createdAt), asc(L.id));
  const latestLabel = new Map<string, (typeof labelRows)[number]>(); // the most recent run's label per normalized record
  for (const l of labelRows) latestLabel.set(l.nId, l);

  const revsOf = new Map<string, typeof revisions>();
  for (const r of revisions) if (r.editOf) (revsOf.get(r.editOf) ?? revsOf.set(r.editOf, []).get(r.editOf) as typeof revisions).push(r);
  const used: Array<NonNullable<ReturnType<typeof latestLabel.get>>> = [];
  const signals: ScoredSignal[] = originals.map((o) => {
    const isSignal = o.parseStatus === "SIGNAL" || o.parseStatus === "OPTIONS_CLAIM";
    const label = isSignal && o.nId ? latestLabel.get(o.nId) : undefined;
    if (label) used.push(label);
    // A revision made after the as-of instant did not exist then.
    const revs = (revsOf.get(o.id) ?? []).filter((r) => r.editedAt === null || r.editedAt.getTime() <= asOf.getTime());
    const orig = num(o.stopLoss);
    const buy = String(o.side ?? "").toLowerCase() === "buy";
    const adverse = revs.some((r) => {
      const rs = num(r.stopLoss);
      if (orig === null) return false;
      return rs === null || (buy ? rs < orig : rs > orig);
    });
    const levels = (x: { entry: unknown; targets: unknown; stopLoss: unknown }): string => canon([x.entry, x.targets, num(x.stopLoss)]);
    const entryTouch = label?.entryTouch ?? null;
    const conflict = revs.some((r) => r.editedAt !== null && (r.editedAt.getTime() < o.at.getTime() || (entryTouch !== null && r.editedAt.getTime() > entryTouch.getTime() && levels(r) !== levels(o))));
    const th = Array.isArray(label?.targets) ? (label?.targets as Array<{ status?: string; firstTouchAt?: string | null }>) : [];
    const resolvedAt = label ? resolutionTime(label.outcome, o.at, th, label.slTouch, label.dataWindow) : undefined;
    return {
      key: `${o.channel}|${o.mid}`, at: o.at, isSignal, ...(resolvedAt !== undefined ? { resolvedAt } : {}), outcome: label?.outcome ?? null, targetHits: [th[0]?.status === "TARGET_HIT", th[1]?.status === "TARGET_HIT", th[2]?.status === "TARGET_HIT"],
      dataQuality: label?.quality ?? null, slPresent: orig !== null, slValid: (o.slv as { result?: string } | null)?.result === "VALID", revisions: revs.length, adverseSlRevision: adverse, evidenceConflict: conflict,
    };
  });
  const authors = [...new Set(originals.map((o) => o.author).filter((a): a is string => typeof a === "string" && a.length > 0))].sort();
  const markets = [...new Set(originals.map((o) => o.market).filter((m): m is string => typeof m === "string"))].sort();
  const times = originals.map((o) => o.at.getTime());
  return {
    signals, labelIds: used.map((l) => l.id).sort(), evaluationRunIds: [...new Set(used.map((l) => l.runId))].sort(), datasetRefs: [...new Set(used.map((l) => l.ds).filter((d): d is string => d !== null))].sort(),
    snapshot: {
      memberLabels: members, authors, markets, firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null, lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
      importedMessages: originals.length, revisionRecords: revisions.length, normalizedSignals: signals.filter((s) => s.isSignal).length,
    },
  };
}

export interface RebuildResult { sourceLabel: string; sourceId: string; runId: string; created: boolean; tier: Tier; evaluable: number }
export interface RebuildOptions { asOf: Date; createdBy: string; tierConfig?: Parameters<typeof resolveTierConfig>[0]; evaluationRunIds?: string[] }

export async function rebuildScorecard(db: Db, source: CanonicalSource, o: RebuildOptions): Promise<RebuildResult> {
  mustActor(o.createdBy);
  const cfg: TierConfig = resolveTierConfig(o.tierConfig);
  const loaded = await loadSignals(db, source.members, o.evaluationRunIds, o.asOf);
  const windows = computeWindows(loaded.signals, o.asOf, { costPerTradeR: cfg.costPerTradeR });
  const all = windows[0] as (typeof windows)[number];
  const tier = assignTier(all.metrics, cfg);
  const labelSetSha256 = sha(loaded.labelIds.join(","));
  const inputSha = sha(JSON.stringify(loaded.signals.map((s) => [s.key, s.at.toISOString(), s.isSignal, s.outcome, s.targetHits, s.dataQuality, s.slPresent, s.slValid, s.revisions, s.adverseSlRevision, s.evidenceConflict])));
  const algorithm = `${SCORECARD_ALGORITHM_VERSION}+${TIER_ALGORITHM_VERSION}`;
  const runKey = sha(JSON.stringify([source.id, o.asOf.toISOString(), algorithm, cfg, labelSetSha256, inputSha, loaded.snapshot]));
  const snapshot = { ...loaded.snapshot, evaluable: all.metrics.evaluable, unverifiable: all.metrics.unverifiable, windows: windows.length };
  const result = (runId: string, created: boolean): RebuildResult => ({ sourceLabel: source.channelLabel, sourceId: source.id, runId, created, tier: tier.tier, evaluable: all.metrics.evaluable });

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(1953725, hashtext(${runKey}))`);
    const [existing] = await tx.select({ id: schema.historicalScorecardRuns.id }).from(schema.historicalScorecardRuns).where(eq(schema.historicalScorecardRuns.runKey, runKey));
    if (existing) return result(existing.id, false);
    const [run] = await tx.insert(schema.historicalScorecardRuns).values({
      runKey, sourceId: source.id, asOf: o.asOf, algorithmVersion: algorithm, config: cfg, configSha256: sha(JSON.stringify(cfg)), labelSetSha256,
      inputSummary: { evaluationRunIds: loaded.evaluationRunIds, datasetRefs: loaded.datasetRefs, labelCount: loaded.labelIds.length, inputSha256: inputSha }, sourceSnapshot: snapshot, createdBy: o.createdBy,
    }).returning({ id: schema.historicalScorecardRuns.id });
    const runId = (run as { id: string }).id;
    await tx.insert(schema.historicalScorecardEvents).values({ runId, eventType: "RUN_STARTED", sequence: 1, detail: { source: source.id, asOf: o.asOf.toISOString() }, createdBy: o.createdBy });
    for (const w of windows) await tx.insert(schema.historicalScorecardMetrics).values({ runId, windowType: w.windowType, windowStart: w.windowStart, windowEnd: w.windowEnd, sampleSize: w.sampleSize, metrics: w.metrics, caveats: w.caveats, createdBy: o.createdBy });
    await tx.insert(schema.historicalTrustTiers).values({
      runId, sourceId: source.id, tier: tier.tier, tierLabel: tier.label, asOf: o.asOf, explanation: tier.rules, metricSnapshot: all.metrics, thresholdConfig: cfg,
      evidenceReferences: { scorecardRunId: runId, labelSetSha256, labelCount: loaded.labelIds.length, evaluationRunIds: loaded.evaluationRunIds, datasetRefs: loaded.datasetRefs, registryIds: [source.id], memberLabels: source.members }, createdBy: o.createdBy,
    });
    await tx.insert(schema.historicalScorecardEvents).values({ runId, eventType: "RUN_COMPLETED", sequence: 2, detail: { tier: tier.tier, evaluable: all.metrics.evaluable, windows: windows.length }, createdBy: o.createdBy });
    return result(runId, true);
  });
}

export async function rebuildAll(db: Db, o: RebuildOptions): Promise<RebuildResult[]> {
  mustActor(o.createdBy);
  await registerSources(db, o.createdBy);
  const out: RebuildResult[] = [];
  for (const s of await canonicalSources(db)) out.push(await rebuildScorecard(db, s, o));
  return out;
}

export interface TierLookup { tier: Tier; label: string; reason: string; asOf: string | null; scorecardRunId: string | null; /** The scorecard algorithm that produced the tier, and whether it is point in time (v2+). A legacy v1 tier is reported with pointInTime false and is not presented as point-in-time. */ algorithmVersion?: string | null; pointInTime?: boolean }
export type SourceIdentity = string | { channelLabel: string };
/**
 * Service function for the future sizing / confidence engine. Returns the latest deterministic tier of a source (an alias resolves to its canonical source). Returns UNKNOWN - never throws and
 * never guesses - when the source is unregistered, has no scorecard, or its scorecard has insufficient evidence. Read-only; no risk decision reads it in this task.
 */
export async function getLatestSourceTrustTier(db: Db, identity: SourceIdentity): Promise<TierLookup> {
  const unknown = (reason: string): TierLookup => ({ tier: "UNKNOWN", label: TIER_LABELS.UNKNOWN, reason, asOf: null, scorecardRunId: null });
  const label = typeof identity === "string" ? identity : identity.channelLabel;
  if (!label) return unknown("SOURCE_NOT_PROVIDED");
  const src = await resolveSource(db, label);
  if (!src) return unknown("SOURCE_NOT_REGISTERED");
  const T = schema.historicalTrustTiers;
  const [t] = await db.select().from(T).where(eq(T.sourceId, src.id)).orderBy(desc(T.asOf), desc(T.createdAt), desc(T.id)).limit(1);
  if (!t) return unknown("NO_SCORECARD");
  const tier = t.tier as Tier;
  const [run] = await db.select({ algorithm: schema.historicalScorecardRuns.algorithmVersion }).from(schema.historicalScorecardRuns).where(eq(schema.historicalScorecardRuns.id, t.runId));
  const pit = isPointInTimeScorecard(run?.algorithm);
  return { tier, label: TIER_LABELS[tier], reason: tier === "UNKNOWN" ? "INSUFFICIENT_EVIDENCE" : pit ? "SCORECARD" : "SCORECARD_LEGACY_NOT_POINT_IN_TIME", asOf: t.asOf.toISOString(), scorecardRunId: t.runId, algorithmVersion: run?.algorithm ?? null, pointInTime: pit };
}

export interface SourceSummary { sourceId: string; channelLabel: string; members: string[]; tier: Tier; tierLabel: string; asOf: string | null; scorecardRunId: string | null; evaluable: number | null; totalEvaluated: number | null; winRateEntered: number | null; netExpectancyR: number | null; grossExpectancyR: number | null; unverifiableRate: number | null; revisionConflictRate: number | null; maxDrawdownR: number | null }
export async function listSources(db: Db): Promise<SourceSummary[]> {
  const out: SourceSummary[] = [];
  for (const s of await canonicalSources(db)) {
    const t = await getLatestSourceTrustTier(db, s.channelLabel);
    let m: Partial<Metrics> = {};
    if (t.scorecardRunId) {
      const [row] = await db.select({ m: schema.historicalTrustTiers.metricSnapshot }).from(schema.historicalTrustTiers).where(eq(schema.historicalTrustTiers.runId, t.scorecardRunId));
      m = (row?.m ?? {}) as Partial<Metrics>;
    }
    out.push({
      sourceId: s.id, channelLabel: s.channelLabel, members: s.members, tier: t.tier, tierLabel: t.label, asOf: t.asOf, scorecardRunId: t.scorecardRunId, evaluable: m.evaluable ?? null, totalEvaluated: m.totalEvaluated ?? null,
      winRateEntered: m.winRateEntered ?? null, netExpectancyR: m.netExpectancyR ?? null, grossExpectancyR: m.grossExpectancyR ?? null, unverifiableRate: m.unverifiableRate ?? null, revisionConflictRate: m.revisionConflictRate ?? null, maxDrawdownR: m.maxDrawdownR ?? null,
    });
  }
  return out;
}

export interface DetailedScorecard { source: CanonicalSource; run: { id: string; asOf: string; algorithmVersion: string; config: unknown; inputSummary: unknown; sourceSnapshot: unknown }; tier: { tier: string; label: string; explanation: unknown; evidenceReferences: unknown }; windows: Array<{ windowType: string; windowStart: string; windowEnd: string; sampleSize: number; metrics: unknown; caveats: unknown }> }
export async function showScorecard(db: Db, label: string): Promise<DetailedScorecard | undefined> {
  const src = await resolveSource(db, label);
  if (!src) return undefined;
  const t = await getLatestSourceTrustTier(db, label);
  if (!t.scorecardRunId) return undefined;
  const [run] = await db.select().from(schema.historicalScorecardRuns).where(eq(schema.historicalScorecardRuns.id, t.scorecardRunId));
  const [tier] = await db.select().from(schema.historicalTrustTiers).where(eq(schema.historicalTrustTiers.runId, t.scorecardRunId));
  const ms = await db.select().from(schema.historicalScorecardMetrics).where(eq(schema.historicalScorecardMetrics.runId, t.scorecardRunId)).orderBy(asc(schema.historicalScorecardMetrics.windowType), asc(schema.historicalScorecardMetrics.windowStart));
  if (!run || !tier) return undefined;
  return {
    source: src, run: { id: run.id, asOf: run.asOf.toISOString(), algorithmVersion: run.algorithmVersion, config: run.config, inputSummary: run.inputSummary, sourceSnapshot: run.sourceSnapshot },
    tier: { tier: tier.tier, label: tier.tierLabel, explanation: tier.explanation, evidenceReferences: tier.evidenceReferences },
    windows: ms.map((m) => ({ windowType: m.windowType, windowStart: m.windowStart.toISOString(), windowEnd: m.windowEnd.toISOString(), sampleSize: m.sampleSize, metrics: m.metrics, caveats: m.caveats })),
  };
}

const CSV_COLUMNS = ["channelLabel", "tier", "tierLabel", "asOf", "evaluable", "totalEvaluated", "winRateEntered", "netExpectancyR", "grossExpectancyR", "unverifiableRate", "revisionConflictRate", "maxDrawdownR"] as const;
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula guard (channel labels are user data)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Safe report: identifiers, tiers and numeric metrics only - no message content, authors or evidence text. */
export async function exportReport(db: Db, format: "json" | "csv"): Promise<string> {
  const rows = await listSources(db);
  const safe = rows.map((r) => Object.fromEntries(CSV_COLUMNS.map((c) => [c, r[c]])));
  if (format === "json") return JSON.stringify(safe, null, 2);
  return [CSV_COLUMNS.join(","), ...safe.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n");
}
