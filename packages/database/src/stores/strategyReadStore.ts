import { sql } from "drizzle-orm";
import type { Db } from "../client";

/**
 * READ-ONLY queries for the strategy intelligence read API (Stage 03): versioned channel playbooks, archived historical cases (for similarity matching) and archived channel scorecards.
 * Nothing here writes. Every list is bounded and deterministically ordered; every timestamp is a timezone-aware instant. These tables hold shared platform intelligence (no owner); what they never hold is raw message text.
 */
type Dbx = Pick<Db, "execute">;
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;
const d = (v: unknown): Date => new Date(v as string);
const dn = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const cap = (x: number, hi: number): number => Math.min(Math.max(Math.trunc(x), 1), hi);

// ── playbooks ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PlaybookSummary { id: string; sourceKind: string; telegramSourceId: string | null; name: string; createdAt: Date; versions: number; activeVersion: number | null; latestVersion: number | null }
export async function listPlaybooks(db: Dbx, o: { telegramSourceId?: string; limit: number; offset: number }): Promise<PlaybookSummary[]> {
  const src = o.telegramSourceId ? sql`and p.telegram_source_id = ${o.telegramSourceId}::uuid` : sql``;
  const r = await db.execute(sql`select p.id, p.source_kind, p.telegram_source_id, p.name, p.created_at,
      (select count(*)::int from playbook_versions v where v.playbook_id = p.id) as versions,
      (select v.version from playbook_versions v where v.playbook_id = p.id and v.state = 'ACTIVE') as active_version,
      (select max(v.version) from playbook_versions v where v.playbook_id = p.id) as latest_version
    from strategy_playbooks p where true ${src} order by p.created_at desc, p.id limit ${cap(o.limit, 200)} offset ${Math.max(0, Math.trunc(o.offset))}`);
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, sourceKind: w["source_kind"] as string, telegramSourceId: (w["telegram_source_id"] ?? null) as string | null, name: w["name"] as string, createdAt: d(w["created_at"]), versions: Number(w["versions"]), activeVersion: n(w["active_version"]), latestVersion: n(w["latest_version"]) }; });
}
export interface PlaybookVersionView { version: number; state: string; sampleSize: number; confidence: number | null; limitations: string; performance: unknown; content: unknown; createdAt: Date; updatedAt: Date; influencesLive: boolean | null; activatedAt: Date | null; events: Array<{ fromState: string | null; toState: string; actor: string; reason: string | null; at: Date }> }
export interface PlaybookDetail { playbook: PlaybookSummary; versions: PlaybookVersionView[]; drift: Array<{ version: number; kind: string; metric: string; baseline: number; observed: number; detectedAt: Date }> }
export async function getPlaybookDetail(db: Dbx, id: string): Promise<PlaybookDetail | null> {
  const [head] = await listPlaybookById(db, id); if (!head) return null;
  const v = await db.execute(sql`select v.version, v.state, v.sample_size, v.confidence::float8 as confidence, v.limitations, v.performance, v.content, v.created_at, v.updated_at, l.id as lv_id, l.influences_live, l.activated_at
    from playbook_versions v left join learning_versions l on l.kind = 'PLAYBOOK' and l.subject_id = v.playbook_id and l.version = v.version where v.playbook_id = ${id}::uuid order by v.version desc`);
  const ev = await db.execute(sql`select l.version, e.from_state, e.to_state, e.actor, e.reason, e.at as at from learning_version_events e join learning_versions l on l.id = e.learning_version_id where l.kind = 'PLAYBOOK' and l.subject_id = ${id}::uuid order by e.at, e.id`);
  const byVersion = new Map<number, PlaybookVersionView["events"]>();
  for (const q of ev.rows) { const w = row(q), k = Number(w["version"]); byVersion.set(k, [...(byVersion.get(k) ?? []), { fromState: (w["from_state"] ?? null) as string | null, toState: w["to_state"] as string, actor: w["actor"] as string, reason: (w["reason"] ?? null) as string | null, at: d(w["at"]) }]); }
  const dr = await db.execute(sql`select version, kind, metric, baseline::float8 as baseline, observed::float8 as observed, detected_at from strategy_drift_events where playbook_id = ${id}::uuid order by detected_at desc, id limit 100`);
  return {
    playbook: head,
    versions: v.rows.map((q) => { const w = row(q), ver = Number(w["version"]); return { version: ver, state: w["state"] as string, sampleSize: Number(w["sample_size"]), confidence: n(w["confidence"]), limitations: w["limitations"] as string, performance: w["performance"] ?? null, content: w["content"], createdAt: d(w["created_at"]), updatedAt: d(w["updated_at"]), influencesLive: w["influences_live"] === null || w["influences_live"] === undefined ? null : w["influences_live"] === true, activatedAt: dn(w["activated_at"]), events: byVersion.get(ver) ?? [] }; }),
    drift: dr.rows.map((q) => { const w = row(q); return { version: Number(w["version"]), kind: w["kind"] as string, metric: w["metric"] as string, baseline: Number(w["baseline"]), observed: Number(w["observed"]), detectedAt: d(w["detected_at"]) }; }),
  };
}
async function listPlaybookById(db: Dbx, id: string): Promise<PlaybookSummary[]> {
  const r = await db.execute(sql`select p.id, p.source_kind, p.telegram_source_id, p.name, p.created_at,
      (select count(*)::int from playbook_versions v where v.playbook_id = p.id) as versions,
      (select v.version from playbook_versions v where v.playbook_id = p.id and v.state = 'ACTIVE') as active_version,
      (select max(v.version) from playbook_versions v where v.playbook_id = p.id) as latest_version from strategy_playbooks p where p.id = ${id}::uuid`);
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, sourceKind: w["source_kind"] as string, telegramSourceId: (w["telegram_source_id"] ?? null) as string | null, name: w["name"] as string, createdAt: d(w["created_at"]), versions: Number(w["versions"]), activeVersion: n(w["active_version"]), latestVersion: n(w["latest_version"]) }; });
}

