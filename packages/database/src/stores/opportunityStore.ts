import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { opportunityCandidateEvents, opportunityCandidates, opportunityScans } from "../schema/intelligence";

/**
 * Persistence for the Independent Opportunity Engine (Master Build Stage 05). Writes ONLY opportunity_scans and opportunity_candidates (the database trigger writes the lifecycle history).
 * The lifecycle itself is enforced by the database (migration 0036): legal transitions only, an immutable thesis, finished states final. Every state change here is a guarded UPDATE keyed on the expected current
 * state, so a candidate that was ended while a worker held it (superseded, invalidated, expired) is left alone instead of being resurrected.
 */
type Dbx = Pick<Db, "execute" | "select" | "insert" | "transaction">;
const iso = (d: Date): string => d.toISOString();
export const ACTIVE_CANDIDATE_STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION"] as const;

// ─── scans ──────────────────────────────────────────────────────────────────
export type BeginScan = { scanId: string; state: "STARTED" | "RESTARTED" | "ALREADY_COMPLETED" | "IN_PROGRESS" };
/** Idempotent per (scan kind, slot): the same slot delivered twice scans once. A FAILED slot is retried; a RUNNING slot is left alone until its lease passes (a crashed worker's slot is then taken over). */
export async function beginScan(db: Dbx, o: { scanKind: string; slotKey: string; parameters: unknown; detectorVersion: string; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; now: Date; leaseMs: number }): Promise<BeginScan> {
  const [ins] = await db.insert(opportunityScans).values({ scanKind: o.scanKind, slotKey: o.slotKey, parameters: o.parameters, detectorVersion: o.detectorVersion, dataSource: o.dataSource, startedAt: o.now }).onConflictDoNothing().returning({ id: opportunityScans.id });
  if (ins) return { scanId: ins.id, state: "STARTED" };
  const [ex] = await db.select().from(opportunityScans).where(and(eq(opportunityScans.scanKind, o.scanKind), eq(opportunityScans.slotKey, o.slotKey)));
  if (!ex) throw new Error("the scan slot vanished");
  if (ex.status === "COMPLETED") return { scanId: ex.id, state: "ALREADY_COMPLETED" };
  const stale = o.now.getTime() - ex.startedAt.getTime() > o.leaseMs;
  if (ex.status === "RUNNING" && !stale) return { scanId: ex.id, state: "IN_PROGRESS" };
  // FAILED, or RUNNING past its lease: take it over, but only if nobody else did first
  const r = await db.execute(sql`update opportunity_scans set status = 'RUNNING', started_at = ${iso(o.now)}::timestamptz, completed_at = null, error_kind = null where id = ${ex.id} and status = ${ex.status} and started_at = ${iso(ex.startedAt)}::timestamptz returning id`);
  return r.rows.length > 0 ? { scanId: ex.id, state: "RESTARTED" } : { scanId: ex.id, state: "IN_PROGRESS" };
}
export async function completeScan(db: Dbx, scanId: string, o: { candidateCount: number; universeSize: number; skipped: unknown; now: Date }): Promise<void> {
  await db.execute(sql`update opportunity_scans set status = 'COMPLETED', candidate_count = ${o.candidateCount}, universe_size = ${o.universeSize}, skipped = ${JSON.stringify(o.skipped)}::jsonb, completed_at = ${iso(o.now)}::timestamptz where id = ${scanId} and status = 'RUNNING'`);
}
export async function failScan(db: Dbx, scanId: string, o: { errorKind: string; universeSize: number; skipped: unknown; now: Date }): Promise<void> {
  await db.execute(sql`update opportunity_scans set status = 'FAILED', error_kind = ${o.errorKind}, universe_size = ${o.universeSize}, skipped = ${JSON.stringify(o.skipped)}::jsonb, completed_at = ${iso(o.now)}::timestamptz where id = ${scanId} and status = 'RUNNING'`);
}

