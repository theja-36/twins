import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { opportunityCandidates, telegramClaimCandidacy } from "../schema/intelligence";

/**
 * Persistence for the Telegram claim -> candidate pipeline (Stage 03, G-19). Writes ONLY opportunity_candidates (source TELEGRAM) and telegram_claim_candidacy (append-only audit). Reads the stored claims, their messages and the channel's active candidates.
 * It never touches decisions, risk, capital or execution tables. The database refuses a Telegram candidate that does not rest on a stored parsed claim (migration 0042) and the candidate lifecycle trigger audits every state change.
 */
type Dbx = Pick<Db, "execute" | "transaction">;
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;
const d = (v: unknown): Date => new Date(v as string);
const dn = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));

export interface PendingClaim {
  claimId: string; parserVersion: string; claim: unknown; messageId: string; sourceId: string; externalMessageId: string; originMessageId: string | null; messageTimestamp: Date; receivedAt: Date; observedAt: Date | null;
  firstSeenEdited: boolean; captureMethod: string; editDate: Date | null;
  /** Read for the classifier's fixed word cues only; never stored by the pipeline. */
  rawText: string;
}
/** Parsed claims that have no candidacy decision under this policy version yet, oldest message first, bounded. Only `result_kind = 'claim'`: noise, ambiguous and unsupported messages are never read here. */
export async function listPendingClaims(db: Pick<Db, "execute">, o: { policyVersion: string; since: Date; limit: number; sourceIds?: readonly string[] }): Promise<PendingClaim[]> {
  const scope = o.sourceIds ? sql`and m.telegram_source_id = any(string_to_array(${o.sourceIds.join(",")}, ',')::uuid[])` : sql``;
  const r = await db.execute(sql`select c.id as claim_id, c.parser_version, c.claim, m.id as message_id, m.telegram_source_id, m.external_message_id, m.origin_message_id, m.message_timestamp, m.received_at, m.observed_at, m.first_seen_edited, m.capture_method, m.edit_date, m.raw_text
    from options_claims c join telegram_messages m on m.id = c.telegram_message_id
    where c.result_kind = 'claim' and m.message_timestamp >= ${o.since.toISOString()}::timestamptz
      and not exists (select 1 from telegram_claim_candidacy k where k.claim_id = c.id and k.policy_version = ${o.policyVersion}) ${scope}
    order by m.message_timestamp, c.id limit ${Math.min(Math.max(o.limit, 1), 500)}`);
  return r.rows.map((q) => { const w = row(q); return { claimId: w["claim_id"] as string, parserVersion: w["parser_version"] as string, claim: w["claim"], messageId: w["message_id"] as string, sourceId: w["telegram_source_id"] as string, externalMessageId: w["external_message_id"] as string, originMessageId: (w["origin_message_id"] ?? null) as string | null, messageTimestamp: d(w["message_timestamp"]), receivedAt: d(w["received_at"]), observedAt: dn(w["observed_at"]), firstSeenEdited: w["first_seen_edited"] === true, captureMethod: w["capture_method"] as string, editDate: dn(w["edit_date"]), rawText: w["raw_text"] as string }; });
}
export interface ActiveRow { id: string; claimId: string; sourceId: string; externalMessageId: string; originMessageId: string | null; underlying: string; strike: number | null; optionType: string | null; side: string; entryKind: string; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; candidateVersion: number; messageTimestamp: Date; claim: unknown }
/** Active Telegram candidates of one channel created from claims no older than `since` (for duplicate, contradiction and edit-supersession decisions). */
export async function listActiveTelegramCandidates(db: Pick<Db, "execute">, o: { sourceId: string; since: Date }): Promise<ActiveRow[]> {
  const r = await db.execute(sql`select k.id, k.claim_id, m.telegram_source_id, m.external_message_id, m.origin_message_id, k.underlying, k.strike::float8 as strike, k.option_type, k.side, k.entry_kind, k.entry_low::float8 as entry_low, k.entry_high::float8 as entry_high, k.stop_loss::float8 as stop_loss, k.targets, k.candidate_version, m.message_timestamp, c.claim
    from opportunity_candidates k join options_claims c on c.id = k.claim_id join telegram_messages m on m.id = c.telegram_message_id
    where k.source = 'TELEGRAM' and k.state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') and m.telegram_source_id = ${o.sourceId}::uuid and m.message_timestamp >= ${o.since.toISOString()}::timestamptz`);
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, claimId: w["claim_id"] as string, sourceId: w["telegram_source_id"] as string, externalMessageId: w["external_message_id"] as string, originMessageId: (w["origin_message_id"] ?? null) as string | null, underlying: w["underlying"] as string, strike: n(w["strike"]), optionType: (w["option_type"] ?? null) as string | null, side: w["side"] as string, entryKind: w["entry_kind"] as string, entryLow: n(w["entry_low"]), entryHigh: n(w["entry_high"]), stopLoss: n(w["stop_loss"]), targets: ((w["targets"] ?? []) as unknown[]).map(Number), candidateVersion: Number(w["candidate_version"]), messageTimestamp: d(w["message_timestamp"]), claim: w["claim"] }; });
}