// ── archived historical cases ───────────────────────────────────────────────────────────────────────────────────────
export interface HistoricalCaseRow { caseId: string; messageTimestamp: Date; channelLabel: string; originalMessageId: string; revisionNo: number; underlying: string | null; entry: unknown; stopLoss: number | null; targets: unknown; expiryDate: string | null; finalOutcome: string; slFirstTouchAt: Date | null; targetEvaluations: unknown; labelledAt: Date }
/**
 * Labelled archived signals whose MESSAGE TIME is strictly before `before`, newest first, bounded. The most recent label per record is used. Nothing after `before` is returned, so a caller asking "as of T" can never receive a later message;
 * whether an OUTCOME was already known at T is decided by the caller from the resolution times returned here (see the similarity matcher).
 */
export async function listHistoricalCaseRows(db: Dbx, o: { before: Date; limit: number }): Promise<HistoricalCaseRow[]> {
  const r = await db.execute(sql`select n.id as case_id, s.message_timestamp, s.channel_label, s.original_message_id, s.revision_no, n.underlying, n.entry, n.stop_loss::float8 as stop_loss, n.targets, n.expiry_date::text as expiry_date,
      l.final_outcome, l.sl_first_touch_at, l.target_evaluations, l.created_at as labelled_at
    from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id
    join lateral (select x.* from historical_outcome_labels x where x.normalized_record_id = n.id order by x.created_at desc, x.id limit 1) l on true
    where n.parse_status = 'OPTIONS_CLAIM' and s.message_timestamp < ${o.before.toISOString()}::timestamptz
    order by s.message_timestamp desc, n.id limit ${cap(o.limit, 5000)}`);
  return r.rows.map((q) => { const w = row(q); return { caseId: w["case_id"] as string, messageTimestamp: d(w["message_timestamp"]), channelLabel: w["channel_label"] as string, originalMessageId: w["original_message_id"] as string, revisionNo: Number(w["revision_no"]), underlying: (w["underlying"] ?? null) as string | null, entry: w["entry"] ?? null, stopLoss: n(w["stop_loss"]), targets: w["targets"] ?? [], expiryDate: (w["expiry_date"] ?? null) as string | null, finalOutcome: w["final_outcome"] as string, slFirstTouchAt: dn(w["sl_first_touch_at"]), targetEvaluations: w["target_evaluations"] ?? [], labelledAt: d(w["labelled_at"]) }; });
}