// ─── candidates ─────────────────────────────────────────────────────────────
export interface CandidateInsert {
  dedupeKey: string; underlying: string; exchange: string; side: "BUY" | "SELL"; setup: string; entryKind: "above" | "below" | "at" | "range" | "market"; entryLow: number | null; entryHigh: number | null;
  stopLoss: number; targets: readonly number[]; invalidation: unknown; rankScore: number; evidence: readonly unknown[]; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; correlationId: string; createdAt: Date; expiresAt: Date;
}
/** Inserts the scan's candidates. The unique dedupe key makes a repeat of the same setup a no-op; a NEW setup supersedes older active INDEPENDENT candidates of the same instrument, setup and side (the old thesis names its successor). */
export async function insertScanCandidates(db: Pick<Db, "transaction">, scanId: string, drafts: readonly CandidateInsert[]): Promise<{ created: string[]; duplicates: number; superseded: number }> {
  return db.transaction(async (tx) => {
    const created: string[] = []; let duplicates = 0, superseded = 0;
    for (const d of drafts) {
      const [row] = await tx.insert(opportunityCandidates).values({
        source: "INDEPENDENT", scanId, underlying: d.underlying, exchange: d.exchange, side: d.side, entryKind: d.entryKind, entryLow: d.entryLow === null ? null : String(d.entryLow), entryHigh: d.entryHigh === null ? null : String(d.entryHigh),
        stopLoss: String(d.stopLoss), targets: [...d.targets], setup: d.setup, evidence: [...d.evidence], dataSource: d.dataSource, correlationId: d.correlationId, createdAt: d.createdAt, expiresAt: d.expiresAt,
        dedupeKey: d.dedupeKey, invalidation: d.invalidation, rankScore: String(d.rankScore),
      }).onConflictDoNothing({ target: opportunityCandidates.dedupeKey }).returning({ id: opportunityCandidates.id });
      if (!row) { duplicates++; continue; }
      created.push(row.id);
      const r = await tx.execute(sql`update opportunity_candidates set state = 'SUPERSEDED', superseded_by = ${row.id}, state_reason = 'SUPERSEDED_BY_NEWER_SETUP', updated_at = ${iso(d.createdAt)}::timestamptz
        where source = 'INDEPENDENT' and underlying = ${d.underlying} and exchange = ${d.exchange} and side = ${d.side} and setup is not distinct from ${d.setup} and id <> ${row.id}
          and created_at < ${iso(d.createdAt)}::timestamptz and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') returning id`);
      superseded += r.rows.length;
    }
    return { created, duplicates, superseded };
  });
}