export interface CandidateDraftRow {
  claimId: string; underlying: string; exchange: string; strike: number; optionType: "CE" | "PE"; expiry: string | null; side: "BUY"; entryKind: "above" | "below" | "at" | "range" | "market"; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[];
  setup: string | null; timeframe: string; classificationConfidence: number | null; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; expiresAt: Date; thesis: string; missingInformation: string[]; validationStatus: "UNVERIFIED"; candidateVersion: number; evidence: unknown[]; provenance: Record<string, unknown>;
}
export interface CandidacyRecord { claimId: string; policyVersion: string; outcome: "CREATED" | "DUPLICATE" | "EXPIRED" | "SUPERSEDED_REVISION" | "INCOMPLETE" | "CONTRADICTORY" | "UNSUPPORTED"; reasons: string[]; detail: Record<string, unknown>; draft?: CandidateDraftRow; supersedes?: string[]; duplicateOf?: string; now: Date }
export interface CandidacyResult { recorded: boolean; candidateId: string | null; created: boolean; superseded: number }
const str = (v: number | null): string | null => (v === null ? null : String(v));

/**
 * Records ONE candidacy decision atomically: the candidate (when the outcome is CREATED), the supersession of the candidates of earlier revisions of the same message, and the append-only audit row.
 * Idempotent and safe under concurrency: the candidate is unique per claim (a second worker finds it) and the audit row is unique per (claim, policy version).
 */
export async function recordCandidacy(db: Dbx, r: CandidacyRecord): Promise<CandidacyResult> {
  return db.transaction(async (tx) => {
    let candidateId: string | null = r.duplicateOf ?? null, created = false, superseded = 0;
    if (r.outcome === "CREATED") {
      const x = r.draft; if (!x) throw new Error("a CREATED candidacy needs its draft");
      const [ins] = await tx.insert(opportunityCandidates).values({
        source: "TELEGRAM", claimId: x.claimId, underlying: x.underlying, exchange: x.exchange, strike: String(x.strike), optionType: x.optionType, expiry: x.expiry, side: x.side, entryKind: x.entryKind, entryLow: str(x.entryLow), entryHigh: str(x.entryHigh), stopLoss: str(x.stopLoss), targets: [...x.targets],
        setup: x.setup, classificationConfidence: str(x.classificationConfidence), evidence: [...x.evidence], dataSource: x.dataSource, correlationId: randomUUID(), createdAt: r.now, expiresAt: x.expiresAt, timeframe: x.timeframe, thesis: x.thesis, missingInformation: [...x.missingInformation], validationStatus: x.validationStatus, provenance: x.provenance, candidateVersion: x.candidateVersion,
      }).onConflictDoNothing({ target: opportunityCandidates.claimId }).returning({ id: opportunityCandidates.id });
      if (ins) {
        created = true; candidateId = ins.id;
        for (const old of r.supersedes ?? []) {
          const u = await tx.execute(sql`update opportunity_candidates set state = 'SUPERSEDED', superseded_by = ${ins.id}::uuid, state_reason = 'MESSAGE_EDITED', updated_at = ${r.now.toISOString()}::timestamptz where id = ${old}::uuid and source = 'TELEGRAM' and state in ('NEW', 'IN_RESEARCH', 'READY_FOR_DECISION') returning id`);
          superseded += u.rows.length;
        }
      } else {
        const ex = await tx.execute(sql`select id from opportunity_candidates where claim_id = ${x.claimId}::uuid`); candidateId = ((ex.rows[0] ?? {}) as { id?: string }).id ?? null;
        if (!candidateId) throw new Error("the candidate vanished");
      }
    }
    const [k] = await tx.insert(telegramClaimCandidacy).values({ claimId: r.claimId, policyVersion: r.policyVersion, outcome: r.outcome, reasonCodes: r.reasons, candidateId, detail: r.detail, evaluatedAt: r.now }).onConflictDoNothing({ target: [telegramClaimCandidacy.claimId, telegramClaimCandidacy.policyVersion] }).returning({ id: telegramClaimCandidacy.id });
    return { recorded: !!k, candidateId, created, superseded };
  });
}