// ── archived channel scorecards ─────────────────────────────────────────────────────────────────────────────────────
export interface ArchiveScorecard { sourceId: string; channelLabel: string; asOf: Date; algorithmVersion: string; trustTier: { tier: string; label: string } | null; metrics: Array<{ windowType: string; windowStart: Date; windowEnd: Date; sampleSize: number; metrics: unknown; caveats: unknown }>; sourceSnapshot: unknown }
/** The latest scorecard run of each archived channel identity (imported history), with its window metrics and trust tier. This is ARCHIVE evidence keyed by the archive's channel label; it is not linked to live channels. */
export async function listArchiveScorecards(db: Dbx, o: { limit: number; offset: number }): Promise<ArchiveScorecard[]> {
  const runs = await db.execute(sql`select * from (select distinct on (r.source_id) r.id as run_id, r.source_id, r.as_of, r.algorithm_version, r.source_snapshot, g.channel_label
      from historical_scorecard_runs r join historical_source_registry g on g.id = r.source_id order by r.source_id, r.as_of desc, r.id) latest order by latest.channel_label, latest.source_id limit ${cap(o.limit, 100)} offset ${Math.max(0, Math.trunc(o.offset))}`);
  const out: ArchiveScorecard[] = [];
  for (const q of runs.rows) {
    const w = row(q), runId = w["run_id"] as string;
    const m = await db.execute(sql`select window_type, window_start, window_end, sample_size, metrics, caveats from historical_scorecard_metrics where run_id = ${runId}::uuid order by window_type, window_start`);
    const t = await db.execute(sql`select tier, tier_label from historical_trust_tiers where run_id = ${runId}::uuid`);
    const tr = t.rows[0] ? row(t.rows[0]) : null;
    out.push({ sourceId: w["source_id"] as string, channelLabel: w["channel_label"] as string, asOf: d(w["as_of"]), algorithmVersion: w["algorithm_version"] as string, trustTier: tr ? { tier: tr["tier"] as string, label: tr["tier_label"] as string } : null, metrics: m.rows.map((x) => { const y = row(x); return { windowType: y["window_type"] as string, windowStart: d(y["window_start"]), windowEnd: d(y["window_end"]), sampleSize: Number(y["sample_size"]), metrics: y["metrics"], caveats: y["caveats"] }; }), sourceSnapshot: w["source_snapshot"] });
  }
  return out;
}

// ── live channel funnel (what the pipeline did with a channel's claims) ───────────────────────────────────────────────
export interface ChannelFunnel { claims: { claim: number; ambiguous: number; unsupported: number }; candidacy: Record<string, number>; candidates: Record<string, number>; firstClaimAt: Date | null; lastClaimAt: Date | null }
export async function getChannelFunnel(db: Dbx, sourceId: string, policyVersion: string): Promise<ChannelFunnel> {
  const a = row((await db.execute(sql`select count(*) filter (where c.result_kind = 'claim')::int as claim, count(*) filter (where c.result_kind = 'ambiguous')::int as ambiguous, count(*) filter (where c.result_kind = 'unsupported')::int as unsupported, min(m.message_timestamp) as first_at, max(m.message_timestamp) as last_at
    from options_claims c join telegram_messages m on m.id = c.telegram_message_id where m.telegram_source_id = ${sourceId}::uuid`)).rows[0] ?? {});
  const b = (await db.execute(sql`select k.outcome, count(*)::int as n from telegram_claim_candidacy k join options_claims c on c.id = k.claim_id join telegram_messages m on m.id = c.telegram_message_id where m.telegram_source_id = ${sourceId}::uuid and k.policy_version = ${policyVersion} group by k.outcome`)).rows.map(row);
  const c = (await db.execute(sql`select o.state, count(*)::int as n from opportunity_candidates o join options_claims c on c.id = o.claim_id join telegram_messages m on m.id = c.telegram_message_id where o.source = 'TELEGRAM' and m.telegram_source_id = ${sourceId}::uuid group by o.state`)).rows.map(row);
  return { claims: { claim: Number(a["claim"] ?? 0), ambiguous: Number(a["ambiguous"] ?? 0), unsupported: Number(a["unsupported"] ?? 0) }, candidacy: Object.fromEntries(b.map((x) => [x["outcome"] as string, Number(x["n"])])), candidates: Object.fromEntries(c.map((x) => [x["state"] as string, Number(x["n"])])), firstClaimAt: dn(a["first_at"]), lastClaimAt: dn(a["last_at"]) };
}