export interface StoredCandidate {
  id: string; source: "TELEGRAM" | "INDEPENDENT"; state: string; underlying: string; exchange: string; strike: number | null; optionType: "CE" | "PE" | null; expiry: string | null; side: "BUY" | "SELL";
  entryKind: "above" | "below" | "at" | "range" | "market"; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL";
  createdAt: Date; expiresAt: Date; attempts: number; invalidation: unknown; lastValidatedAt: Date | null; rankScore: number | null; setup: string | null; stateReason: string | null; supersededBy: string | null;
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
function fromRaw(r: Record<string, unknown>): StoredCandidate {
  return {
    id: r["id"] as string, source: r["source"] as StoredCandidate["source"], state: r["state"] as string, underlying: r["underlying"] as string, exchange: r["exchange"] as string, strike: num(r["strike"]),
    optionType: (r["option_type"] ?? null) as StoredCandidate["optionType"], expiry: r["expiry"] === null || r["expiry"] === undefined ? null : r["expiry"] instanceof Date ? r["expiry"].toISOString().slice(0, 10) : String(r["expiry"]).slice(0, 10),
    side: r["side"] as "BUY" | "SELL", entryKind: r["entry_kind"] as StoredCandidate["entryKind"], entryLow: num(r["entry_low"]), entryHigh: num(r["entry_high"]), stopLoss: num(r["stop_loss"]),
    targets: Array.isArray(r["targets"]) ? (r["targets"] as unknown[]).map(Number).filter(Number.isFinite) : [], dataSource: r["data_source"] as StoredCandidate["dataSource"],
    createdAt: date(r["created_at"]), expiresAt: date(r["expires_at"]), attempts: Number(r["research_attempts"] ?? 0), invalidation: r["invalidation"] ?? null,
    lastValidatedAt: r["last_validated_at"] ? date(r["last_validated_at"]) : null, rankScore: num(r["rank_score"]), setup: (r["setup"] ?? null) as string | null, stateReason: (r["state_reason"] ?? null) as string | null, supersededBy: (r["superseded_by"] ?? null) as string | null,
  };
}
const COLS = sql`id, source, state, underlying, exchange, strike, option_type, expiry, side, entry_kind, entry_low, entry_high, stop_loss, targets, data_source, created_at, expires_at, research_attempts, invalidation, last_validated_at, rank_score, setup, state_reason, superseded_by`;

export async function getCandidate(db: Pick<Db, "execute">, id: string): Promise<StoredCandidate | null> {
  const r = await db.execute(sql`select ${COLS} from opportunity_candidates where id = ${id}`);
  return r.rows[0] ? fromRaw(r.rows[0] as Record<string, unknown>) : null;
}
/** `underlyings` optionally scopes the listing / queue to those instruments (used to run one universe in isolation). */
export interface CandidateScope { underlyings?: readonly string[] }
const scopeSql = (scope?: CandidateScope) => { const l = scope?.underlyings ? scope.underlyings.join(",") : null; return sql`(${l}::text is null or underlying = any(string_to_array(${l}::text, ',')))`; };
export async function listCandidates(db: Pick<Db, "execute">, o: { states?: readonly string[]; source?: "TELEGRAM" | "INDEPENDENT"; limit: number; offset?: number; scope?: CandidateScope }): Promise<StoredCandidate[]> {
  const st = o.states?.length ? sql`and state in (${sql.join(o.states.map((s) => sql`${s}`), sql`, `)})` : sql``;
  const src = o.source ? sql`and source = ${o.source}` : sql``;
  const r = await db.execute(sql`select ${COLS} from opportunity_candidates where ${scopeSql(o.scope)} ${st} ${src} order by created_at desc, id limit ${Math.min(Math.max(o.limit, 1), 200)} offset ${Math.min(Math.max(o.offset ?? 0, 0), 100_000)}`);
  return r.rows.map((x) => fromRaw(x as Record<string, unknown>));
}
export async function listCandidateEvents(db: Pick<Db, "select">, candidateId: string): Promise<Array<{ fromState: string | null; toState: string; reason: string | null; occurredAt: Date }>> {
  return db.select({ fromState: opportunityCandidateEvents.fromState, toState: opportunityCandidateEvents.toState, reason: opportunityCandidateEvents.reason, occurredAt: opportunityCandidateEvents.occurredAt })
    .from(opportunityCandidateEvents).where(eq(opportunityCandidateEvents.candidateId, candidateId)).orderBy(desc(opportunityCandidateEvents.occurredAt));
}

/** Records the result of a revalidation. VALID refreshes `last_validated_at`; INVALIDATED / EXPIRED end the candidate with a reason; UNVERIFIABLE changes nothing (an unverifiable candidate is never refreshed). Returns whether a row changed. */
export async function applyRevalidation(db: Pick<Db, "execute">, id: string, r: { outcome: "VALID" | "INVALIDATED" | "EXPIRED" | "UNVERIFIABLE"; reason: string }, now: Date): Promise<boolean> {
  if (r.outcome === "UNVERIFIABLE") return false;
  if (r.outcome === "VALID") { const x = await db.execute(sql`update opportunity_candidates set last_validated_at = ${iso(now)}::timestamptz, updated_at = ${iso(now)}::timestamptz where id = ${id} and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') returning id`); return x.rows.length > 0; }
  const x = await db.execute(sql`update opportunity_candidates set state = ${r.outcome}, state_reason = ${r.reason}, updated_at = ${iso(now)}::timestamptz where id = ${id} and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') returning id`);
  return x.rows.length > 0;
}
export async function withdrawCandidate(db: Pick<Db, "execute">, id: string, reason: string, now: Date): Promise<boolean> {
  const x = await db.execute(sql`update opportunity_candidates set state = 'WITHDRAWN', state_reason = ${reason.slice(0, 200)}, updated_at = ${iso(now)}::timestamptz where id = ${id} and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') returning id`);
  return x.rows.length > 0;
}

// ─── the research queue (the database implementation of the dispatcher's port) ─
export function createCandidateQueue(db: Pick<Db, "execute">, scope?: CandidateScope) {
  return {
    async expireDue(now: Date): Promise<number> {
      const r = await db.execute(sql`update opportunity_candidates set state = 'EXPIRED', state_reason = 'PAST_EXPIRY', updated_at = ${iso(now)}::timestamptz where state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') and expires_at <= ${iso(now)}::timestamptz and ${scopeSql(scope)} returning id`);
      return r.rows.length;
    },
    async recoverStale(now: Date, leaseMs: number, maxAttempts: number): Promise<number> {
      const cutoff = new Date(now.getTime() - leaseMs);
      const r = await db.execute(sql`update opportunity_candidates set
          state = case when research_attempts + 1 >= ${maxAttempts} then 'WITHDRAWN' else 'NEW' end,
          research_attempts = research_attempts + 1,
          state_reason = case when research_attempts + 1 >= ${maxAttempts} then 'RESEARCH_LEASE_LOST_MAX_ATTEMPTS' else 'RESEARCH_LEASE_LOST' end,
          updated_at = ${iso(now)}::timestamptz
        where state = 'IN_RESEARCH' and updated_at < ${iso(cutoff)}::timestamptz and ${scopeSql(scope)} returning id`);
      return r.rows.length;
    },
    async claimNext(now: Date, exclude: readonly string[] = []): Promise<(Omit<StoredCandidate, "state" | "targets"> & { targets: number[]; expiresAt: Date; attempts: number; id: string }) | null> {
      const r = await db.execute(sql`update opportunity_candidates set state = 'IN_RESEARCH', state_reason = null, updated_at = ${iso(now)}::timestamptz
        where id = (select id from opportunity_candidates where state = 'NEW' and expires_at > ${iso(now)}::timestamptz and id <> all(string_to_array(${exclude.join(",")}, ',')::uuid[]) and ${scopeSql(scope)} order by rank_score desc nulls last, created_at asc, id for update skip locked limit 1)
        returning ${COLS}`);
      return r.rows[0] ? fromRaw(r.rows[0] as Record<string, unknown>) : null;
    },
    async complete(id: string): Promise<void> {
      await db.execute(sql`update opportunity_candidates set state = 'READY_FOR_DECISION', state_reason = null, updated_at = now() where id = ${id} and state = 'IN_RESEARCH'`);
    },
    async release(id: string, reason: string, o: { count: boolean; maxAttempts: number }): Promise<"RETRY" | "WITHDRAWN"> {
      const r = await db.execute(sql`update opportunity_candidates set
          state = case when ${o.count} and research_attempts + 1 >= ${o.maxAttempts} then 'WITHDRAWN' else 'NEW' end,
          research_attempts = research_attempts + (case when ${o.count} then 1 else 0 end),
          state_reason = ${reason}, updated_at = now()
        where id = ${id} and state = 'IN_RESEARCH' returning state`);
      return (r.rows[0] as { state?: string } | undefined)?.state === "NEW" ? "RETRY" : "WITHDRAWN";
    },
    async expire(id: string, reason: string): Promise<void> {
      await db.execute(sql`update opportunity_candidates set state = 'EXPIRED', state_reason = ${reason}, updated_at = now() where id = ${id} and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION')`);
    },
  };
}

/** Recent scans, newest first (deterministic: started_at then id): the slot, status, counts and the recorded skip reasons. Read-only. */
export interface StoredScan { id: string; scanKind: string; slotKey: string | null; status: string; dataSource: string; detectorVersion: string; universeSize: number; candidateCount: number; errorKind: string | null; skipped: unknown; parameters: unknown; startedAt: Date; completedAt: Date | null }
export async function listScans(db: Pick<Db, "execute">, o: { limit: number; offset?: number }): Promise<StoredScan[]> {
  const r = await db.execute(sql`select id, scan_kind, slot_key, status, data_source, detector_version, universe_size, candidate_count, error_kind, skipped, parameters, started_at, completed_at from opportunity_scans order by started_at desc, id limit ${Math.min(Math.max(o.limit, 1), 200)} offset ${Math.min(Math.max(o.offset ?? 0, 0), 100_000)}`);
  return r.rows.map((x) => { const w = x as Record<string, unknown>; return { id: w["id"] as string, scanKind: w["scan_kind"] as string, slotKey: (w["slot_key"] ?? null) as string | null, status: w["status"] as string, dataSource: w["data_source"] as string, detectorVersion: w["detector_version"] as string, universeSize: Number(w["universe_size"]), candidateCount: Number(w["candidate_count"]), errorKind: (w["error_kind"] ?? null) as string | null, skipped: w["skipped"], parameters: w["parameters"], startedAt: date(w["started_at"]), completedAt: w["completed_at"] ? date(w["completed_at"]) : null }; });
}
/** The evidence recorded on a candidate (setup, rank factors, reward:risk screen, provenance). Parsed fields only. */
export async function getCandidateEvidence(db: Pick<Db, "execute">, id: string): Promise<unknown | null> {
  const r = await db.execute(sql`select evidence from opportunity_candidates where id = ${id}`);
  return r.rows[0] ? (r.rows[0] as Record<string, unknown>)["evidence"] ?? null : null;
}