export interface PipelineStatus { claimsTotal: number; claimsParsed: number; byOutcome: Record<string, number>; candidates: Record<string, number>; oldestPendingMinutes: number | null }
/** Counts for the pipeline status view: parsed claims, candidacy outcomes and Telegram candidates by state. */
export async function telegramPipelineStatus(db: Pick<Db, "execute">, policyVersion: string, now: Date): Promise<PipelineStatus> {
  const a = row((await db.execute(sql`select count(*)::int as total, count(*) filter (where result_kind = 'claim')::int as parsed from options_claims`)).rows[0]);
  const b = (await db.execute(sql`select outcome, count(*)::int as n from telegram_claim_candidacy where policy_version = ${policyVersion} group by outcome`)).rows.map(row);
  const c = (await db.execute(sql`select state, count(*)::int as n from opportunity_candidates where source = 'TELEGRAM' group by state`)).rows.map(row);
  const p = row((await db.execute(sql`select min(m.message_timestamp) as oldest from options_claims o join telegram_messages m on m.id = o.telegram_message_id where o.result_kind = 'claim' and not exists (select 1 from telegram_claim_candidacy k where k.claim_id = o.id and k.policy_version = ${policyVersion})`)).rows[0] ?? {});
  const oldest = p["oldest"] ? Math.max(0, Math.round((now.getTime() - new Date(p["oldest"] as string).getTime()) / 60_000)) : null;
  return { claimsTotal: Number(a["total"]), claimsParsed: Number(a["parsed"]), byOutcome: Object.fromEntries(b.map((x) => [x["outcome"] as string, Number(x["n"])])), candidates: Object.fromEntries(c.map((x) => [x["state"] as string, Number(x["n"])])), oldestPendingMinutes: oldest };
}

// ── read models for the intelligence API (Stage 03, section J). Parsed fields and counts only: no raw message text, no payload. ──────────────────────────────────────────────────────────────────
export interface ChannelOverview { id: string; identifier: string; name: string | null; messages: number; messages24h: number; claims: { claim: number; ambiguous: number; unsupported: number }; candidates: Record<string, number>; firstMessageAt: Date | null; lastMessageAt: Date | null; delayedShare24h: number | null; medianCaptureDelaySeconds24h: number | null }
export async function listChannelOverview(db: Pick<Db, "execute">, now: Date, o: { id?: string; limit: number }): Promise<ChannelOverview[]> {
  const iso = now.toISOString(), one = o.id ? sql`and s.id = ${o.id}::uuid` : sql``;
  const r = await db.execute(sql`select s.id, s.channel_identifier, s.display_name,
      (select count(*)::int from telegram_messages m where m.telegram_source_id = s.id) as messages,
      (select count(*)::int from telegram_messages m where m.telegram_source_id = s.id and m.message_timestamp >= ${iso}::timestamptz - interval '24 hours') as messages_24h,
      (select min(m.message_timestamp) from telegram_messages m where m.telegram_source_id = s.id) as first_at,
      (select max(m.message_timestamp) from telegram_messages m where m.telegram_source_id = s.id) as last_at,
      (select count(*) filter (where c.result_kind = 'claim')::int from options_claims c join telegram_messages m on m.id = c.telegram_message_id where m.telegram_source_id = s.id) as claims_claim,
      (select count(*) filter (where c.result_kind = 'ambiguous')::int from options_claims c join telegram_messages m on m.id = c.telegram_message_id where m.telegram_source_id = s.id) as claims_ambiguous,
      (select count(*) filter (where c.result_kind = 'unsupported')::int from options_claims c join telegram_messages m on m.id = c.telegram_message_id where m.telegram_source_id = s.id) as claims_unsupported,
      (select jsonb_object_agg(x.state, x.n) from (select k.state, count(*)::int as n from opportunity_candidates k join options_claims c on c.id = k.claim_id join telegram_messages m on m.id = c.telegram_message_id where k.source = 'TELEGRAM' and m.telegram_source_id = s.id group by k.state) x) as candidates,
      (select (count(*) filter (where extract(epoch from (coalesce(m.observed_at, m.received_at) - m.message_timestamp)) > 600))::float8 / nullif(count(*), 0) from telegram_messages m where m.telegram_source_id = s.id and m.message_timestamp >= ${iso}::timestamptz - interval '24 hours') as delayed_share,
      (select percentile_cont(0.5) within group (order by extract(epoch from (coalesce(m.observed_at, m.received_at) - m.message_timestamp))) from telegram_messages m where m.telegram_source_id = s.id and m.message_timestamp >= ${iso}::timestamptz - interval '24 hours') as median_delay
    from telegram_sources s where true ${one} order by s.created_at, s.id limit ${Math.min(Math.max(o.limit, 1), 200)}`);
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, identifier: w["channel_identifier"] as string, name: (w["display_name"] ?? null) as string | null, messages: Number(w["messages"]), messages24h: Number(w["messages_24h"]), claims: { claim: Number(w["claims_claim"]), ambiguous: Number(w["claims_ambiguous"]), unsupported: Number(w["claims_unsupported"]) }, candidates: (w["candidates"] ?? {}) as Record<string, number>, firstMessageAt: dn(w["first_at"]), lastMessageAt: dn(w["last_at"]), delayedShare24h: n(w["delayed_share"]), medianCaptureDelaySeconds24h: n(w["median_delay"]) }; });
}
export interface ClaimView { claimId: string; resultKind: string; parserVersion: string; claim: unknown; messageTimestamp: Date; receivedAt: Date; sourceId: string; captureMethod: string; classification: { signalType: string; horizon: string; setup: string; confidence: number | null; classifierVersion: string; structureValid: boolean } | null; candidacy: { policyVersion: string; outcome: string; reasons: string[]; candidateId: string | null; evaluatedAt: Date } | null; candidate: { id: string; state: string; version: number; expiresAt: Date; missingInformation: string[]; validationStatus: string } | null }
const claimSelect = sql`c.id as claim_id, c.result_kind, c.parser_version, c.claim, m.message_timestamp, m.received_at, m.telegram_source_id, m.capture_method,
  sc.signal_type, sc.horizon, sc.setup, sc.confidence::float8 as sc_conf, sc.classifier_version, sc.structure_valid,
  k.policy_version, k.outcome, k.reason_codes, k.candidate_id as k_candidate, k.evaluated_at,
  oc.id as cand_id, oc.state as cand_state, oc.candidate_version, oc.expires_at as cand_expires, oc.missing_information, oc.validation_status`;
const claimFrom = sql`from options_claims c join telegram_messages m on m.id = c.telegram_message_id
  left join lateral (select * from signal_classifications x where x.claim_id = c.id order by x.classified_at desc limit 1) sc on true
  left join lateral (select * from telegram_claim_candidacy y where y.claim_id = c.id order by y.evaluated_at desc limit 1) k on true
  left join opportunity_candidates oc on oc.claim_id = c.id`;
const claimOf = (w: Record<string, unknown>): ClaimView => ({
  claimId: w["claim_id"] as string, resultKind: w["result_kind"] as string, parserVersion: w["parser_version"] as string, claim: w["claim"] ?? null, messageTimestamp: d(w["message_timestamp"]), receivedAt: d(w["received_at"]), sourceId: w["telegram_source_id"] as string, captureMethod: w["capture_method"] as string,
  classification: w["signal_type"] ? { signalType: w["signal_type"] as string, horizon: w["horizon"] as string, setup: w["setup"] as string, confidence: w["sc_conf"] === null || w["sc_conf"] === undefined ? null : Number(w["sc_conf"]), classifierVersion: w["classifier_version"] as string, structureValid: w["structure_valid"] === true } : null,
  candidacy: w["outcome"] ? { policyVersion: w["policy_version"] as string, outcome: w["outcome"] as string, reasons: (w["reason_codes"] ?? []) as string[], candidateId: (w["k_candidate"] ?? null) as string | null, evaluatedAt: d(w["evaluated_at"]) } : null,
  candidate: w["cand_id"] ? { id: w["cand_id"] as string, state: w["cand_state"] as string, version: Number(w["candidate_version"]), expiresAt: d(w["cand_expires"]), missingInformation: (w["missing_information"] ?? []) as string[], validationStatus: w["validation_status"] as string } : null,
});
export async function listClaimViews(db: Pick<Db, "execute">, o: { sourceId?: string; kind?: string; limit: number }): Promise<ClaimView[]> {
  const src = o.sourceId ? sql`and m.telegram_source_id = ${o.sourceId}::uuid` : sql``, kind = o.kind ? sql`and c.result_kind = ${o.kind}` : sql``;
  const r = await db.execute(sql`select ${claimSelect} ${claimFrom} where true ${src} ${kind} order by m.message_timestamp desc, c.id limit ${Math.min(Math.max(o.limit, 1), 200)}`);
  return r.rows.map((q) => claimOf(row(q)));
}
export async function getClaimView(db: Pick<Db, "execute">, id: string): Promise<ClaimView | null> {
  const r = await db.execute(sql`select ${claimSelect} ${claimFrom} where c.id = ${id}::uuid`); return r.rows[0] ? claimOf(row(r.rows[0])) : null;
}
export interface TelegramCandidateRow { id: string; claimId: string; state: string; underlying: string; strike: number | null; optionType: string | null; expiry: string | null; side: string; entryKind: string; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; timeframe: string | null; setup: string | null; thesis: string | null; missingInformation: string[]; validationStatus: string; candidateVersion: number; dataSource: string; createdAt: Date; expiresAt: Date; stateReason: string | null; supersededBy: string | null; provenance: unknown }
export async function listTelegramCandidates(db: Pick<Db, "execute">, o: { states?: readonly string[]; limit: number }): Promise<TelegramCandidateRow[]> {
  const st = o.states?.length ? sql`and state in (${sql.join(o.states.map((s) => sql`${s}`), sql`, `)})` : sql``;
  const r = await db.execute(sql`select id, claim_id, state, underlying, strike::float8 as strike, option_type, expiry::text as expiry, side, entry_kind, entry_low::float8 as entry_low, entry_high::float8 as entry_high, stop_loss::float8 as stop_loss, targets, timeframe, setup, thesis, missing_information, validation_status, candidate_version, data_source, created_at, expires_at, state_reason, superseded_by, provenance from opportunity_candidates where source = 'TELEGRAM' ${st} order by created_at desc, id limit ${Math.min(Math.max(o.limit, 1), 200)}`);
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, claimId: w["claim_id"] as string, state: w["state"] as string, underlying: w["underlying"] as string, strike: n(w["strike"]), optionType: (w["option_type"] ?? null) as string | null, expiry: (w["expiry"] ?? null) as string | null, side: w["side"] as string, entryKind: w["entry_kind"] as string, entryLow: n(w["entry_low"]), entryHigh: n(w["entry_high"]), stopLoss: n(w["stop_loss"]), targets: ((w["targets"] ?? []) as unknown[]).map(Number), timeframe: (w["timeframe"] ?? null) as string | null, setup: (w["setup"] ?? null) as string | null, thesis: (w["thesis"] ?? null) as string | null, missingInformation: (w["missing_information"] ?? []) as string[], validationStatus: w["validation_status"] as string, candidateVersion: Number(w["candidate_version"]), dataSource: w["data_source"] as string, createdAt: d(w["created_at"]), expiresAt: d(w["expires_at"]), stateReason: (w["state_reason"] ?? null) as string | null, supersededBy: (w["superseded_by"] ?? null) as string | null, provenance: w["provenance"] }; });
}
